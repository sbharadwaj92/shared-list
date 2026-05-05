import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { activeLists, findActiveListById, listsSince } from './repo.ts';

// One Postgres container for this entire file (boot is ~3-5s, so per-test would
// be wasteful). Each test gets a clean slate via `TRUNCATE ... CASCADE` in
// `beforeEach` — fast (millisecond-scale) and resets serial sequences too.
//
// Container reuse + per-test truncate is the standard testcontainers pattern:
// it gets you isolation between tests without paying container-boot cost
// dozens of times.

let t: TestDatabase;

// 60s — container boot includes a Postgres readiness wait that routinely
// exceeds Bun's default 5s hook timeout, even on a warm image cache. Picked
// a generous ceiling so a slightly slow Docker daemon doesn't flake CI.
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  t = await setupTestDatabase();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t.teardown();
}, SETUP_TIMEOUT_MS);

// `TRUNCATE ... CASCADE RESTART IDENTITY` clears every table the repo touches,
// follows FK chains down to children, and resets any sequences. We list the
// roots (`users`) and CASCADE handles the dependents (`lists`, `items`, etc.).
beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
});

const seedUser = async (id: string, email: string): Promise<void> => {
  await t.db.insert(users).values({
    id,
    email,
    passwordHash: 'unused-in-this-test',
    displayName: 'Test User',
  });
};

