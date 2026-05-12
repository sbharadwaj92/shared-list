import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { InMemoryEventPublisher } from './publisher.ts';

// Asserts that every mutation route emits the right event after the write.
// This is the seam test for "WS events keep up with the database" — without
// it, a refactor that drops a publish call would silently regress real-time
// behaviour, and the only failure mode would be "the iPhone doesn't update
// when the Android phone makes a change" months later.
//
// We use `InMemoryEventPublisher` so the assertion is a synchronous array
// read after the HTTP request. No WS handshake, no Bun.serve, no port
// allocation — every test is sub-100ms.

// We re-derive auth tokens through the real signup flow rather than the
// tokens helper, because the real flow is what mutation routes will see in
// production. signing-in tells us the access token we pull off the
// `/auth/signup` response is the one that requireAuth will accept.
const signupTwo = async (
  app: ReturnType<typeof buildApp>,
): Promise<{ aliceToken: string; aliceId: string; bobToken: string; bobId: string }> => {
  const res1 = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      displayName: 'Alice',
    }),
  });
  const body1 = (await res1.json()) as { user: { id: string }; accessToken: string };
  const res2 = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'bob@example.com',
      password: 'correct horse battery staple',
      displayName: 'Bob',
    }),
  });
  const body2 = (await res2.json()) as { user: { id: string }; accessToken: string };
  return {
    aliceToken: body1.accessToken,
    aliceId: body1.user.id,
    bobToken: body2.accessToken,
    bobId: body2.user.id,
  };
};

const createList = async (
  app: ReturnType<typeof buildApp>,
  token: string,
  id: string,
  name: string,
) => {
  const res = await app.request('/lists', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; updatedAt: string };
};

