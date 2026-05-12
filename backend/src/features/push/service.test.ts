import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { upsertDeviceToken } from '../devices/repo.ts';
import type { ApnsConfig } from './apns.ts';
import type { FcmConfig } from './fcm.ts';
import { InMemoryPushQueue } from './queue.ts';
import { buildPushServiceFromEnv, makeEnabledPushService } from './service.ts';

// Tests for the public PushService facade. These cover the fan-out
// logic: given a userId, look up every active device, enqueue one job
// per device. The actual platform dispatch is covered by worker.test.ts
// and apns/fcm tests; here we care that the queue gets the right
// shape and the right number of jobs.

// Reuse the same test keys APNs/FCM tests use. The senders themselves
// aren't exercised by these tests — we plug in an InMemoryPushQueue
// that intercepts before any HTTP call would happen.
const TEST_ES256 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcp/0rYcSvEHnCgBq
NuB/b46t5XGT8OPGKjXtl95lqdOhRANCAATdgASIVAhCA8bGvIbiFBIX9zUifm/B
3Xr+UkIM7DebdEDpuJwFoI6u7ynv8E2XcNxAn9nA5d3VyXF5cAB52kwl
-----END PRIVATE KEY-----`;

const apnsConfig: ApnsConfig = {
  teamId: 'TEAMID',
  keyId: 'KEYID',
  privateKeyPem: TEST_ES256,
  bundleId: 'com.example.sharedlist',
  useSandbox: true,
};

// FCM config requires a real RSA private key for parse-time validation.
const TEST_RSA = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCccdpHsHnsEhit
tjCs/N6K33uRfcX5SXdP/JpaHqb2yh5+CIuTjLI+S3gsejqQcsn5dzU/HOCWolum
4OyNipxiV8/xaIjto66x1Rx3gQOqRcFEWourZjVSVn0lWVly1Wngz1Shj2p39WS9
QyiPbhsuUQWrA5JTRqt4aBcN4jndVh0dLgXcNU9sQDJI3tf9MfnpZ6QARz/dT6ph
nFzinmQcFCg59BZtjWQZdsl38o058DfLIzUcpFVL4/qdfBhyBsp4oq1OFxsDjOBd
US0jrEwS/kdFlZJOldAT7lKzHRQx/oxV/jysJWtV/8b/EM/vutv922tieqs02xKB
sepuQn1VAgMBAAECggEACjFBuR92hgqUyIaA69hKsG4IeS1iT1A5wYCR1tK96oC3
FVt9qnaFa1kT4oPxGlWcMpBRbAP33uCDi58GUl9oOmEBt3bpyt+54zSg9uk1IawL
QCaNCHTvfuaLHzqPwRNF42NmnmL/WwLmFg2Q0C1qgG0/awmfyCSnyb+wVtN5FSIr
zkVwUsfOW+48u2DPrC8Y5bkfp8IPYlGlYY7C+M6vA1aDKTNg9rBmg71lM80UywRS
jSZfKMsgAUZiKfw2Gg7r0g2CulBUV8Mfo34YSZ0ybNKCDnMV8/FzXmgu8fFz7WJP
tCaBvenxmIfF4GClPkeSTbninoWGUivfdXJxxhrL4QKBgQDIOkD53FXFOf7NoRCx
+pCxxYTDrXgGz9AUv4XpMbaKNO3IRx4Yi249GiQYmVc0spVTxwKFjs+p0sgkvSpr
JYwe7gLfUdqC88FLDVzLYZiUNqPRyXjAZbqMaoZSLtoxM7HZjwKmJkYRCXD2OzWe
2ujhVRxHBViA/fULRvO/PIIhNQKBgQDIBY0gIb2vmFdEgwTuS7siG8LG2VbdxqSN
AI5NtFBZ+BYNOb9Novcp/J2JCBRwCnVXrJh17P6yUGt6ACIvoN3n2DA1XHLgGBns
Lr1W/5QZG/yDm25xG5nCB2pKC8El8dv5e8T9KJVwyMvEXCjrFh7S2FdGwSmb5UGD
qlP440OPoQKBgHuLpkgF8k5tyJEsztZi2yE11QPAZ40ccTI8Mu5+pDmHCylG6IUQ
k4bUOG2NQEfd4VH+O8oZIn2Q97njlubiFiGHjvIo2YFv0lby+czsfW8Gf/KUNBPT
MVYu7I6NJkixsw2gtmu6tgURJEhqpF1Oid9v2rDf1YpSKP86WnAnb8v5AoGAT9K3
UT1l36+iE/tdemPKmIAPqR+PJQ5jGMpCAAyXjHAPDNQg3jDNBnqDu+33igcCcSy1
40njEvI5EgT/n5ZJOH70LjdouLmljrXQZem1Bpg+m57p4kWrhN1Es6whNq1gph2Y
rZcGnG3ls8U7pyW6w1YG7nujyU0iahMNU+QOUEECgYAWRptAbZetpdMU14heR8gT
pInmTUFuYG7gyLMDjXJBT1KhqN/DHaUkqv/9T8Z5effhfpZhpkEoNZgXgL8EwliQ
wx3VIsxJjFc4TJriTguLGOAd4ihBrYbyC7BBely4AP2amxp5rfy+Byb06k0SrVKw
Rvk2h2Gayq1SgbS7uM59PQ==
-----END PRIVATE KEY-----`;

