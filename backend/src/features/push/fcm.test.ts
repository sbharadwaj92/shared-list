import { describe, expect, test } from 'bun:test';
import { type FcmConfig, buildFcmPayload, makeFcmClient } from './fcm.ts';
import type { PushJob } from './types.ts';

// FCM sender tests. Same pattern as APNs — stub fetch, assert on
// payload shape and response interpretation. The OAuth2 step adds one
// extra network call that we also stub.
//
// The two-step nature (mint OAuth token, then send) means each test
// configures fetch as a small state machine: first call returns the
// token, second call returns the FCM response.

// Test RSA-2048 PKCS#8 PEM. Generated with:
//   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 |
//     openssl pkcs8 -topk8 -nocrypt
// Test-only — never used for live FCM.
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

const baseServiceAccountJson = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: TEST_RSA,
  client_email: 'firebase-adminsdk-test@test-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const baseConfig: FcmConfig = {
  projectId: 'test-project',
  serviceAccountJson: baseServiceAccountJson,
};

const baseJob: PushJob = {
  token: 'fcm-token-aaa',
  platform: 'android',
  title: 'Hello',
  body: 'World',
};

describe('buildFcmPayload', () => {
  test('builds the v1 message envelope with high priority', () => {
    const payload = buildFcmPayload(baseJob, 'test-project') as {
      message: {
        token: string;
        notification: { title: string; body: string };
        android: { priority: string };
      };
    };
    expect(payload.message.token).toBe('fcm-token-aaa');
    expect(payload.message.notification.title).toBe('Hello');
    expect(payload.message.notification.body).toBe('World');
    // priority: 'HIGH' (uppercase) is the FCM v1 API value — lowercase is
    // legacy v0. Forgetting this caused real-world "messages arrive 9
    // seconds late" bugs in adjacent projects.
    expect(payload.message.android.priority).toBe('HIGH');
  });

  test('includes data dict as string-string', () => {
    const payload = buildFcmPayload(
      { ...baseJob, data: { listId: 'list-xyz', kind: 'item.created' } },
      'test-project',
    ) as { message: { data: Record<string, string> } };
    expect(payload.message.data).toEqual({ listId: 'list-xyz', kind: 'item.created' });
  });
});

// Builds a stub fetch that responds differently for OAuth vs FCM URLs.
// Each fetcher state-machine takes a sequence of responses, indexed by
// the URL hostname.
const stubFcmFetch = (responses: {
  oauth: () => Response;
  send: () => Response;
}): typeof fetch => {
  return ((url: string, _init: RequestInit): Promise<Response> => {
    if (url.includes('oauth2.googleapis.com')) {
      return Promise.resolve(responses.oauth());
    }
    if (url.includes('fcm.googleapis.com')) {
      return Promise.resolve(responses.send());
    }
    return Promise.resolve(new Response('unknown url', { status: 500 }));
  }) as unknown as typeof fetch;
};

const oauthOk = () =>
  new Response(JSON.stringify({ access_token: 'ya29.fake-token', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('makeFcmClient.send', () => {
  test('200 OK -> kind ok and requests both URLs in order', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string, _init: RequestInit) => {
      calls.push(url);
      if (url.includes('oauth2.googleapis.com')) return Promise.resolve(oauthOk());
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result).toEqual({ kind: 'ok' });
    expect(calls[0]).toContain('oauth2.googleapis.com');
    expect(calls[1]).toContain('fcm.googleapis.com');
    expect(calls[1]).toContain('test-project');
  });

  test('UNREGISTERED -> kind unregistered', async () => {
    const fetchImpl = stubFcmFetch({
      oauth: oauthOk,
      send: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 404,
              status: 'NOT_FOUND',
              details: [
                {
                  '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                  errorCode: 'UNREGISTERED',
                },
              ],
            },
          }),
          { status: 404 },
        ),
    });
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('unregistered');
  });

  test('UNAVAILABLE -> kind retry', async () => {
    const fetchImpl = stubFcmFetch({
      oauth: oauthOk,
      send: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 503,
              status: 'UNAVAILABLE',
              details: [{ errorCode: 'UNAVAILABLE' }],
            },
          }),
          { status: 503 },
        ),
    });
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('retry');
  });

  test('INVALID_ARGUMENT -> kind invalid', async () => {
    const fetchImpl = stubFcmFetch({
      oauth: oauthOk,
      send: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              details: [{ errorCode: 'INVALID_ARGUMENT' }],
            },
          }),
          { status: 400 },
        ),
    });
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('invalid');
  });

  test('QUOTA_EXCEEDED -> kind retry', async () => {
    const fetchImpl = stubFcmFetch({
      oauth: oauthOk,
      send: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              details: [{ errorCode: 'QUOTA_EXCEEDED' }],
            },
          }),
          { status: 429 },
        ),
    });
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('retry');
  });

  test('caches OAuth token across sends', async () => {
    // The OAuth endpoint should be hit exactly once across two sends.
    // Without caching, every push would pay a ~300ms round-trip to mint
    // a fresh token, which throttles delivery throughput badly.
    let oauthCalls = 0;
    let sendCalls = 0;
    const fetchImpl = ((url: string, _init: RequestInit): Promise<Response> => {
      if (url.includes('oauth2.googleapis.com')) {
        oauthCalls++;
        return Promise.resolve(oauthOk());
      }
      sendCalls++;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    await client.send(baseJob);
    await client.send(baseJob);
    expect(oauthCalls).toBe(1);
    expect(sendCalls).toBe(2);
  });

  test('OAuth failure surfaces as a throw', async () => {
    // Distinguishing OAuth failure from delivery failure matters: a bad
    // service-account JSON should be an error you SEE at boot, not a
    // silent "no pushes ever delivered." We let the throw propagate
    // through the worker, which causes retry — eventually the operator
    // notices the dead-letter pile-up.
    const fetchImpl = stubFcmFetch({
      oauth: () => new Response('invalid_grant', { status: 401 }),
      send: () => new Response('', { status: 200 }),
    });
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    await expect(client.send(baseJob)).rejects.toThrow(/FCM OAuth token request failed/);
  });

  test('rejects non-android platform', async () => {
    let callCount = 0;
    const fetchImpl = ((_url: string, _init: RequestInit) => {
      callCount++;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
    const client = makeFcmClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send({ ...baseJob, platform: 'ios' });
    expect(result.kind).toBe('invalid');
    // We never even reached the OAuth step — wrong-platform check is
    // synchronous and ahead of any network call.
    expect(callCount).toBe(0);
  });
});

describe('service account parse errors', () => {
  test('non-JSON throws with helpful message', () => {
    expect(() => makeFcmClient({ projectId: 'p', serviceAccountJson: 'not json' })).toThrow(
      /not valid JSON/,
    );
  });

  test('missing private_key throws', () => {
    const bad = JSON.stringify({
      client_email: 'a@b.c',
    });
    expect(() => makeFcmClient({ projectId: 'p', serviceAccountJson: bad })).toThrow(
      /missing client_email or private_key/,
    );
  });

  test('missing client_email throws', () => {
    const bad = JSON.stringify({ private_key: 'foo' });
    expect(() => makeFcmClient({ projectId: 'p', serviceAccountJson: bad })).toThrow(
      /missing client_email or private_key/,
    );
  });
});
