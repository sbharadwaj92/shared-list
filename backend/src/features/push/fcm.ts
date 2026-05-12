import { SignJWT, importPKCS8 } from 'jose';
import type { FetchLike, PushJob, PushResult } from './types.ts';

// FCM HTTP v1 sender.
//
// Two-step auth:
//   1. Build a JWT signed with the service account's private key
//      (RS256). Submit it to Google's OAuth2 endpoint to mint an access
//      token, valid 1 hour.
//   2. Use that access token as `Authorization: Bearer <token>` against
//      the FCM v1 send endpoint.
//
// We could lean on a Firebase Admin SDK, but the SDK is large and meant
// for full Firebase apps (Auth, Firestore, Storage, …). We only need
// messaging, and the protocol is small enough that implementing it
// directly is the more valuable learning artifact.
//
// Service account JSON shape we care about:
//   {
//     "type": "service_account",
//     "project_id": "...",
//     "private_key_id": "...",
//     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
//     "client_email": "firebase-adminsdk-...@<project>.iam.gserviceaccount.com",
//     "token_uri": "https://oauth2.googleapis.com/token",
//     ...
//   }
//
// We pluck only `private_key`, `client_email`, and `token_uri`. The rest
// is metadata Firebase uses for other services.

export type FcmConfig = {
  projectId: string;
  // The raw JSON content of the service account file, as a single string.
  // We parse internally so the env var matches the file shape exactly.
  serviceAccountJson: string;
};

export type FcmClient = {
  send: (job: PushJob) => Promise<PushResult>;
};

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

// Parse the service account JSON exactly once, with helpful error
// messages for the common ways it goes wrong (newlines in env vars are
// the usual culprit). We don't validate every field — just what we use.
const parseServiceAccount = (raw: string): ServiceAccount => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON did not parse to an object');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON missing client_email or private_key');
  }
  return {
    client_email: o.client_email,
    private_key: o.private_key,
    token_uri:
      typeof o.token_uri === 'string' ? o.token_uri : 'https://oauth2.googleapis.com/token',
  };
};

// Google access tokens are valid ~1 hour; we mint a fresh one when we
// have less than 5 minutes left. Like APNs, this dramatically reduces
// chatter against Google's OAuth endpoint vs. minting per-request.
const OAUTH_REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000;

type OAuthCache = {
  accessToken: string;
  expiresAtMs: number;
} | null;

// Mints the OAuth2 access token. The Google OAuth2 JWT flow:
//   - JWT claims: iss=client_email, scope=https://.../firebase.messaging,
//     aud=token_uri, iat/exp.
//   - Sign with the service account private key (RS256).
//   - POST to token_uri as application/x-www-form-urlencoded with
//     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer + assertion.
const mintAccessToken = async (
  sa: ServiceAccount,
  fetchImpl: FetchLike,
): Promise<{ accessToken: string; expiresInSec: number }> => {
  const pem = sa.private_key.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    // `sub` is required when impersonating; for service account
    // self-use it's omitted, and we set `iss` only.
    .setAudience(sa.token_uri ?? 'https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60) // 1 hour, max allowed
    .sign(key);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetchImpl(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FCM OAuth token request failed: ${res.status} ${text}`);
  }
  const parsed = (await res.json()) as { access_token?: string; expires_in?: number };
  if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
    throw new Error('FCM OAuth token response missing access_token or expires_in');
  }
  return { accessToken: parsed.access_token, expiresInSec: parsed.expires_in };
};

// Build the FCM HTTP v1 payload. The v1 API splits notification (what
// the system UI renders) from data (delivered to the app). We always
// send the notification block for foreground rendering AND a data block
// for the app to read on tap.
//
// `android.priority: 'high'` is the recommendation when delivery
// latency matters — without it FCM may batch our message into a "best
// effort" window of up to 10s, which we don't want for "your shopping
// list just changed" events.
export const buildFcmPayload = (
  job: PushJob,
  _projectIdForLogs: string,
): Record<string, unknown> => {
  // Data must be Record<string,string> — FCM rejects nested objects.
  // Our PushJob shape already enforces this via Zod.
  const data: Record<string, string> = { ...job.data };
  return {
    message: {
      token: job.token,
      notification: {
        title: job.title,
        body: job.body,
      },
      data,
      android: {
        priority: 'HIGH',
      },
    },
  };
};

// Map FCM errors → PushResult. Like APNs, status alone is insufficient
// (400 covers both permanent and retryable failures). FCM responses
// follow the Google API error format: { error: { code, message, status,
// details: [{ '@type', errorCode }] } }.
const interpretFcmResponse = async (res: Response): Promise<PushResult> => {
  if (res.status === 200) return { kind: 'ok' };

  const text = await res.text();
  let errorCode = '';
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        status?: string;
        details?: Array<{ errorCode?: string }>;
      };
    };
    // FCM puts the specific code in details[0].errorCode (e.g.
    // UNREGISTERED, INVALID_ARGUMENT). The top-level status is a generic
    // gRPC status name.
    errorCode =
      parsed.error?.details?.[0]?.errorCode ?? parsed.error?.status ?? `http_${res.status}`;
  } catch {
    errorCode = `http_${res.status}`;
  }

  switch (errorCode) {
    case 'UNREGISTERED':
    case 'NOT_FOUND':
      // Token is dead — uninstall or expired registration.
      return { kind: 'unregistered' };
    case 'UNAVAILABLE':
    case 'INTERNAL':
    case 'DEADLINE_EXCEEDED':
      return { kind: 'retry', reason: errorCode };
    case 'QUOTA_EXCEEDED':
      return { kind: 'retry', reason: errorCode };
    default:
      // INVALID_ARGUMENT, SENDER_ID_MISMATCH, etc. are permanent.
      return { kind: 'invalid', reason: errorCode };
  }
};

export const makeFcmClient = (cfg: FcmConfig, opts: { fetch?: FetchLike } = {}): FcmClient => {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const sa = parseServiceAccount(cfg.serviceAccountJson);
  let cache: OAuthCache = null;

  const getAccessToken = async (): Promise<string> => {
    const now = Date.now();
    if (cache && cache.expiresAtMs > now + OAUTH_REFRESH_SAFETY_MARGIN_MS) {
      return cache.accessToken;
    }
    const { accessToken, expiresInSec } = await mintAccessToken(sa, fetchImpl);
    cache = { accessToken, expiresAtMs: now + expiresInSec * 1000 };
    return accessToken;
  };

  const url = `https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`;

  return {
    async send(job: PushJob): Promise<PushResult> {
      if (job.platform !== 'android') {
        return {
          kind: 'invalid',
          reason: `fcm client received non-android job (${job.platform})`,
        };
      }
      const accessToken = await getAccessToken();
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildFcmPayload(job, cfg.projectId)),
      });
      return interpretFcmResponse(res);
    },
  };
};
