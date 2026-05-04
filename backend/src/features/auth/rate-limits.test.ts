import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';

// Dedicated rate-limit test. The main `integration.test.ts` disables limits
// (otherwise the in-memory limiter's process-wide state across tests trips
// 429s on second-and-beyond signups). This file builds a *separate* app
// instance with limits ON and confirms the throttle returns 429.
//
// The PLAN.md numbers (login 5/min/IP, signup 3/hour/IP, refresh 60/min/IP)
// are tight enough that a small loop hits them without timing tricks.

describe('auth rate limits (HTTP)', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    t = await setupTestDatabase();
    app = buildApp(t.db, { auth: { enableRateLimits: true } });
    // Clean slate. Rate-limiter state is process-local memory; we don't
    // touch it directly, but we DO want a clean DB because each tested
    // signup that gets through must produce a fresh user row.
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
  });

  afterAll(async () => {
    await t.teardown();
  });

  test('signup limit (3/hour) → 4th attempt returns 429', async () => {
    // Three back-to-back signups should succeed (each with a different
    // email; we're testing rate-limiting on signup, not duplicate-email).
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `rate-${i}@example.com`,
          password: 'correct horse battery staple',
          displayName: `R${i}`,
        }),
      });
      expect(res.status).toBe(201);
    }
    // Fourth one is throttled.
    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'rate-4@example.com',
        password: 'correct horse battery staple',
        displayName: 'R4',
      }),
    });
    expect(res.status).toBe(429);
  });
});
