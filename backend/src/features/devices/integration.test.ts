import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { deviceTokens } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';

// HTTP integration tests for the devices feature. The repo-level tests
// pin the SQL semantics; these pin the wire shape and the auth gate.

type AuthBody = { user: { id: string }; accessToken: string };

const signupAndGetToken = async (
  app: ReturnType<typeof buildApp>,
  email: string,
): Promise<{ userId: string; accessToken: string }> => {
  const res = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      displayName: email.split('@')[0] ?? 'user',
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as AuthBody;
  return { userId: body.user.id, accessToken: body.accessToken };
};

describe('POST /devices', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    t = await setupTestDatabase();
    app = buildApp(t.db, { auth: { enableRateLimits: false } });
  });

  afterAll(async () => {
    await t.teardown();
  });

  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
  });

  test('registers a token and returns the DTO', async () => {
    const { userId, accessToken } = await signupAndGetToken(app, 'alice@example.com');
    const res = await app.request('/devices', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000100',
        platform: 'ios',
        token: 'apns-token-aaa',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      userId: string;
      platform: string;
      token: string;
      lastSeenAt: string;
    };
    expect(body.userId).toBe(userId);
    expect(body.platform).toBe('ios');
    expect(body.token).toBe('apns-token-aaa');
    // Wire format check: dates come back as ISO strings with offsets, the
    // same shape as every other DTO in the system.
    expect(body.lastSeenAt).toMatch(/T.*\+00:00$|Z$/);
  });

  test('idempotent: same token + same user re-registration returns 200', async () => {
    const { accessToken } = await signupAndGetToken(app, 'alice@example.com');
    const payload = JSON.stringify({
      id: '019470fd-d301-7000-8000-000000000110',
      platform: 'android',
      token: 'fcm-token-bbb',
    });

    const r1 = await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: payload,
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: payload,
    });
    expect(r2.status).toBe(200);

    // Exactly one row should exist.
    const rows = await t.db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
  });

  test('without Authorization returns 401', async () => {
    const res = await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000120',
        platform: 'ios',
        token: 'apns-token-ccc',
      }),
    });
    expect(res.status).toBe(401);
  });

  test('missing fields returns 400 with the standard envelope', async () => {
    const { accessToken } = await signupAndGetToken(app, 'alice@example.com');
    const res = await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ id: 'not-a-uuid', platform: 'ios' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe('validation_error');
  });

  test('invalid platform returns 400', async () => {
    const { accessToken } = await signupAndGetToken(app, 'alice@example.com');
    const res = await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000130',
        platform: 'windows-phone',
        token: 'apns-token-ddd',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('one user can register two devices', async () => {
    const { userId, accessToken } = await signupAndGetToken(app, 'alice@example.com');
    await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000140',
        platform: 'ios',
        token: 'iphone-token',
      }),
    });
    await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000141',
        platform: 'ios',
        token: 'ipad-token',
      }),
    });

    const rows = await t.db.select().from(deviceTokens);
    expect(rows.filter((r) => r.userId === userId)).toHaveLength(2);
  });

  test('same token registered to Bob takes ownership away from Alice', async () => {
    // Important security property: we are deliberately moving the token
    // even across user boundaries when the token itself is the same,
    // because that's the only way to keep up with APNs/FCM reassigning
    // their globally-unique tokens to whichever account is currently
    // logged in on the device. The auth requirement on POST /devices is
    // sufficient — only the user logged into the device can register it.
    const alice = await signupAndGetToken(app, 'alice@example.com');
    const bob = await signupAndGetToken(app, 'bob@example.com');
    const sharedToken = 'apns-token-shared';

    await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${alice.accessToken}` },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000150',
        platform: 'ios',
        token: sharedToken,
      }),
    });
    await app.request('/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${bob.accessToken}` },
      body: JSON.stringify({
        id: '019470fd-d301-7000-8000-000000000151',
        platform: 'ios',
        token: sharedToken,
      }),
    });

    const rows = await t.db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(bob.userId);
  });
});
