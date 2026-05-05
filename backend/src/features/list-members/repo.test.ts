import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { activeMembersOfList, activeMembership, membersSince } from './repo.ts';

let t: TestDatabase;

const SETUP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  t = await setupTestDatabase();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t.teardown();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
});

describe('list_members repo', () => {
  test('activeMembership returns the row when membership is active', async () => {
    const userId = '019470fd-2000-7000-8000-000000000001';
    const listId = '019470fd-2000-7000-8000-000000000002';

    await t.db.insert(users).values({
      id: userId,
      email: 'm@example.com',
      passwordHash: 'unused',
      displayName: 'M',
    });
    await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
    await t.db.insert(listMembers).values({ listId, userId, role: 'owner' });

    const row = await activeMembership(t.db, listId, userId);
    expect(row?.role).toBe('owner');
  });

  test('activeMembership returns undefined when membership is soft-deleted', async () => {
    // The auth gate must drop a removed member immediately on next request.
    const userId = '019470fd-2001-7000-8000-000000000001';
    const listId = '019470fd-2001-7000-8000-000000000002';

    await t.db.insert(users).values({
      id: userId,
      email: 'm2@example.com',
      passwordHash: 'unused',
      displayName: 'M2',
    });
    await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
    await t.db.insert(listMembers).values({
      listId,
      userId,
      role: 'editor',
      deletedAt: new Date(),
    });

    const row = await activeMembership(t.db, listId, userId);
    expect(row).toBeUndefined();
  });

  test('activeMembersOfList excludes soft-deleted members', async () => {
    const owner = '019470fd-2002-7000-8000-000000000001';
    const editor = '019470fd-2002-7000-8000-000000000002';
    const removed = '019470fd-2002-7000-8000-000000000003';
    const listId = '019470fd-2002-7000-8000-000000000004';

    await t.db.insert(users).values([
      { id: owner, email: 'o@example.com', passwordHash: 'x', displayName: 'O' },
      { id: editor, email: 'e@example.com', passwordHash: 'x', displayName: 'E' },
      { id: removed, email: 'r@example.com', passwordHash: 'x', displayName: 'R' },
    ]);
    await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: owner });
    await t.db.insert(listMembers).values([
      { listId, userId: owner, role: 'owner' },
      { listId, userId: editor, role: 'editor' },
      { listId, userId: removed, role: 'editor', deletedAt: new Date() },
    ]);

    const rows = await activeMembersOfList(t.db, listId);
    expect(rows.map((r) => r.userId).sort()).toEqual([owner, editor].sort());
  });

  test('email uniqueness is case-insensitive (functional unique index)', async () => {
    // Lives here only because list_members tests already seed users; the
    // assertion is about the users table's `lower(email)` unique index.
    // Putting it in a dedicated users repo file would mean a third
    // testcontainer for one assertion. Pragmatic placement.
    await t.db.insert(users).values({
      id: '019470fd-2003-7000-8000-000000000001',
      email: 'CaseSensitive@example.com',
      passwordHash: 'x',
      displayName: 'A',
    });

    // Wrap the insert in a thunk so `.rejects` can drive it. Drizzle's query
    // builder is a thenable but not a Promise object; passing the builder
    // directly to `expect().rejects` confuses Bun's matcher.
    const dup = async (): Promise<void> => {
      await t.db.insert(users).values({
        id: '019470fd-2003-7000-8000-000000000002',
        email: 'casesensitive@example.com',
        passwordHash: 'x',
        displayName: 'B',
      });
    };

    // The DB rejects with a unique-violation error; we only need to know that
    // it threw, not the exact error code (which is driver-specific).
    await expect(dup()).rejects.toThrow();
  });

  describe('membersSince (sync read)', () => {
    // The membership feed is the single most subtle endpoint in the protocol:
    // - it must surface the caller's OWN tombstoned membership (so they learn
    //   they were revoked from a list)
    // - it must surface OTHER members' rows for lists the caller is currently
    //   in (so the "who's in this list" view stays fresh)
    // - it must NOT leak other members' rows from lists the caller is not in
    //   (privacy)
    // - it must stop leaking other members' updates from a list once the
    //   caller is revoked (privacy after revocation)

    test('surfaces caller own tombstoned membership (revocation signal)', async () => {
      const owner = '019470fd-2100-7000-8000-000000000001';
      const guest = '019470fd-2100-7000-8000-000000000002';
      await t.db.insert(users).values([
        { id: owner, email: 'o3@example.com', passwordHash: 'x', displayName: 'O' },
        { id: guest, email: 'g3@example.com', passwordHash: 'x', displayName: 'G' },
      ]);
      const listId = '019470fd-2100-7000-8000-000000000003';
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: owner });
      await t.db.insert(listMembers).values([
        { listId, userId: owner, role: 'owner' },
        { listId, userId: guest, role: 'editor', deletedAt: new Date() },
      ]);

      const rows = await membersSince(t.db, guest, new Date(0));
      // The guest's own row, tombstoned, must come back. It's how the client
      // learns to drop the list locally.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(guest);
      expect(rows[0]?.deletedAt).not.toBeNull();
    });

    test('surfaces other members of lists where caller is active', async () => {
      const alice = '019470fd-2101-7000-8000-000000000001';
      const bob = '019470fd-2101-7000-8000-000000000002';
      const carol = '019470fd-2101-7000-8000-000000000003';
      await t.db.insert(users).values([
        { id: alice, email: 'a4@example.com', passwordHash: 'x', displayName: 'A' },
        { id: bob, email: 'b4@example.com', passwordHash: 'x', displayName: 'B' },
        { id: carol, email: 'c4@example.com', passwordHash: 'x', displayName: 'C' },
      ]);
      const shared = '019470fd-2101-7000-8000-000000000004';
      await t.db.insert(lists).values({ id: shared, name: 'shared', createdBy: alice });
      await t.db.insert(listMembers).values([
        { listId: shared, userId: alice, role: 'owner' },
        { listId: shared, userId: bob, role: 'editor' },
        { listId: shared, userId: carol, role: 'editor' },
      ]);

      const aliceRows = await membersSince(t.db, alice, new Date(0));
      // Alice should see all three rows in the shared list — her own (case 1),
      // bob's and carol's (case 2 — same active list).
      expect(aliceRows.map((r) => r.userId).sort()).toEqual([alice, bob, carol].sort());
    });

    test('does not leak other members from non-member lists', async () => {
      const outsider = '019470fd-2102-7000-8000-000000000001';
      const insiderA = '019470fd-2102-7000-8000-000000000002';
      const insiderB = '019470fd-2102-7000-8000-000000000003';
      await t.db.insert(users).values([
        { id: outsider, email: 'out@example.com', passwordHash: 'x', displayName: 'O' },
        { id: insiderA, email: 'inA@example.com', passwordHash: 'x', displayName: 'IA' },
        { id: insiderB, email: 'inB@example.com', passwordHash: 'x', displayName: 'IB' },
      ]);
      // Outsider has nothing in the system. Insiders share a list.
      const insiderList = '019470fd-2102-7000-8000-000000000004';
      await t.db.insert(lists).values({ id: insiderList, name: 'private', createdBy: insiderA });
      await t.db.insert(listMembers).values([
        { listId: insiderList, userId: insiderA, role: 'owner' },
        { listId: insiderList, userId: insiderB, role: 'editor' },
      ]);

      const rows = await membersSince(t.db, outsider, new Date(0));
      // Outsider sees nothing — neither their own (none exist) nor others'.
      expect(rows).toEqual([]);
    });

    test('after revocation the caller stops seeing other members updates', async () => {
      // Sequence: guest is active → guest sees both rows. Guest is revoked
      // → on the next pull guest sees only their own (now-tombstoned) row,
      // not subsequent edits to the owner's role or any new members joining.
      const owner = '019470fd-2103-7000-8000-000000000001';
      const guest = '019470fd-2103-7000-8000-000000000002';
      const newcomer = '019470fd-2103-7000-8000-000000000003';
      await t.db.insert(users).values([
        { id: owner, email: 'o5@example.com', passwordHash: 'x', displayName: 'O' },
        { id: guest, email: 'g5@example.com', passwordHash: 'x', displayName: 'G' },
        { id: newcomer, email: 'n@example.com', passwordHash: 'x', displayName: 'N' },
      ]);
      const listId = '019470fd-2103-7000-8000-000000000004';
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: owner });
      // Guest already revoked at fixture time.
      await t.db.insert(listMembers).values([
        { listId, userId: owner, role: 'owner' },
        { listId, userId: guest, role: 'editor', deletedAt: new Date() },
        // Newcomer joins AFTER guest's revocation — guest must not see this.
        { listId, userId: newcomer, role: 'editor' },
      ]);

      const rows = await membersSince(t.db, guest, new Date(0));
      // Guest sees only their own tombstoned row.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(guest);
    });
  });
});