const fcmConfig: FcmConfig = {
  projectId: 'test-project',
  serviceAccountJson: JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'a@b.iam.gserviceaccount.com',
    private_key: TEST_RSA,
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
};

describe('Disabled push service (PUSH_ENABLED=false)', () => {
  test('notifyUser returns 0 without touching the DB', async () => {
    // Build the disabled service. It must not require any of the
    // credential blocks — that's the whole point of the disabled path
    // (a fresh dev clone shouldn't need an Apple Developer account to
    // bring the backend up).
    const svc = buildPushServiceFromEnv({
      db: undefined as never,
      enabled: false,
      databaseUrl: 'unused',
      apns: null,
      fcm: null,
    });
    await svc.start();
    const count = await svc.notifyUser('any-user-id', { title: 't', body: 'b' });
    expect(count).toBe(0);
    await svc.stop();
  });

  test('buildPushServiceFromEnv falls back to disabled if any cred block is null', async () => {
    // Defence-in-depth: even if PUSH_ENABLED=true, missing creds should
    // not crash with a null-deref. The disabled path takes over.
    const svc = buildPushServiceFromEnv({
      db: undefined as never,
      enabled: true,
      databaseUrl: 'unused',
      apns: apnsConfig,
      fcm: null, // <- missing
    });
    const count = await svc.notifyUser('any', { title: 't', body: 'b' });
    expect(count).toBe(0);
  });
});

describe('Enabled push service fan-out', () => {
  let t: TestDatabase;
  let aliceId: string;
  let queue: InMemoryPushQueue;
  let svc: ReturnType<typeof makeEnabledPushService>;

  // 30s hook timeout — Testcontainers Postgres boot + container.stop()
  // can exceed bun:test's default 5s under CI load (slow disk, concurrent
  // jobs sharing Docker). Verified locally: ~3s end-to-end, but giving
  // it 6x headroom because flaky CI is worse than a slow happy path.
  beforeAll(async () => {
    t = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await t.teardown();
  }, 30_000);

  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
    aliceId = '019470fd-d301-7000-8000-000000000001';
    await t.db.insert(users).values({
      id: aliceId,
      email: 'alice@example.com',
      passwordHash: 'unused',
      displayName: 'Alice',
    });
    queue = new InMemoryPushQueue();
    svc = makeEnabledPushService({
      db: t.db,
      queue,
      apnsConfig,
      fcmConfig,
    });
    // Start the service WITHOUT calling work() (the worker would try to
    // call APNs/FCM with the test config, which would fail). For
    // fan-out tests we only care that the queue receives the right
    // jobs — what happens downstream is the worker's territory.
    await queue.start();
  });

  test('notifyUser with no devices enqueues nothing and returns 0', async () => {
    const count = await svc.notifyUser(aliceId, { title: 'Hi', body: 'there' });
    expect(count).toBe(0);
    expect(queue.sent).toEqual([]);
  });

  test('notifyUser with one device enqueues exactly one job', async () => {
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000010',
      userId: aliceId,
      platform: 'ios',
      token: 'apns-token-aaa',
    });
    const count = await svc.notifyUser(aliceId, {
      title: 'New item',
      body: 'Milk added to Groceries',
    });
    expect(count).toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      token: 'apns-token-aaa',
      platform: 'ios',
      title: 'New item',
      body: 'Milk added to Groceries',
    });
  });

  test('notifyUser fans out across multiple devices and platforms', async () => {
    // Alice has iPhone + iPad + Pixel. Each gets its own job.
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000020',
      userId: aliceId,
      platform: 'ios',
      token: 'iphone',
    });
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000021',
      userId: aliceId,
      platform: 'ios',
      token: 'ipad',
    });
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000022',
      userId: aliceId,
      platform: 'android',
      token: 'pixel',
    });
    const count = await svc.notifyUser(aliceId, { title: 'T', body: 'B' });
    expect(count).toBe(3);
    expect(queue.sent).toHaveLength(3);
    // sort() is lexicographic; sort the expected array to match so the
    // assertion doesn't depend on the unspecified order of
    // deviceTokensForUser's SELECT (which has no ORDER BY).
    const tokens = queue.sent.map((j) => j.token).sort();
    expect(tokens).toEqual(['ipad', 'iphone', 'pixel']);
    const platforms = queue.sent.map((j) => j.platform).sort();
    expect(platforms).toEqual(['android', 'ios', 'ios']);
  });

  test('data dict carries through to jobs', async () => {
    await upsertDeviceToken(t.db, {
      id: '019470fd-d301-7000-8000-000000000030',
      userId: aliceId,
      platform: 'ios',
      token: 'tok',
    });
    await svc.notifyUser(aliceId, {
      title: 'T',
      body: 'B',
      data: { listId: 'list-xyz', kind: 'item.created' },
    });
    expect(queue.sent[0]?.data).toEqual({ listId: 'list-xyz', kind: 'item.created' });
  });
});