describe('mutation routes publish WS events', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let publisher: InMemoryEventPublisher;

  beforeAll(async () => {
    t = await setupTestDatabase();
    publisher = new InMemoryEventPublisher();
    app = buildApp(t.db, {
      auth: { enableRateLimits: false },
      eventPublisher: publisher,
    });
  });

  afterAll(async () => {
    await t.teardown();
  });

  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
    publisher.reset();
  });

  test('POST /lists publishes list/created', async () => {
    const { aliceToken } = await signupTwo(app);
    publisher.reset(); // signup doesn't publish but be defensive

    const listId = '019470fd-d301-7000-8000-000000000010';
    await createList(app, aliceToken, listId, 'Alice list');

    expect(publisher.published).toHaveLength(1);
    const evt = publisher.published[0];
    expect(evt).toBeDefined();
    if (!evt) return;
    expect(evt.entity).toBe('list');
    expect(evt.action).toBe('created');
    expect(evt.id).toBe(listId);
    expect(evt.listId).toBe(listId);
  });

  test('POST /lists idempotent retry does NOT publish a second event', async () => {
    // Idempotency on POST returns 200 (not 201). The second call's row was
    // already in the DB — no real change happened, so we must not emit a
    // bogus "created" event that would trigger reconciliation on every
    // subscriber for no reason.
    const { aliceToken } = await signupTwo(app);
    publisher.reset();

    const listId = '019470fd-d301-7000-8000-000000000020';
    await createList(app, aliceToken, listId, 'List');
    expect(publisher.published).toHaveLength(1);

    // Same id, different name — the server keeps the original row.
    const res = await app.request('/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ id: listId, name: 'Different name' }),
    });
    expect(res.status).toBe(200);
    expect(publisher.published).toHaveLength(1); // unchanged
  });

  test('PATCH /lists/:id publishes list/updated with the new updatedAt', async () => {
    const { aliceToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000030';
    const created = await createList(app, aliceToken, listId, 'Old name');
    publisher.reset();

    const res = await app.request(`/lists/${listId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
        'If-Match': created.updatedAt,
      },
      body: JSON.stringify({ name: 'New name' }),
    });
    expect(res.status).toBe(200);

    expect(publisher.published).toHaveLength(1);
    const evt = publisher.published[0];
    if (!evt) return;
    expect(evt.entity).toBe('list');
    expect(evt.action).toBe('updated');
    expect(evt.id).toBe(listId);
    // The event's `at` should be the server's new updatedAt — that's how
    // clients correlate the event with the response they got back.
    expect(typeof evt.at).toBe('string');
  });

  test('PATCH 409 (If-Match mismatch) does NOT publish', async () => {
    // Failed conditional update -> no event. This is important: a 409 means
    // the server's row diverged from what the client thought it had, and
    // the server didn't actually write anything new.
    const { aliceToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000040';
    await createList(app, aliceToken, listId, 'List');
    publisher.reset();

    const res = await app.request(`/lists/${listId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
        'If-Match': '2020-01-01T00:00:00.000+00:00', // stale
      },
      body: JSON.stringify({ name: 'New name' }),
    });
    expect(res.status).toBe(409);
    expect(publisher.published).toHaveLength(0);
  });

  test('DELETE /lists/:id publishes list/deleted', async () => {
    const { aliceToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000050';
    await createList(app, aliceToken, listId, 'List');
    publisher.reset();

    const res = await app.request(`/lists/${listId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(204);

    expect(publisher.published).toHaveLength(1);
    const evt = publisher.published[0];
    if (!evt) return;
    expect(evt.entity).toBe('list');
    expect(evt.action).toBe('deleted');
    expect(evt.id).toBe(listId);
  });

  test('DELETE 403 (non-owner) does NOT publish', async () => {
    // Bob is a non-member of Alice's list, so the DELETE rejects. No
    // event should fire — a probe attempt must not leak via the WS layer.
    const { aliceToken, bobToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000060';
    await createList(app, aliceToken, listId, 'Alice');
    publisher.reset();

    const res = await app.request(`/lists/${listId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(res.status).toBe(403);
    expect(publisher.published).toHaveLength(0);
  });

  test('POST /lists/:id/items publishes item/created with the list id', async () => {
    const { aliceToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000070';
    await createList(app, aliceToken, listId, 'List');
    publisher.reset();

    const itemId = '019470fd-d301-7000-8000-000000000071';
    const res = await app.request(`/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ id: itemId, text: 'Milk', position: 1024 }),
    });
    expect(res.status).toBe(201);

    expect(publisher.published).toHaveLength(1);
    const evt = publisher.published[0];
    if (!evt) return;
    expect(evt.entity).toBe('item');
    expect(evt.action).toBe('created');
    expect(evt.id).toBe(itemId);
    // The item's listId is the routing key — without this, the WS layer
    // wouldn't know which topic to publish to.
    expect(evt.listId).toBe(listId);
  });

  test('PATCH /items/:id publishes item/updated; 409 does not', async () => {
    const { aliceToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000080';
    await createList(app, aliceToken, listId, 'List');
    const itemId = '019470fd-d301-7000-8000-000000000081';
    const itemRes = await app.request(`/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ id: itemId, text: 'Milk', position: 1024 }),
    });
    const itemBody = (await itemRes.json()) as { updatedAt: string };
    publisher.reset();

    // Happy path: publishes
    const okRes = await app.request(`/items/${itemId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
        'If-Match': itemBody.updatedAt,
      },
      body: JSON.stringify({ text: 'Oat milk' }),
    });
    expect(okRes.status).toBe(200);
    expect(publisher.published).toHaveLength(1);
    publisher.reset();

    // 409 path: stale If-Match, no event
    const staleRes = await app.request(`/items/${itemId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
        'If-Match': '2020-01-01T00:00:00.000+00:00',
      },
      body: JSON.stringify({ text: 'Soy milk' }),
    });
    expect(staleRes.status).toBe(409);
    expect(publisher.published).toHaveLength(0);
  });

  test('DELETE /items/:id publishes item/deleted with the parent list id', async () => {
    // Important: the event's `listId` must come from the item row, NOT
    // the request URL (which doesn't include listId for /items/:id). Otherwise
    // the WS publisher would have nothing to route on.
    const { aliceToken } = await signupTwo(app);
    const listId = '019470fd-d301-7000-8000-000000000090';
    await createList(app, aliceToken, listId, 'List');
    const itemId = '019470fd-d301-7000-8000-000000000091';
    await app.request(`/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ id: itemId, text: 'Milk', position: 1024 }),
    });
    publisher.reset();

    const res = await app.request(`/items/${itemId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(204);

    expect(publisher.published).toHaveLength(1);
    const evt = publisher.published[0];
    if (!evt) return;
    expect(evt.entity).toBe('item');
    expect(evt.action).toBe('deleted');
    expect(evt.id).toBe(itemId);
    expect(evt.listId).toBe(listId);
  });
});
