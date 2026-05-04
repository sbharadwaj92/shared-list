import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { config } from '../../infra/config.ts';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens.ts';

describe('access tokens', () => {
  test('signed token round-trips with the same sub', async () => {
    const userId = 'user-123';
    const token = await signAccessToken(userId);
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe(userId);
  });

  test('a JWT signed with the wrong secret fails to verify', async () => {
    // We don't expose a "verify with custom secret" API; instead, sign a
    // token with a deliberately-wrong key and confirm our verifier rejects it.
    // This catches any future regression where verifyAccessToken accidentally
    // skips signature checking (e.g. a bad refactor that drops the algorithms
    // option and lets `alg: none` slip through).
    const wrongSecret = new TextEncoder().encode(`${'x'.repeat(48)}`);
    const evil = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(wrongSecret);
    await expect(verifyAccessToken(evil)).rejects.toThrow();
  });

  test('an expired token fails to verify', async () => {
    // Hand-roll an already-expired JWT using the real secret. We can't wait
    // 15 minutes in a unit test, and we don't want to mock Date.now globally —
    // jose's `setExpirationTime` accepts a numeric epoch second, so we just
    // pick one in the past.
    const realSecret = new TextEncoder().encode(config.JWT_SECRET);
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(realSecret);
    await expect(verifyAccessToken(expired)).rejects.toThrow();
  });
});

describe('refresh tokens', () => {
  test('generated tokens are unique and base64url-shaped', async () => {
    // 256 bits of entropy means collision in a small set is astronomically
    // unlikely; we only generate 5 here to keep the test fast. The shape
    // assertion guards against accidental switches to e.g. hex or raw bytes.
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) tokens.add(generateRefreshToken());
    expect(tokens.size).toBe(5);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test('hashRefreshToken is deterministic and 64 hex chars (sha256)', async () => {
    const t = generateRefreshToken();
    const a = await hashRefreshToken(t);
    const b = await hashRefreshToken(t);
    expect(a).toBe(b);
    // sha256 → 32 bytes → 64 hex chars. Pinning this catches accidental
    // algorithm changes (e.g. someone swaps in sha512 and breaks DB lookups).
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different tokens produce different hashes', async () => {
    const a = await hashRefreshToken(generateRefreshToken());
    const b = await hashRefreshToken(generateRefreshToken());
    expect(a).not.toBe(b);
  });
});
