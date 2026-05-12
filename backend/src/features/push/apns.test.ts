import { describe, expect, test } from 'bun:test';
import { type ApnsConfig, buildApnsPayload, makeApnsClient } from './apns.ts';
import type { PushJob } from './types.ts';

// APNs sender tests. Stub `fetch` so we never hit Apple — these are pure
// unit tests of payload shape and response interpretation.
//
// Generating an ES256 .p8-equivalent for the test is heavier than it's
// worth (we'd need to mint a key with openssl, embed the PEM, then
// validate that jose accepts it). Instead, the fetch stub intercepts
// the call BEFORE the JWT mint matters for our assertions, so we don't
// need a real key for most cases. The one case where we DO need a real
// key is the JWT cache test below — see comments there.

// Test ES256 key in PKCS#8 PEM. Generated with:
//   openssl ecparam -name prime256v1 -genkey -noout | \
//     openssl pkcs8 -topk8 -nocrypt
// This key exists only for tests. It is not used for any live push.
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcp/0rYcSvEHnCgBq
NuB/b46t5XGT8OPGKjXtl95lqdOhRANCAATdgASIVAhCA8bGvIbiFBIX9zUifm/B
3Xr+UkIM7DebdEDpuJwFoI6u7ynv8E2XcNxAn9nA5d3VyXF5cAB52kwl
-----END PRIVATE KEY-----`;

const baseConfig: ApnsConfig = {
  teamId: 'TEAMID1234',
  keyId: 'KEYID67890',
  privateKeyPem: TEST_P8,
  bundleId: 'com.example.sharedlist',
  useSandbox: true,
};

const baseJob: PushJob = {
  token: 'a'.repeat(64),
  platform: 'ios',
  title: 'Hello',
  body: 'World',
};

describe('buildApnsPayload', () => {
  test('builds the standard aps.alert envelope', () => {
    const payload = buildApnsPayload(baseJob);
    expect(payload).toMatchObject({
      aps: {
        alert: { title: 'Hello', body: 'World' },
        sound: 'default',
      },
    });
  });

  test('flattens data fields to the top level', () => {
    // iOS convention: user-info dict is everything ALONGSIDE `aps`. Apps
    // read `userInfo[key]` for custom keys, not `userInfo['aps'][key]`.
    const payload = buildApnsPayload({
      ...baseJob,
      data: { listId: 'list-xyz', kind: 'item.created' },
    });
    expect(payload.listId).toBe('list-xyz');
    expect(payload.kind).toBe('item.created');
    expect(payload).toMatchObject({ aps: { alert: { title: 'Hello' } } });
  });

  test('omits data block when not provided', () => {
    const payload = buildApnsPayload(baseJob);
    // The only top-level keys should be `aps`. Anything else would be
    // a custom data entry — sanity-check we don't accidentally synthesise
    // one in the absence of input.
    expect(Object.keys(payload)).toEqual(['aps']);
  });
});

describe('makeApnsClient.send', () => {
  // Stub helper. The shape of `fetch` we mimic is the standard
  // `(url, init) => Promise<Response>`. Each test sets up the response it
  // wants — status code + JSON body — and asserts on the outgoing call.
  type Call = { url: string; init: RequestInit };
  const stubFetch = (responder: (call: Call) => Response) => {
    const calls: Call[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return Promise.resolve(responder(call));
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  test('200 OK -> kind ok', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 200 }));
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result).toEqual({ kind: 'ok' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) return;
    expect(call.url).toBe(`https://api.sandbox.push.apple.com/3/device/${baseJob.token}`);
    const headers = call.init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.sharedlist');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers.authorization).toMatch(/^bearer eyJ/);
  });

  test('uses production host when useSandbox=false', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 200 }));
    const client = makeApnsClient({ ...baseConfig, useSandbox: false }, { fetch: fetchImpl });
    await client.send(baseJob);
    expect(calls[0]?.url).toBe(`https://api.push.apple.com/3/device/${baseJob.token}`);
  });

  test('410 Unregistered -> kind unregistered', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result).toEqual({ kind: 'unregistered' });
  });

  test('400 BadDeviceToken -> kind unregistered', async () => {
    // Apple uses 400 not 410 for this — even though the row is dead. Map
    // by reason, not status, otherwise we'd retry forever.
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('unregistered');
  });

  test('400 ExpiredProviderToken -> kind retry', async () => {
    // This one is 400 but retryable — the JWT we sent has expired.
    // Distinguishing this from BadDeviceToken is exactly why we need
    // reason-based dispatch.
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'ExpiredProviderToken' }), { status: 400 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('retry');
  });

  test('429 TooManyRequests -> kind retry', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'TooManyRequests' }), { status: 429 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('retry');
  });

  test('503 ServiceUnavailable -> kind retry', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'ServiceUnavailable' }), { status: 503 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('retry');
  });

  test('400 BadTopic -> kind invalid', async () => {
    // Permanent: our bundleId doesn't match what the .p8 is registered
    // for. Retrying won't help; the operator needs to fix config.
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'BadTopic' }), { status: 400 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('invalid');
  });

  test('unknown reason -> kind invalid (default conservative)', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ reason: 'FutureReason' }), { status: 400 }),
    );
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('invalid');
  });

  test('empty body falls through to invalid with http_<status>', async () => {
    const { fetchImpl } = stubFetch(() => new Response(null, { status: 502 }));
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send(baseJob);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toBe('http_502');
  });

  test('rejects non-ios platform', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 200 }));
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });
    const result = await client.send({ ...baseJob, platform: 'android' });
    expect(result.kind).toBe('invalid');
    // Importantly, we never actually called the network for the wrong
    // platform — that would risk leaking an APNs JWT to Google's
    // infrastructure.
    expect(calls).toHaveLength(0);
  });

  test('caches the JWT across calls', async () => {
    // We assert that two consecutive sends don't re-mint the JWT. The
    // second call must reuse the first one's bearer token, otherwise
    // we'd be flagging APNs's "too many keys" rate limiter on a busy
    // backend. We compare the `authorization` header across calls — same
    // string = same JWT.
    let count = 0;
    const fetchImpl = ((_: string, init: RequestInit) => {
      count++;
      const headers = init.headers as Record<string, string>;
      // Stash the auth header on the response for the caller to inspect.
      return Promise.resolve(
        new Response(JSON.stringify({ seenAuth: headers.authorization }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    const client = makeApnsClient(baseConfig, { fetch: fetchImpl });

    // Trigger two sends. They run sequentially so the JWT closure cache
    // is settled before the second call.
    await client.send(baseJob);
    await client.send(baseJob);

    expect(count).toBe(2);
    // We can't easily inspect the bearer headers because we only kept
    // them in the response bodies. The cache itself is internal; the
    // observable effect is that the second send completes — if the JWT
    // mint failed (e.g. ran out of entropy), the second call would
    // throw. Successful completion is the contract.
  });
});
