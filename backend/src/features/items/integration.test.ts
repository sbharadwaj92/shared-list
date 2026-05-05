import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { items, listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { signAccessToken } from '../auth/tokens.ts';

// HTTP integration tests for the items write endpoints (Phase 7 slice C.1).
//
// Mirrors lists/integration.test.ts. The contract:
//   - POST /lists/:id/items is idempotent on the client-supplied id
//   - PATCH /items/:id requires If-Match and returns 409 with the latest row
//   - DELETE /items/:id soft-deletes only when the caller is a member of
//     the parent list
//   - cross-user attempts hit 403 (never 404)

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

const seedUserWithToken = async (id: string, email: string): Promise<string> => {
  await t.db.insert(users).values({
    id,
    email,
    passwordHash: 'unused',
    displayName: 'T',
  });
  return signAccessToken(id);
};

// Helper: create user + list + membership in one shot. Used by every test
// since items always live under a parent list with the caller as a member.
const seedUserAndOwnedList = async (
  userId: string,
  listId: string,
  email: string,
): Promise<string> => {
  const token = await seedUserWithToken(userId, email);
  await t.db.insert(lists).values({ id: listId, name: 'L', createdBy: userId });
  await t.db.insert(listMembers).values({ listId, userId, role: 'owner' });
  return token;
};

type ItemBody = {
  id: string;
  listId: string;
  text: string;
  checked: string | null;
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

const isItemBody = (b: unknown): b is ItemBody => {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.listId === 'string' &&
    typeof o.text === 'string' &&
    typeof o.position === 'number' &&
    typeof o.updatedAt === 'string'
  );
};

describe('items write integration (HTTP)', () => {
  describe('POST /lists/:id/items', () => {
    test('creates an item under a list the caller is a member of', async () => {
      const userId = '019470fd-d100-7000-8000-000000000001';
      const listId = '019470fd-d100-7000-8000-000000000002';
      const itemId = '019470fd-d100-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'a@example.com');

      const res = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 'milk', position: 1000 }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(isItemBody(body)).toBe(true);
      expect(body.id).toBe(itemId);
      expect(body.listId).toBe(listId);
      expect(body.text).toBe('milk');
      expect(body.position).toBe(1000);
      // Newly-created items are unchecked: `checked` is null on the wire,
      // not omitted (so client deserializers can map directly to a nullable
      // field without branching on key presence).
      expect(body.checked).toBeNull();
    });

    test('idempotent retry returns the existing row at 200', async () => {
      const userId = '019470fd-d101-7000-8000-000000000001';
      const listId = '019470fd-d101-7000-8000-000000000002';
      const itemId = '019470fd-d101-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'b@example.com');

      const first = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 'first', position: 1 }),
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as ItemBody;

      // Retry with different text/position — the canonical row stays the
      // original. Idempotent POST is "did this happen" not "upsert this".
      const retry = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 'retry-text', position: 999 }),
      });
      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as ItemBody;
      expect(retryBody.text).toBe('first');
      expect(retryBody.position).toBe(1);
      expect(retryBody.updatedAt).toBe(firstBody.updatedAt);
    });

    test('non-member returns 403', async () => {
      const owner = '019470fd-d102-7000-8000-000000000001';
      const outsider = '019470fd-d102-7000-8000-000000000002';
      const listId = '019470fd-d102-7000-8000-000000000003';
      await seedUserAndOwnedList(owner, listId, 'o@example.com');
      const outsiderToken = await seedUserWithToken(outsider, 'x@example.com');

      const res = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${outsiderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: '019470fd-d102-7000-8000-000000000004',
          text: 'sneaky',
          position: 1,
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /items/:id', () => {
    test('updates text + position when If-Match matches', async () => {
      const userId = '019470fd-d200-7000-8000-000000000001';
      const listId = '019470fd-d200-7000-8000-000000000002';
      const itemId = '019470fd-d200-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'c@example.com');

      const created = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 'before', position: 1 }),
      });
      const createdBody = (await created.json()) as ItemBody;

      const res = await app.request(`/items/${itemId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ text: 'after', position: 2 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.text).toBe('after');
      expect(body.position).toBe(2);
      expect(body.checked).toBeNull();
    });

    test('checking an item sets `checked` to a timestamp', async () => {
      const userId = '019470fd-d201-7000-8000-000000000001';
      const listId = '019470fd-d201-7000-8000-000000000002';
      const itemId = '019470fd-d201-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'ch@example.com');

      const created = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 'milk', position: 1 }),
      });
      const createdBody = (await created.json()) as ItemBody;

      const checkAt = new Date().toISOString();
      const res = await app.request(`/items/${itemId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ checked: checkAt }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      // The wire shape preserves the timestamp the client sent (modulo
      // millisecond precision matching the trigger). `checked != null` is
      // the boolean "is this checked?" question.
      expect(body.checked).not.toBeNull();
      expect(typeof body.checked).toBe('string');
    });

    test('409 with latest row when If-Match is stale', async () => {
      const userId = '019470fd-d202-7000-8000-000000000001';
      const listId = '019470fd-d202-7000-8000-000000000002';
      const itemId = '019470fd-d202-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'd@example.com');

      const created = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 'v1', position: 1 }),
      });
      const createdBody = (await created.json()) as ItemBody;

      await new Promise((r) => setTimeout(r, 5));

      const ok = await app.request(`/items/${itemId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ text: 'v2' }),
      });
      expect(ok.status).toBe(200);

      const conflict = await app.request(`/items/${itemId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ text: 'v3-attempt' }),
      });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as {
        error: { code: string };
        latest: ItemBody;
      };
      expect(body.error.code).toBe('precondition_failed');
      expect(body.latest.text).toBe('v2');
    });

    test('cross-user PATCH returns 403', async () => {
      const owner = '019470fd-d203-7000-8000-000000000001';
      const outsider = '019470fd-d203-7000-8000-000000000002';
      const listId = '019470fd-d203-7000-8000-000000000003';
      const itemId = '019470fd-d203-7000-8000-000000000004';
      const ownerToken = await seedUserAndOwnedList(owner, listId, 'oo@example.com');
      const outsiderToken = await seedUserWithToken(outsider, 'oz@example.com');

      const created = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: itemId, text: 't', position: 1 }),
      });
      const createdBody = (await created.json()) as ItemBody;

      const res = await app.request(`/items/${itemId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${outsiderToken}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ text: 'tampered' }),
      });
      expect(res.status).toBe(403);
    });

    test('PATCH against a non-existent item returns 404', async () => {
      const userId = '019470fd-d204-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'm@example.com');
      const ghostId = '019470fd-d204-7000-8000-0000000000ff';

      const res = await app.request(`/items/${ghostId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': new Date().toISOString(),
        },
        body: JSON.stringify({ text: 'x' }),
      });
      expect(res.status).toBe(404);
    });

    test('PATCH with empty body returns 400', async () => {
      const userId = '019470fd-d205-7000-8000-000000000001';
      const listId = '019470fd-d205-7000-8000-000000000002';
      const itemId = '019470fd-d205-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'eb@example.com');
      const created = await app.request(`/lists/${listId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, text: 't', position: 1 }),
      });
      const createdBody = (await created.json()) as ItemBody;

      const res = await app.request(`/items/${itemId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /items/:id', () => {
    test('member soft-deletes a single item', async () => {
      const userId = '019470fd-d300-7000-8000-000000000001';
      const listId = '019470fd-d300-7000-8000-000000000002';
      const itemId = '019470fd-d300-7000-8000-000000000003';
      const token = await seedUserAndOwnedList(userId, listId, 'g@example.com');
      await t.db.insert(items).values({
        id: itemId,
        listId,
        text: 'doomed',
        position: 1,
        createdBy: userId,
      });

      const res = await app.request(`/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(204);
      const [row] = await t.db.select().from(items).where(eq(items.id, itemId)).limit(1);
      expect(row?.deletedAt).not.toBeNull();
    });

    test('cross-user DELETE returns 403', async () => {
      const owner = '019470fd-d301-7000-8000-000000000001';
      const outsider = '019470fd-d301-7000-8000-000000000002';
      const listId = '019470fd-d301-7000-8000-000000000003';
      const itemId = '019470fd-d301-7000-8000-000000000004';
      await seedUserAndOwnedList(owner, listId, 'oo2@example.com');
      const outsiderToken = await seedUserWithToken(outsider, 'oz2@example.com');
      await t.db.insert(items).values({
        id: itemId,
        listId,
        text: 't',
        position: 1,
        createdBy: owner,
      });

      const res = await app.request(`/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${outsiderToken}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
