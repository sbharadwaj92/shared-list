import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { items, listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { signAccessToken } from '../auth/tokens.ts';

// HTTP-level integration test for the `?since=` sync feed.
//
// Distinct from the repo-level tests in `lists/repo.test.ts` etc.: those lock
// down the SQL behavior; this file pins the wire contract — status codes,
// JSON shape, the `serverTime` echo, the auth gate, the Zod validation
// failure path. A real client (iOS sync engine in slice B) will see exactly
// what these assertions assert.
//
// We use signed JWTs from the real `signAccessToken` helper rather than
// mocking the auth middleware. The middleware is part of what's under test —
// "GET /sync/lists requires a valid bearer token" is a contract the client
// is going to depend on.

let t: TestDatabase;
let app: ReturnType<typeof buildApp>;

const SETUP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  t = await setupTestDatabase();
  app = buildApp(t.db, { auth: { enableRateLimits: false } });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t.teardown();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
});

// Helper to seed a user and produce a real bearer token. We don't go through
// `/auth/signup` because the password-hash work would dominate test runtime
// and the routes aren't what we're testing here.
const seedUserWithToken = async (id: string, email: string): Promise<string> => {
  await t.db.insert(users).values({
    id,
    email,
    passwordHash: 'unused-in-this-test',
    displayName: 'T',
  });
  return signAccessToken(id);
};

type SyncResponse<T> = { serverTime: string; rows: T[] };

const isSyncResponse = (b: unknown): b is SyncResponse<Record<string, unknown>> => {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return typeof o.serverTime === 'string' && Array.isArray(o.rows);
};

