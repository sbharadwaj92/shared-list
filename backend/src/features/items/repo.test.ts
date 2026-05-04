import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { items, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { activeItems, findActiveItemById } from './repo.ts';

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

const seedListAndUser = async (): Promise<{ userId: string; listId: string }> => {
  const userId = '019470fd-1000-7000-8000-000000000001';
  const listId = '019470fd-1000-7000-8000-000000000002';
  await t.db.insert(users).values({
    id: userId,
    email: 'owner@example.com',
    passwordHash: 'unused',
    displayName: 'Owner',
  });
  await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
  return { userId, listId };
};

describe('items repo', () => {
  test('activeItems returns non-deleted items in ascending position order', async () => {
    const { userId, listId } = await seedListAndUser();

    // Insert in reverse position order to make sure the ORDER BY is what's
    // sorting them, not insertion order.
    await t.db.insert(items).values([
      {
        id: '019470fd-1000-7000-8000-000000000010',
        listId,
        text: 'third',
        position: 30,
        createdBy: userId,
      },
      {
        id: '019470fd-1000-7000-8000-000000000011',
        listId,
        text: 'second',
        position: 20,
        createdBy: userId,
      },
      {
        id: '019470fd-1000-7000-8000-000000000012',
        listId,
        text: 'first',
        position: 10,
        createdBy: userId,
      },
      {
        id: '019470fd-1000-7000-8000-000000000013',
        listId,
        text: 'gone',
        position: 5,
        createdBy: userId,
        deletedAt: new Date(),
      },
    ]);

    const rows = await activeItems(t.db, listId);
    // Both the soft-delete filter AND the sort are exercised by checking the
    // exact text sequence — if either fails, the assertion fails.
    expect(rows.map((r) => r.text)).toEqual(['first', 'second', 'third']);
  });

  test('findActiveItemById returns undefined for a soft-deleted item', async () => {
    const { userId, listId } = await seedListAndUser();
    const id = '019470fd-1001-7000-8000-000000000001';

    await t.db.insert(items).values({
      id,
      listId,
      text: 'gone',
      position: 1,
      createdBy: userId,
      deletedAt: new Date(),
    });

    const row = await findActiveItemById(t.db, id);
    expect(row).toBeUndefined();
  });

  test('cascade FK: deleting a list (hard delete) removes its items', async () => {
    // We don't expect application code to ever hard-delete lists — the API
    // soft-deletes — but the FK ON DELETE CASCADE is still important as a
    // safety net for the eventual 90-day purge job. Testing it documents the
    // contract and catches a regression if someone changes the FK to RESTRICT.
    const { userId, listId } = await seedListAndUser();

    await t.db.insert(items).values({
      id: '019470fd-1002-7000-8000-000000000001',
      listId,
      text: 'a',
      position: 1,
      createdBy: userId,
    });

    await t.db.execute(sql`DELETE FROM lists WHERE id = ${listId}`);
    const remaining = await t.db.select().from(items);
    expect(remaining).toHaveLength(0);
  });
});