describe('lists repo', () => {
  test('activeLists returns only non-deleted rows', async () => {
    // Static UUIDv7-shaped IDs keep the test deterministic without needing
    // Bun.randomUUIDv7() in the test (we want the test to fail if a real ID
    // generator regresses; we don't want test flakiness from random IDs).
    const userId = '019470fd-0001-7000-8000-000000000001';
    await seedUser(userId, 'a@example.com');

    const liveId = '019470fd-0001-7000-8000-000000000002';
    const deletedId = '019470fd-0001-7000-8000-000000000003';

    await t.db.insert(lists).values([
      { id: liveId, name: 'live list', createdBy: userId },
      { id: deletedId, name: 'deleted list', createdBy: userId, deletedAt: new Date() },
    ]);

    const rows = await activeLists(t.db);
    expect(rows.map((r) => r.id)).toEqual([liveId]);
  });

  test('findActiveListById returns undefined for a soft-deleted list', async () => {
    const userId = '019470fd-0002-7000-8000-000000000001';
    await seedUser(userId, 'b@example.com');

    const id = '019470fd-0002-7000-8000-000000000002';
    await t.db.insert(lists).values({
      id,
      name: 'gone',
      createdBy: userId,
      deletedAt: new Date(),
    });

    const row = await findActiveListById(t.db, id);
    expect(row).toBeUndefined();
  });

  test('updated_at trigger bumps timestamp on UPDATE', async () => {
    // The trigger is the load-bearing piece that the sync engine's LWW
    // semantics depend on. A regression here would silently break `?since=`
    // filtering; testing it once at the schema level is cheap insurance.
    const userId = '019470fd-0003-7000-8000-000000000001';
    await seedUser(userId, 'c@example.com');

    const id = '019470fd-0003-7000-8000-000000000002';
    await t.db.insert(lists).values({ id, name: 'first', createdBy: userId });
    const [before] = await t.db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!before) throw new Error('expected seeded list to exist');

    // Without the sleep, `now()` can return the same microsecond between the
    // INSERT and the UPDATE on a fast machine, which would make the assertion
    // ambiguous (equal timestamps don't prove the trigger fired). 5ms is well
    // above clock granularity.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await t.db.update(lists).set({ name: 'renamed' }).where(eq(lists.id, id));
    const [after] = await t.db.select().from(lists).where(eq(lists.id, id)).limit(1);
    if (!after) throw new Error('list disappeared after update');

    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  describe('listsSince (sync read)', () => {
    // The Phase 7 read side: clients call this on every reconnect to learn
    // about lists that changed (or were tombstoned) since their last pull.
    // The contract this test suite locks down:
    //   1. tombstones flow (rows with deleted_at NOT NULL must appear)
    //   2. membership scoping is current-active-only (revoked users stop
    //      seeing further updates immediately)
    //   3. timestamp filtering uses strict greater-than (a row with
    //      updated_at == since must NOT appear — clients pass back the
    //      max timestamp they saw, so equality would mean re-streaming)
    //   4. cross-user privacy: A's call never reveals B's lists

    test('returns active and tombstoned rows for member; excludes other users lists', async () => {
      const alice = '019470fd-1100-7000-8000-000000000001';
      const bob = '019470fd-1100-7000-8000-000000000002';
      await t.db.insert(users).values([
        { id: alice, email: 'a@example.com', passwordHash: 'x', displayName: 'A' },
        { id: bob, email: 'b@example.com', passwordHash: 'x', displayName: 'B' },
      ]);

      const aliceListLive = '019470fd-1100-7000-8000-000000000003';
      const aliceListGone = '019470fd-1100-7000-8000-000000000004';
      const bobListLive = '019470fd-1100-7000-8000-000000000005';

      await t.db.insert(lists).values([
        { id: aliceListLive, name: 'alice live', createdBy: alice },
        { id: aliceListGone, name: 'alice gone', createdBy: alice, deletedAt: new Date() },
        { id: bobListLive, name: 'bob live', createdBy: bob },
      ]);
      await t.db.insert(listMembers).values([
        { listId: aliceListLive, userId: alice, role: 'owner' },
        { listId: aliceListGone, userId: alice, role: 'owner' },
        { listId: bobListLive, userId: bob, role: 'owner' },
      ]);

      // since=epoch ⇒ "give me everything"
      const rows = await listsSince(t.db, alice, new Date(0));
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([aliceListLive, aliceListGone].sort());
      // Tombstone shape: client checks `deleted_at !== null` to drop locally.
      const tombstone = rows.find((r) => r.id === aliceListGone);
      expect(tombstone?.deletedAt).not.toBeNull();
    });

    test('respects since cutoff with strict greater-than (equality excluded)', async () => {
      // The since cursor is the max(updated_at) the client has already seen.
      // If we used >= we'd re-stream that exact row every pull — wasted bytes
      // and a churn source for the client's reconciler. >= must be wrong.
      const userId = '019470fd-1101-7000-8000-000000000001';
      await t.db.insert(users).values({
        id: userId,
        email: 'cursor@example.com',
        passwordHash: 'x',
        displayName: 'C',
      });

      const before = '019470fd-1101-7000-8000-000000000002';
      const after = '019470fd-1101-7000-8000-000000000003';
      await t.db.insert(lists).values({ id: before, name: 'before', createdBy: userId });
      await t.db.insert(listMembers).values({ listId: before, userId, role: 'owner' });

      // Read back the timestamp that the trigger stamped — the test must use
      // the actual DB timestamp, not Date.now() from the JS clock (those drift).
      const [seeded] = await t.db.select().from(lists).where(eq(lists.id, before)).limit(1);
      if (!seeded) throw new Error('expected seeded list');
      const cursor = seeded.updatedAt;

      // 5ms gap so the trigger stamps a strictly later updated_at on the
      // second insert (matches the rationale in the trigger test above).
      await new Promise((r) => setTimeout(r, 5));
      await t.db.insert(lists).values({ id: after, name: 'after', createdBy: userId });
      await t.db.insert(listMembers).values({ listId: after, userId, role: 'owner' });

      const rows = await listsSince(t.db, userId, cursor);
      expect(rows.map((r) => r.id)).toEqual([after]);
    });

    test('revoked member stops seeing further list updates after revocation', async () => {
      // Privacy invariant: once a user's list_members row is soft-deleted,
      // they get no further mutations on that list. They learn about the
      // revocation itself from the membership feed.
      const owner = '019470fd-1102-7000-8000-000000000001';
      const guest = '019470fd-1102-7000-8000-000000000002';
      await t.db.insert(users).values([
        { id: owner, email: 'o@example.com', passwordHash: 'x', displayName: 'O' },
        { id: guest, email: 'g@example.com', passwordHash: 'x', displayName: 'G' },
      ]);

      const listId = '019470fd-1102-7000-8000-000000000003';
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: owner });
      await t.db.insert(listMembers).values([
        { listId, userId: owner, role: 'owner' },
        // Guest's membership is already soft-deleted before any query.
        { listId, userId: guest, role: 'editor', deletedAt: new Date() },
      ]);

      const rows = await listsSince(t.db, guest, new Date(0));
      // Guest sees nothing on the lists feed — list state belongs to current
      // members only. Revocation itself flows via the members feed.
      expect(rows).toEqual([]);
    });
  });
});