describe('sync integration (HTTP)', () => {
  describe('auth + validation', () => {
    test('GET /sync/lists without Authorization returns 401', async () => {
      const res = await app.request('/sync/lists');
      expect(res.status).toBe(401);
    });

    test('GET /sync/lists with malformed `since` returns 400 in the central envelope', async () => {
      const userId = '019470fd-7000-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'v1@example.com');

      const res = await app.request('/sync/lists?since=not-a-date', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      expect(body.error.code).toBe('validation_error');
      // The Zod message bubbles up via the validation hook — must mention the
      // offending field so a client can correct it programmatically.
      expect(body.error.message.toLowerCase()).toContain('since');
    });

    test('omitted `since` defaults to epoch (returns everything)', async () => {
      const userId = '019470fd-7001-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'v2@example.com');
      const listId = '019470fd-7001-7000-8000-000000000002';
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
      await t.db.insert(listMembers).values({ listId, userId, role: 'owner' });

      const res = await app.request('/sync/lists', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(isSyncResponse(body)).toBe(true);
      if (isSyncResponse(body)) {
        expect(body.rows).toHaveLength(1);
        const row = body.rows[0] as { id: string };
        expect(row.id).toBe(listId);
      }
    });
  });

  describe('GET /sync/lists wire shape', () => {
    test('returns active rows AND tombstones for member lists', async () => {
      const userId = '019470fd-7100-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'l1@example.com');

      const liveId = '019470fd-7100-7000-8000-000000000002';
      const goneId = '019470fd-7100-7000-8000-000000000003';
      await t.db.insert(lists).values([
        { id: liveId, name: 'live', createdBy: userId },
        { id: goneId, name: 'gone', createdBy: userId, deletedAt: new Date() },
      ]);
      await t.db.insert(listMembers).values([
        { listId: liveId, userId, role: 'owner' },
        { listId: goneId, userId, role: 'owner' },
      ]);

      const res = await app.request('/sync/lists?since=1970-01-01T00:00:00.000Z', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncResponse<{
        id: string;
        deletedAt: string | null;
      }>;
      expect(body.rows).toHaveLength(2);

      // Verify the tombstone is recognizable on the wire — `deletedAt` is
      // string (not null) for the deleted row. Clients use this exact field
      // to drop the local copy.
      const tombstone = body.rows.find((r) => r.id === goneId);
      expect(tombstone).toBeDefined();
      expect(tombstone?.deletedAt).not.toBeNull();
      expect(typeof tombstone?.deletedAt).toBe('string');
    });

    test('serverTime round-trip works as a cursor (no row repeated)', async () => {
      // The cursor invariant: pull twice, second pull with the first's
      // serverTime as `since`, and rows from pull #1 must NOT reappear in
      // pull #2 unless they were touched in between. This is the contract
      // the iOS sync engine is going to lean on.
      const userId = '019470fd-7101-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'l2@example.com');
      const listA = '019470fd-7101-7000-8000-000000000002';
      await t.db.insert(lists).values({ id: listA, name: 'A', createdBy: userId });
      await t.db.insert(listMembers).values({ listId: listA, userId, role: 'owner' });

      // Pull #1 — get everything from epoch.
      const res1 = await app.request('/sync/lists', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as SyncResponse<{ id: string }>;
      expect(body1.rows).toHaveLength(1);
      const cursor = body1.serverTime;

      // Pull #2 — same data, no writes in between. The cursor invariant
      // says the second pull must be empty: nothing has been touched after
      // serverTime.
      const res2 = await app.request(`/sync/lists?since=${encodeURIComponent(cursor)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as SyncResponse<{ id: string }>;
      expect(body2.rows).toEqual([]);
    });

    test('serverTime advances after a write; the new row surfaces on next pull', async () => {
      const userId = '019470fd-7102-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'l3@example.com');

      // Pull #1 with no data.
      const res1 = await app.request('/sync/lists', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body1 = (await res1.json()) as SyncResponse<{ id: string }>;
      expect(body1.rows).toEqual([]);

      // Wait long enough that the write's `updated_at` strictly exceeds
      // body1.serverTime even at millisecond precision (the trigger
      // truncation gave us 1ms resolution). Without the wait, the test
      // races against same-millisecond timestamps.
      await new Promise((r) => setTimeout(r, 5));

      // Write between pulls.
      const listId = '019470fd-7102-7000-8000-000000000002';
      await t.db.insert(lists).values({ id: listId, name: 'new', createdBy: userId });
      await t.db.insert(listMembers).values({ listId, userId, role: 'owner' });

      // Pull #2 with body1.serverTime as cursor — must surface the new row.
      const res2 = await app.request(`/sync/lists?since=${encodeURIComponent(body1.serverTime)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body2 = (await res2.json()) as SyncResponse<{ id: string }>;
      expect(body2.rows.map((r) => r.id)).toEqual([listId]);
      // serverTime advances monotonically across pulls.
      expect(new Date(body2.serverTime).getTime()).toBeGreaterThan(
        new Date(body1.serverTime).getTime(),
      );
    });

    test('does not leak lists from non-member users', async () => {
      const alice = '019470fd-7103-7000-8000-000000000001';
      const bob = '019470fd-7103-7000-8000-000000000002';
      const aliceToken = await seedUserWithToken(alice, 'a3@example.com');
      await seedUserWithToken(bob, 'b3@example.com');

      const bobList = '019470fd-7103-7000-8000-000000000003';
      await t.db.insert(lists).values({ id: bobList, name: 'bob list', createdBy: bob });
      await t.db.insert(listMembers).values({ listId: bobList, userId: bob, role: 'owner' });

      // Alice asks for everything; she has no memberships, must see nothing.
      const res = await app.request('/sync/lists', {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      const body = (await res.json()) as SyncResponse<{ id: string }>;
      expect(body.rows).toEqual([]);
    });
  });

  describe('GET /sync/items wire shape', () => {
    test('returns items including tombstones, scoped by membership', async () => {
      const userId = '019470fd-7200-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'i1@example.com');
      const listId = '019470fd-7200-7000-8000-000000000002';
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
      await t.db.insert(listMembers).values({ listId, userId, role: 'owner' });
      await t.db.insert(items).values([
        {
          id: '019470fd-7200-7000-8000-000000000010',
          listId,
          text: 'live',
          position: 1,
          createdBy: userId,
        },
        {
          id: '019470fd-7200-7000-8000-000000000011',
          listId,
          text: 'gone',
          position: 2,
          createdBy: userId,
          deletedAt: new Date(),
        },
      ]);

      const res = await app.request('/sync/items', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncResponse<{
        id: string;
        text: string;
        deletedAt: string | null;
        checked: string | null;
      }>;
      expect(body.rows).toHaveLength(2);
      // `checked` is null on a never-checked item — the wire shape preserves
      // null (rather than omitting the field) so client deserializers can
      // distinguish "field present, null" from "field absent" cleanly.
      const liveRow = body.rows.find((r) => r.text === 'live');
      expect(liveRow?.checked).toBeNull();
    });
  });

  describe('GET /sync/list_members wire shape', () => {
    test('caller sees their own tombstoned membership (revocation signal)', async () => {
      const owner = '019470fd-7300-7000-8000-000000000001';
      const guest = '019470fd-7300-7000-8000-000000000002';
      const guestToken = await seedUserWithToken(guest, 'g4@example.com');
      await t.db.insert(users).values({
        id: owner,
        email: 'o4@example.com',
        passwordHash: 'x',
        displayName: 'O',
      });
      const listId = '019470fd-7300-7000-8000-000000000003';
      await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: owner });
      await t.db.insert(listMembers).values([
        { listId, userId: owner, role: 'owner' },
        { listId, userId: guest, role: 'editor', deletedAt: new Date() },
      ]);

      const res = await app.request('/sync/list_members', {
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncResponse<{
        userId: string;
        role: string;
        deletedAt: string | null;
      }>;
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]?.userId).toBe(guest);
      expect(body.rows[0]?.deletedAt).not.toBeNull();
    });
  });
});
