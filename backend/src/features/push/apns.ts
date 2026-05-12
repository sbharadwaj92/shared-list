import { SignJWT, importPKCS8 } from 'jose';
import type { FetchLike, PushJob, PushResult } from './types.ts';

// APNs HTTP/2 sender.
//
// We don't use a node-apn library — partly because most are unmaintained
// on the HTTP/2 + .p8 stack, partly because the protocol is small enough
// to teach end-to-end. The HTTP/2 part is invisible to us at this layer:
// `fetch()` on Bun negotiates h2 automatically when the server advertises
// it, which APNs always does. So this whole sender is just "sign a JWT,
// POST to the device URL, interpret the response."
//
// JWT shape (RFC 7519 + Apple's overlay, see Apple Developer docs):
//   header: { alg: 'ES256', kid: <Key ID>, typ: 'JWT' }
//   payload: { iss: <Team ID>, iat: <epoch seconds> }
//
// `iss` is the developer team ID, NOT the key ID — common point of
// confusion. The key ID goes in the header's `kid`; the team ID is what
// signs the relationship between this key and this team.
//
// JWT TTL: Apple says max 1 hour. We re-mint every 55 minutes for safety.
// JWT is cached in-process — APNs (sensibly) wants the same JWT across
// many requests rather than rotating every call, which can trigger
// rate-limit responses if abused.

export type ApnsConfig = {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  bundleId: string;
  useSandbox: boolean;
};

export type ApnsClient = {
  send: (job: PushJob) => Promise<PushResult>;
};

// Internal token cache. The cache lives on the closure, not module-level,
// so per-test ApnsClient instances don't share state.
type TokenCache = { jwt: string; expiresAtMs: number } | null;

// Re-mint the JWT every 55 minutes (Apple's hard cap is 60). The 5-min
// safety margin protects against clock skew between us and Apple. We've
// seen JWTs in the last minute of validity get a 403 ExpiredProviderToken
// race on retry.
const TOKEN_TTL_MS = 55 * 60 * 1000;

const mintJwt = async (cfg: ApnsConfig): Promise<string> => {
  // APNs requires the private key in PKCS#8 PEM form. The .p8 files
  // Apple Developer ships ARE PKCS#8 PEM — but `\n` literals in env
  // vars are a common gotcha. We unescape here so callers can safely
  // store the key with `\n` markers in .env.
  const pem = cfg.privateKeyPem.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' })
    .setIssuer(cfg.teamId)
    .setIssuedAt(now)
    .sign(key);
};

// Map APNs response → our PushResult. APNs uses HTTP status + a JSON
// body with a `reason` string (e.g. `BadDeviceToken`, `Unregistered`).
// The status alone isn't enough — `400 BadDeviceToken` is permanent
// while `400 ExpiredProviderToken` is retryable after JWT remint.
//
// Apple's full list lives in their docs; we map the categories we
// actually need to act on differently.
const interpretApnsResponse = async (res: Response): Promise<PushResult> => {
  if (res.status === 200) return { kind: 'ok' };

  // Body is JSON for most error statuses, but APNs occasionally returns
  // empty body on transport-tier failures. Be defensive.
  const text = await res.text();
  let reason = '';
  try {
    const parsed = JSON.parse(text) as { reason?: unknown };
    if (typeof parsed.reason === 'string') reason = parsed.reason;
  } catch {
    // empty/non-JSON body — treat as transport failure
    reason = `http_${res.status}`;
  }

  switch (reason) {
    case 'Unregistered':
    case 'BadDeviceToken':
      // Token is dead — caller should remove the device_token row.
      return { kind: 'unregistered' };
    case 'ExpiredProviderToken':
    case 'InternalServerError':
    case 'ServiceUnavailable':
    case 'Shutdown':
      // Transient. JWT renewal happens on next mint cycle naturally.
      return { kind: 'retry', reason };
    case 'TooManyRequests':
      return { kind: 'retry', reason };
    default:
      // Includes BadCertificateEnvironment, BadTopic, PayloadEmpty,
      // PayloadTooLarge, etc. These are configuration / programming
      // errors that retrying won't fix.
      return { kind: 'invalid', reason: reason || `http_${res.status}` };
  }
};

// Builds the APNs payload. We keep this separate from the network code
// so tests can pin the exact body shape without touching fetch.
//
// The wrapping `aps` object is the alert envelope; everything else at
// the top level becomes the user-info dictionary the iOS app sees in
// `didReceiveRemoteNotification`. We flatten `data` to the top level
// rather than nesting because that's the conventional iOS shape.
export const buildApnsPayload = (job: PushJob): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    aps: {
      alert: {
        title: job.title,
        body: job.body,
      },
      sound: 'default',
    },
  };
  if (job.data) {
    for (const [k, v] of Object.entries(job.data)) {
      payload[k] = v;
    }
  }
  return payload;
};

export const makeApnsClient = (cfg: ApnsConfig, opts: { fetch?: FetchLike } = {}): ApnsClient => {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let cache: TokenCache = null;

  const getJwt = async (): Promise<string> => {
    const now = Date.now();
    if (cache && cache.expiresAtMs > now) return cache.jwt;
    const jwt = await mintJwt(cfg);
    cache = { jwt, expiresAtMs: now + TOKEN_TTL_MS };
    return jwt;
  };

  const host = cfg.useSandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';

  return {
    async send(job: PushJob): Promise<PushResult> {
      if (job.platform !== 'ios') {
        return { kind: 'invalid', reason: `apns client received non-ios job (${job.platform})` };
      }
      const jwt = await getJwt();
      const url = `https://${host}/3/device/${job.token}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': cfg.bundleId,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildApnsPayload(job)),
      });
      return interpretApnsResponse(res);
    },
  };
};
