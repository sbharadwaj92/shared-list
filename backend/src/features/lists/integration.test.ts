import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { items, listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { signAccessToken } from '../auth/tokens.ts';

// HTTP integration tests for the lists write endpoints (Phase 7 slice C.1).
//
// What's locked down here is the wire contract iOS slice C will build the
// mutation queue against:
//   - POST /lists is idempotent on the client-supplied id (retry returns the
//     existing row at 200, not a duplicate at 201)
//   - POST /lists creates the owner-membership row in the same transaction
//   - PATCH /lists/:id requires If-Match and returns 409 with the latest row
//     when the precondition fails
//   - DELETE /lists/:id is owner-only and cascades soft-delete to items;
//     each item's updated_at is bumped so the `?since=` items feed surfaces
//     them as tombstones
//   - cross-user attempts hit 403 (never 404, which would leak existence)
//
// Repo tests already pin the SQL semantics; this file pins the HTTP edges.

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

type ListBody = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

const isListBody = (b: unknown): b is ListBody => {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.createdBy === 'string' &&
    typeof o.updatedAt === 'string'
  );
};

describe('lists write integration (HTTP)', () => {
  describe('POST /lists', () => {
    test('creates a list and seeds the owner-membership row', async () => {
      const userId = '019470fd-c100-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'a@example.com');
      const listId = '019470fd-c100-7000-8000-000000000002';

      const res = await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'Groceries' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ListBody;
      expect(isListBody(body)).toBe(true);
      expect(body.id).toBe(listId);
      expect(body.name).toBe('Groceries');
      expect(body.createdBy).toBe(userId);
      expect(body.deletedAt).toBeNull();

      // Membership row exists with role = 'owner', actor is the userId.
      const members = await t.db.select().from(listMembers).where(eq(listMembers.listId, listId));
      expect(members).toHaveLength(1);
      expect(members[0]?.userId).toBe(userId);
      expect(members[0]?.role).toBe('owner');
    });

    test('idempotent retry: same id returns the existing row at 200', async () => {
      // The Phase 7 idempotency contract — a network blip retry must not
      // double-create. The canonical row is whatever the first request
      // wrote, returned with status 200 (vs 201 for the original create).
      const userId = '019470fd-c101-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'b@example.com');
      const listId = '019470fd-c101-7000-8000-000000000002';

      const first = await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'first' }),
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as ListBody;

      // Retry with a DIFFERENT name — the canonical row stays the original
      // name. This is important: idempotent POST is "did this request
      // already happen?" not "upsert the latest payload."
      const retry = await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'different name on retry' }),
      });
      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as ListBody;
      expect(retryBody.id).toBe(listId);
      expect(retryBody.name).toBe('first');
      expect(retryBody.updatedAt).toBe(firstBody.updatedAt);

      // Exactly one membership row — the transaction did not double-insert.
      const members = await t.db.select().from(listMembers).where(eq(listMembers.listId, listId));
      expect(members).toHaveLength(1);
    });

    test('id collision with a tombstoned list returns 409', async () => {
      const userId = '019470fd-c102-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'c@example.com');
      const listId = '019470fd-c102-7000-8000-000000000002';

      // Pre-seed a soft-deleted list with the id we'll try to reuse.
      await t.db
        .insert(lists)
        .values({ id: listId, name: 'old', createdBy: userId, deletedAt: new Date() });

      const res = await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'new' }),
      });
      expect(res.status).toBe(409);
    });

    test('rejects unauthenticated requests', async () => {
      const res = await app.request('/lists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: '019470fd-c103-7000-8000-000000000001',
          name: 'no auth',
        }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /lists/:id', () => {
    test('renames the list when If-Match matches the current updated_at', async () => {
      const userId = '019470fd-c200-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'd@example.com');
      const listId = '019470fd-c200-7000-8000-000000000002';

      // Use the create endpoint so the membership row gets created too.
      const created = await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'before' }),
      });
      const createdBody = (await created.json()) as ListBody;

      const res = await app.request(`/lists/${listId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ name: 'after' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListBody;
      expect(body.name).toBe('after');
      // The trigger bumps updated_at on UPDATE; the new value must be later.
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(
        new Date(createdBody.updatedAt).getTime(),
      );
    });

    test('409 with the latest row when If-Match is stale', async () => {
      const userId = '019470fd-c201-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'e@example.com');
      const listId = '019470fd-c201-7000-8000-000000000002';

      const created = await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'v1' }),
      });
      const createdBody = (await created.json()) as ListBody;

      // 5ms gap so the trigger stamps a strictly later updated_at on the
      // first PATCH — without it the second PATCH could see the same
      // millisecond and the assertion would race.
      await new Promise((r) => setTimeout(r, 5));

      // First PATCH lands cleanly.
      const ok = await app.request(`/lists/${listId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ name: 'v2' }),
      });
      expect(ok.status).toBe(200);

      // Second PATCH sends the original (now-stale) If-Match — must 409
      // with the latest row in the body.
      const conflict = await app.request(`/lists/${listId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ name: 'v3-attempt' }),
      });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as {
        error: { code: string; message: string; requestId: string };
        latest: ListBody;
      };
      expect(body.error.code).toBe('precondition_failed');
      expect(body.latest.id).toBe(listId);
      expect(body.latest.name).toBe('v2');
      // The latest.updatedAt is the value the client should pass back as
      // the next If-Match — must be strictly greater than the cursor that
      // caused the conflict.
      expect(new Date(body.latest.updatedAt).getTime()).toBeGreaterThan(
        new Date(createdBody.updatedAt).getTime(),
      );
    });

    test('400 when If-Match header is missing', async () => {
      const userId = '019470fd-c202-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'f@example.com');
      const listId = '019470fd-c202-7000-8000-000000000002';
      await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'x' }),
      });

      const res = await app.request(`/lists/${listId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'y' }),
      });
      expect(res.status).toBe(400);
    });

    test('non-member returns 403 (does not leak existence)', async () => {
      const alice = '019470fd-c203-7000-8000-000000000001';
      const bob = '019470fd-c203-7000-8000-000000000002';
      const aliceToken = await seedUserWithToken(alice, 'a3@example.com');
      const bobToken = await seedUserWithToken(bob, 'b3@example.com');

      const listId = '019470fd-c203-7000-8000-000000000003';
      const created = await app.request('/lists', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: listId, name: 'alice' }),
      });
      const createdBody = (await created.json()) as ListBody;

      const res = await app.request(`/lists/${listId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'content-type': 'application/json',
          'If-Match': createdBody.updatedAt,
        },
        body: JSON.stringify({ name: 'bob takeover' }),
      });
      // 403 (not 404) so the response is identical whether or not the list
      // exists — bob cannot probe for list ids by trying random uuids.
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /lists/:id', () => {
    test('owner soft-deletes the list AND cascades to items (each item gets updated_at bumped)', async () => {
      const userId = '019470fd-c300-7000-8000-000000000001';
      const token = await seedUserWithToken(userId, 'g@example.com');
      const listId = '019470fd-c300-7000-8000-000000000002';
      const itemAId = '019470fd-c300-7000-8000-000000000003';
      const itemBId = '019470fd-c300-7000-8000-000000000004';
      const alreadyGone = '019470fd-c300-7000-8000-000000000005';

      await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'L' }),
      });
      // Two live items + one already-tombstoned item. The cascade must NOT
      // re-touch the already-tombstoned row (we don't want to bump its
      // updated_at and re-stream it to clients that have already seen it).
      const before = new Date();
      await t.db.insert(items).values([
        {
          id: itemAId,
          listId,
          text: 'a',
          position: 1,
          createdBy: userId,
        },
        {
          id: itemBId,
          listId,
          text: 'b',
          position: 2,
          createdBy: userId,
        },
        {
          id: alreadyGone,
          listId,
          text: 'gone',
          position: 3,
          createdBy: userId,
          deletedAt: new Date(before.getTime() - 60_000),
        },
      ]);
      const [oldGone] = await t.db.select().from(items).where(eq(items.id, alreadyGone)).limit(1);

      // 5ms so the cascade's updated_at is strictly later than insert.
      await new Promise((r) => setTimeout(r, 5));

      const res = await app.request(`/lists/${listId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(204);

      // List soft-deleted.
      const [listRow] = await t.db.select().from(lists).where(eq(lists.id, listId)).limit(1);
      expect(listRow?.deletedAt).not.toBeNull();

      // Live items now tombstoned and updated_at bumped past the original.
      const [liveA] = await t.db.select().from(items).where(eq(items.id, itemAId)).limit(1);
      const [liveB] = await t.db.select().from(items).where(eq(items.id, itemBId)).limit(1);
      expect(liveA?.deletedAt).not.toBeNull();
      expect(liveB?.deletedAt).not.toBeNull();
      expect(liveA?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(liveB?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

      // Already-tombstoned item is left alone — same deleted_at, same
      // updated_at as before the cascade ran. This is what keeps the
      // `?since=` items feed from re-streaming long-dead rows.
      const [stillGone] = await t.db.select().from(items).where(eq(items.id, alreadyGone)).limit(1);
      expect(stillGone?.deletedAt?.getTime()).toBe(oldGone?.deletedAt?.getTime());
      expect(stillGone?.updatedAt.getTime()).toBe(oldGone?.updatedAt.getTime());
    });

    test('editor (non-owner) member returns 403', async () => {
      const owner = '019470fd-c301-7000-8000-000000000001';
      const editor = '019470fd-c301-7000-8000-000000000002';
      const ownerToken = await seedUserWithToken(owner, 'o@example.com');
      const editorToken = await seedUserWithToken(editor, 'e2@example.com');

      const listId = '019470fd-c301-7000-8000-000000000003';
      await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'shared' }),
      });
      // Hand-insert the editor membership — sharing flow is not landed yet
      // (Phase 15) so we can't exercise the inviting flow end-to-end.
      await t.db.insert(listMembers).values({ listId, userId: editor, role: 'editor' });

      const res = await app.request(`/lists/${listId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${editorToken}` },
      });
      expect(res.status).toBe(403);
    });

    test('cross-user (non-member) DELETE returns 403', async () => {
      const alice = '019470fd-c302-7000-8000-000000000001';
      const bob = '019470fd-c302-7000-8000-000000000002';
      const aliceToken = await seedUserWithToken(alice, 'a4@example.com');
      const bobToken = await seedUserWithToken(bob, 'b4@example.com');

      const listId = '019470fd-c302-7000-8000-000000000003';
      await app.request('/lists', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listId, name: 'alice only' }),
      });

      const res = await app.request(`/lists/${listId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
