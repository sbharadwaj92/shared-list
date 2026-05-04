import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { activeLists, findActiveListById } from './repo.ts';

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
});
