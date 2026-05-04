import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';

// Full HTTP integration test for auth endpoints.
//
// Distinct from `service.test.ts`: this file exercises the actual Hono app
// via `app.fetch` (no port binding, no Caddy), with the OpenAPI Zod
// validators in the path. We're testing:
//   - request validation (Zod 400s)
//   - status codes (201/200/204/401/409)
//   - response shapes (the central error envelope, the AuthResponse shape)
//   - middleware ordering (requireAuth gates /me)
//   - reuse-detection at the HTTP layer (mirrors service test, but verifies
//     the wire shape)
//
// We use type-erased `unknown` for parsed bodies and assert structurally —
// not because TS can't infer the shapes, but because typing every assertion
// against the schema types would just retype `as` casts; expect() with
// structural matchers reads more cleanly.

type AuthBody = {
  user: { id: string; email: string; displayName: string };
  accessToken: string;
  refreshToken: string;
};

const isAuthBody = (b: unknown): b is AuthBody => {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.accessToken === 'string' &&
    typeof o.refreshToken === 'string' &&
    typeof o.user === 'object' &&
    o.user !== null
  );
};

describe('auth integration (HTTP)', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    t = await setupTestDatabase();
    // Rate limits OFF in integration tests: the in-memory limiter has
    // process-wide state and a 3/hour signup cap, which causes second-and-
    // beyond signups in this file to 429 instead of 201/409. The dedicated
    // `rate-limits.test.ts` file enables them and verifies the throttle.
    app = buildApp(t.db, { auth: { enableRateLimits: false } });
  });

  afterAll(async () => {
    await t.teardown();
  });

  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
  });

  test('POST /auth/signup returns 201 with tokens and user', async () => {
    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        displayName: 'Alice',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(isAuthBody(body)).toBe(true);
    if (isAuthBody(body)) {
      expect(body.user.email).toBe('alice@example.com');
      expect(body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    }
  });

  test('POST /auth/signup with missing fields returns 400', async () => {
    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    // OpenAPIHono's default validation handler returns 400 with a Zod error.
    // We don't pin the body shape — only the status — so we'd notice if a
    // future zod-openapi version changes the default handler.
    expect(res.status).toBe(400);
  });

  test('POST /auth/signup with too-short password returns 400', async () => {
    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'a@b.c',
        password: 'short',
        displayName: 'A',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('duplicate signup returns 409 with the central error envelope', async () => {
    await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        displayName: 'Alice',
      }),
    });
    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ALICE@example.com',
        password: 'correct horse battery staple',
        displayName: 'A',
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe('http_exception');
    expect(typeof body.error.requestId).toBe('string');
  });

  test('login → refresh → logout happy path', async () => {
    // Signup
    const signupRes = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'flow@example.com',
        password: 'correct horse battery staple',
        displayName: 'F',
      }),
    });
    expect(signupRes.status).toBe(201);

    // Login
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'flow@example.com',
        password: 'correct horse battery staple',
      }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as AuthBody;

    // Refresh
    const refreshRes = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as AuthBody;
    expect(refreshBody.refreshToken).not.toBe(loginBody.refreshToken);

    // Logout (with the rotated refresh token)
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshBody.refreshToken }),
    });
    expect(logoutRes.status).toBe(204);

    // After logout, refresh should now fail
    const reuseRes = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshBody.refreshToken }),
    });
    expect(reuseRes.status).toBe(401);
  });

  test('reuse detection over HTTP: replayed token nukes all sessions', async () => {
    // Two devices for the same user
    await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'reuse@example.com',
        password: 'correct horse battery staple',
        displayName: 'R',
      }),
    });
    const loginA = (await (
      await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'reuse@example.com',
          password: 'correct horse battery staple',
        }),
      })
    ).json()) as AuthBody;
    const loginB = (await (
      await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'reuse@example.com',
          password: 'correct horse battery staple',
        }),
      })
    ).json()) as AuthBody;

    // Device A refreshes once → that token is now used
    const rotatedA = (await (
      await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: loginA.refreshToken }),
      })
    ).json()) as AuthBody;

    // Replay device A's old token → 401
    const replay = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginA.refreshToken }),
    });
    expect(replay.status).toBe(401);

    // Device B's previously-good refresh token must now also fail (revoke-all)
    const bAfter = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginB.refreshToken }),
    });
    expect(bAfter.status).toBe(401);

    // And so does the rotated-A token
    const aAfter = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotatedA.refreshToken }),
    });
    expect(aAfter.status).toBe(401);
  });

  test('GET /auth/me without token returns 401', async () => {
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
  });

  test('GET /auth/me with valid bearer returns the user', async () => {
    const signupBody = (await (
      await app.request('/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'me@me.me',
          password: 'correct horse battery staple',
          displayName: 'Me',
        }),
      })
    ).json()) as AuthBody;

    const res = await app.request('/auth/me', {
      headers: { authorization: `Bearer ${signupBody.accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string; displayName: string };
    expect(body.email).toBe('me@me.me');
    expect(body.id).toBe(signupBody.user.id);
  });

  test('GET /auth/me with malformed Authorization header returns 401', async () => {
    const res = await app.request('/auth/me', {
      headers: { authorization: 'NotBearer foo' },
    });
    expect(res.status).toBe(401);
  });

  test('GET /openapi.json includes the auth endpoints', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    // Each route should appear in the spec — proves the createRoute
    // declarations are wired and the doc generator sees them.
    expect(spec.paths['/auth/signup']).toBeDefined();
    expect(spec.paths['/auth/login']).toBeDefined();
    expect(spec.paths['/auth/refresh']).toBeDefined();
    expect(spec.paths['/auth/logout']).toBeDefined();
    expect(spec.paths['/auth/me']).toBeDefined();
  });
});
