import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { HTTPException } from 'hono/http-exception';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { findRefreshTokenByHash } from './repo.ts';
import { login, logout, refresh, signup } from './service.ts';
import { hashRefreshToken } from './tokens.ts';

// Service-layer integration tests against a real Postgres (Testcontainers).
//
// We test the *service* (not the HTTP layer) here — that means we exercise
// password hashing, token issuance, refresh rotation, and reuse detection
// against actual DB rows. Routes get their own thin tests in routes.test.ts
// later; that's where 400-validation and OpenAPI shape live.

describe('auth service', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await setupTestDatabase();
  });

  afterAll(async () => {
    await t.teardown();
  });

  beforeEach(async () => {
    // Truncate everything user-scoped between tests so each test starts from
    // a known empty state. CASCADE because users → refresh_tokens, etc.
    // RESTART IDENTITY isn't needed (we don't use serial PKs).
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
  });

  test('signup creates a user and returns access + refresh tokens', async () => {
    const result = await signup(t.db, {
      email: 'Alice@Example.com',
      password: 'correct horse battery staple',
      displayName: 'Alice',
    });

    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.displayName).toBe('Alice');
    expect(result.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWT shape
    expect(result.refreshToken.length).toBeGreaterThan(20);

    // Refresh token row must exist in DB, with the *hashed* value, not the
    // cleartext that went to the client.
    const presentedHash = await hashRefreshToken(result.refreshToken);
    const row = await findRefreshTokenByHash(t.db, presentedHash);
    expect(row).toBeDefined();
    expect(row?.userId).toBe(result.user.id);
    expect(row?.usedAt).toBeNull();
  });

  test('signup with duplicate email (case-insensitive) returns 409', async () => {
    await signup(t.db, { email: 'bob@x.com', password: 'pw1234567890', displayName: 'Bob' });
    await expect(
      signup(t.db, { email: 'BOB@X.COM', password: 'pw1234567890', displayName: 'B' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('login with correct credentials returns fresh tokens', async () => {
    await signup(t.db, { email: 'a@b.c', password: 'pw-correct-1', displayName: 'A' });
    const result = await login(t.db, { email: 'A@B.C', password: 'pw-correct-1' });
    expect(result.user.email).toBe('a@b.c');
    expect(result.accessToken.length).toBeGreaterThan(20);
  });

  test('login with wrong password returns 401', async () => {
    await signup(t.db, { email: 'a@b.c', password: 'pw-correct-1', displayName: 'A' });
    await expect(login(t.db, { email: 'a@b.c', password: 'WRONG' })).rejects.toMatchObject({
      status: 401,
    });
  });

  test('login with unknown email returns 401 (same as wrong password)', async () => {
    // Critical: the message must not differentiate "no such user" vs "wrong
    // password". If it did, an attacker could enumerate registered emails by
    // probing /auth/login responses.
    let unknownErr: HTTPException | undefined;
    try {
      await login(t.db, { email: 'nobody@nowhere', password: 'whatever' });
    } catch (e) {
      unknownErr = e as HTTPException;
    }

    await signup(t.db, { email: 'a@b.c', password: 'pw-correct-1', displayName: 'A' });
    let wrongPwErr: HTTPException | undefined;
    try {
      await login(t.db, { email: 'a@b.c', password: 'WRONG' });
    } catch (e) {
      wrongPwErr = e as HTTPException;
    }

    expect(unknownErr?.status).toBe(401);
    expect(wrongPwErr?.status).toBe(401);
    expect(unknownErr?.message).toBe(wrongPwErr?.message);
  });

  test('refresh rotates tokens and marks the old one used', async () => {
    const initial = await signup(t.db, {
      email: 'r@r.r',
      password: 'pw1234567890',
      displayName: 'R',
    });

    const rotated = await refresh(t.db, initial.refreshToken);

    // New refresh token != old one
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);

    // Old token row's used_at should be set
    const oldRow = await findRefreshTokenByHash(t.db, await hashRefreshToken(initial.refreshToken));
    expect(oldRow?.usedAt).not.toBeNull();

    // New token row exists, fresh used_at = null
    const newRow = await findRefreshTokenByHash(t.db, await hashRefreshToken(rotated.refreshToken));
    expect(newRow?.usedAt).toBeNull();
  });

  test('reuse-detection: replaying a used refresh token revokes all tokens', async () => {
    // Simulate three "devices" — three independent refresh tokens for the
    // same user via three sequential signup-equivalents... actually we want
    // the same user with multiple sessions. Use signup once + login twice to
    // mint three independent refresh-token rows.
    const alice1 = await signup(t.db, {
      email: 'alice@x.com',
      password: 'pw1234567890',
      displayName: 'Alice',
    });
    const alice2 = await login(t.db, { email: 'alice@x.com', password: 'pw1234567890' });
    const alice3 = await login(t.db, { email: 'alice@x.com', password: 'pw1234567890' });

    // Device 1 refreshes once successfully — alice1.refreshToken is now used.
    const rotated1 = await refresh(t.db, alice1.refreshToken);

    // Now an attacker (or buggy client) replays the OLD alice1 token. This
    // must (a) reject, (b) wipe out *every* refresh token for the user.
    await expect(refresh(t.db, alice1.refreshToken)).rejects.toMatchObject({ status: 401 });

    // Verify the nuke: all three other refresh tokens for the user are gone.
    expect(
      await findRefreshTokenByHash(t.db, await hashRefreshToken(alice2.refreshToken)),
    ).toBeUndefined();
    expect(
      await findRefreshTokenByHash(t.db, await hashRefreshToken(alice3.refreshToken)),
    ).toBeUndefined();
    expect(
      await findRefreshTokenByHash(t.db, await hashRefreshToken(rotated1.refreshToken)),
    ).toBeUndefined();
  });

  test('refresh with unknown token returns 401', async () => {
    await expect(refresh(t.db, 'totally-fake-token')).rejects.toMatchObject({ status: 401 });
  });

  test('logout deletes the device refresh token but is idempotent', async () => {
    const a = await signup(t.db, {
      email: 'l@l.l',
      password: 'pw1234567890',
      displayName: 'L',
    });
    await logout(t.db, a.refreshToken);
    expect(
      await findRefreshTokenByHash(t.db, await hashRefreshToken(a.refreshToken)),
    ).toBeUndefined();

    // Second logout with same (now-gone) token should not throw.
    await logout(t.db, a.refreshToken);
  });

  test('logout does not affect other devices', async () => {
    const a = await signup(t.db, {
      email: 'm@m.m',
      password: 'pw1234567890',
      displayName: 'M',
    });
    const b = await login(t.db, { email: 'm@m.m', password: 'pw1234567890' });

    await logout(t.db, a.refreshToken);

    // Device A's refresh token gone; device B's still present.
    expect(
      await findRefreshTokenByHash(t.db, await hashRefreshToken(a.refreshToken)),
    ).toBeUndefined();
    expect(
      await findRefreshTokenByHash(t.db, await hashRefreshToken(b.refreshToken)),
    ).toBeDefined();
  });
});
