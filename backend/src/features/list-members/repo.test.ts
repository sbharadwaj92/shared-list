import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { activeMembersOfList, activeMembership } from './repo.ts';

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
});
