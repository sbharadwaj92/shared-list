import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { items, listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { activeItems, findActiveItemById, itemsSince } from './repo.ts';

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

  describe('itemsSince (sync read)', () => {
    // Items mirror the contract `listsSince` locks down: tombstones flow,
    // membership scoping is current-active-only, strict-greater-than on the
    // since cursor, cross-list/cross-user privacy. Item-specific wrinkle:
    // multiple lists per user, each with its own membership state.

    test('returns active and tombstoned items across all member lists', async () => {
      const userId = '019470fd-1200-7000-8000-000000000001';
      const listA = '019470fd-1200-7000-8000-000000000002';
      const listB = '019470fd-1200-7000-8000-000000000003';
      await t.db.insert(users).values({
        id: userId,
        email: 'multi@example.com',
        passwordHash: 'x',
        displayName: 'M',
      });
      await t.db.insert(lists).values([
        { id: listA, name: 'A', createdBy: userId },
        { id: listB, name: 'B', createdBy: userId },
      ]);
      await t.db.insert(listMembers).values([
        { listId: listA, userId, role: 'owner' },
        { listId: listB, userId, role: 'owner' },
      ]);

      const liveA = '019470fd-1200-7000-8000-000000000010';
      const goneA = '019470fd-1200-7000-8000-000000000011';
      const liveB = '019470fd-1200-7000-8000-000000000012';
      await t.db.insert(items).values([
        { id: liveA, listId: listA, text: 'a-live', position: 1, createdBy: userId },
        {
          id: goneA,
          listId: listA,
          text: 'a-gone',
          position: 2,
          createdBy: userId,
          deletedAt: new Date(),
        },
        { id: liveB, listId: listB, text: 'b-live', position: 1, createdBy: userId },
      ]);

      const rows = await itemsSince(t.db, userId, new Date(0));
      expect(rows.map((r) => r.id).sort()).toEqual([liveA, goneA, liveB].sort());
    });

    test('does not leak items from non-member lists', async () => {
      const alice = '019470fd-1201-7000-8000-000000000001';
      const bob = '019470fd-1201-7000-8000-000000000002';
      const aliceList = '019470fd-1201-7000-8000-000000000003';
      const bobList = '019470fd-1201-7000-8000-000000000004';

      await t.db.insert(users).values([
        { id: alice, email: 'a2@example.com', passwordHash: 'x', displayName: 'A' },
        { id: bob, email: 'b2@example.com', passwordHash: 'x', displayName: 'B' },
      ]);
      await t.db.insert(lists).values([
        { id: aliceList, name: 'A', createdBy: alice },
        { id: bobList, name: 'B', createdBy: bob },
      ]);
      await t.db.insert(listMembers).values([
        { listId: aliceList, userId: alice, role: 'owner' },
        { listId: bobList, userId: bob, role: 'owner' },
      ]);
      await t.db.insert(items).values([
        {
          id: '019470fd-1201-7000-8000-000000000010',
          listId: aliceList,
          text: 'alice secret',
          position: 1,
          createdBy: alice,
        },
        {
          id: '019470fd-1201-7000-8000-000000000011',
          listId: bobList,
          text: 'bob secret',
          position: 1,
          createdBy: bob,
        },
      ]);

      const aliceRows = await itemsSince(t.db, alice, new Date(0));
      expect(aliceRows.map((r) => r.text)).toEqual(['alice secret']);

      const bobRows = await itemsSince(t.db, bob, new Date(0));
      expect(bobRows.map((r) => r.text)).toEqual(['bob secret']);
    });

    test('respects since cutoff with strict greater-than (equality excluded)', async () => {
      const userId = '019470fd-1202-7000-8000-000000000001';
      const listId = '019470fd-1202-7000-8000-000000000002';
      await t.db.insert(users).values({
        id: userId,
        email: 'cur@example.com',
        passwordHash: 'x',
        displayName: 'C',
      });
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
      await t.db.insert(listMembers).values({ listId, userId, role: 'owner' });

      const before = '019470fd-1202-7000-8000-000000000010';
      await t.db.insert(items).values({
        id: before,
        listId,
        text: 'before',
        position: 1,
        createdBy: userId,
      });
      const [seeded] = await t.db.select().from(items).where(eq(items.id, before)).limit(1);
      if (!seeded) throw new Error('expected seeded item');
      const cursor = seeded.updatedAt;

      await new Promise((r) => setTimeout(r, 5));
      const after = '019470fd-1202-7000-8000-000000000011';
      await t.db.insert(items).values({
        id: after,
        listId,
        text: 'after',
        position: 2,
        createdBy: userId,
      });

      const rows = await itemsSince(t.db, userId, cursor);
      expect(rows.map((r) => r.id)).toEqual([after]);
    });
  });
});
