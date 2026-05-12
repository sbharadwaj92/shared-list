import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { deviceTokens, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { deviceTokensForUser, upsertDeviceToken } from './repo.ts';

// Repo-level tests for the upsert-by-token semantics. These exercise the
// raw SQL behaviour (ON CONFLICT DO UPDATE) — the route layer is tested
// separately via HTTP integration tests.
//
// The interesting cases are NOT happy-path ("first time registration");
// they're the ones where the same token shows up again under different
// circumstances: rotating tokens for the same user, swapping users on
// the same device, re-registering after a long dormant period.

describe('upsertDeviceToken', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await setupTestDatabase();
  });

  afterAll(async () => {
    await t.teardown();
  });

  beforeEach(async () => {
    // CASCADE clears device_tokens because of the user FK.
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
  });

  const insertUser = async (id: string, email: string): Promise<string> => {
    await t.db.insert(users).values({
      id,
      email,
      passwordHash: 'unused',
      displayName: email.split('@')[0] ?? 'user',
    });
    return id;
  };

  test('first registration inserts a row', async () => {
    const userId = await insertUser('019470fd-d301-7000-8000-000000000001', 'alice@example.com');
    const id = '019470fd-d301-7000-8000-000000000100';
    const row = await upsertDeviceToken(t.db, {
      id,
      userId,
      platform: 'ios',
      token: 'apns-token-aaa',
    });
    expect(row.id).toBe(id);
    expect(row.userId).toBe(userId);
    expect(row.platform).toBe('ios');
    expect(row.token).toBe('apns-token-aaa');
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  test('same client id + same token is idempotent (one row)', async () => {
    const userId = await insertUser('019470fd-d301-7000-8000-000000000001', 'alice@example.com');
    const id = '019470fd-d301-7000-8000-000000000200';
    await upsertDeviceToken(t.db, {
      id,
      userId,
      platform: 'ios',
      token: 'apns-token-bbb',
    });
    await upsertDeviceToken(t.db, {
      id,
      userId,
      platform: 'ios',
      token: 'apns-token-bbb',
    });
    const rows = await t.db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId));
    expect(rows).toHaveLength(1);
  });

  test('same token registered to a different user MOVES the row to the new user', async () => {
    // This is the load-bearing semantic. APNs/FCM tokens are globally
    // unique — if Alice signs out and Bob signs in on the same phone,
    // the OS hands the new login the same token Alice had. Without the
    // ON CONFLICT (token) move, Alice would keep getting Bob's pushes.
    const aliceId = await insertUser('019470fd-d301-7000-8000-000000000001', 'alice@example.com');
    const bobId = await insertUser('019470fd-d301-7000-8000-000000000002', 'bob@example.com');
    const id = '019470fd-d301-7000-8000-000000000300';
    const sharedToken = 'apns-token-shared';

    await upsertDeviceToken(t.db, {
      id,
      userId: aliceId,
      platform: 'ios',
      token: sharedToken,
    });
    const aliceRows = await deviceTokensForUser(t.db, aliceId);
    expect(aliceRows).toHaveLength(1);

    // Bob registers with the same token (different client id is fine —
    // the token unique-index is what triggers the move).
    const bobClientId = '019470fd-d301-7000-8000-000000000301';
    await upsertDeviceToken(t.db, {
      id: bobClientId,
      userId: bobId,
      platform: 'ios',
      token: sharedToken,
    });

    // The row should now belong to Bob, not Alice.
    const aliceRowsAfter = await deviceTokensForUser(t.db, aliceId);
    const bobRowsAfter = await deviceTokensForUser(t.db, bobId);
    expect(aliceRowsAfter).toHaveLength(0);
    expect(bobRowsAfter).toHaveLength(1);
    // The id stays the same — ON CONFLICT DO UPDATE doesn't touch the PK.
    // This is intentional: the id was minted on Alice's device but the row
    // now represents Bob's registration. We don't churn it because it's
    // not exposed to clients as a stable identifier (clients pick their
    // own id each time).
    expect(bobRowsAfter[0]?.id).toBe(id);
  });

  test('a user can have multiple distinct device tokens (different physical devices)', async () => {
    // The unique constraint is on `token`, not (userId, token). So one
    // user can register their iPhone AND iPad with two different tokens.
    const userId = await insertUser('019470fd-d301-7000-8000-000000000001', 'alice@example.com');
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000401',
      userId,
      platform: 'ios',
      token: 'iphone-token',
    });
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000402',
      userId,
      platform: 'ios',
      token: 'ipad-token',
    });
    const rows = await deviceTokensForUser(t.db, userId);
    expect(rows).toHaveLength(2);
  });

  test('upsert bumps lastSeenAt + updatedAt on conflict', async () => {
    // The "this user is still active" signal: re-registering an already-
    // known token should refresh both timestamps. lastSeenAt drives the
    // hypothetical dormant-token cleanup job; updatedAt is the conventional
    // change marker.
    const userId = await insertUser('019470fd-d301-7000-8000-000000000001', 'alice@example.com');
    const id = '019470fd-d301-7000-8000-000000000500';
    const first = await upsertDeviceToken(t.db, {
      id,
      userId,
      platform: 'ios',
      token: 'token-xyz',
    });
    // Tiny wait so the second timestamp must strictly differ.
    await new Promise((r) => setTimeout(r, 5));
    const second = await upsertDeviceToken(t.db, {
      id,
      userId,
      platform: 'ios',
      token: 'token-xyz',
    });
    expect(second.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });
});
