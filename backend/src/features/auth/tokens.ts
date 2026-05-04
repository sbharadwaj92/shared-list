import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../infra/config.ts';

// Token utilities for Phase 4 auth.
//
// Two distinct token types live here:
//   1. ACCESS TOKEN — a signed, stateless JWT (HS256) with 15-min TTL. The
//      server does not store it; the JWT itself carries everything needed to
//      authorize a request (subject = user id). Verification is a single
//      `jwtVerify` call against the shared secret.
//
//   2. REFRESH TOKEN — an opaque random string (32 bytes, base64url-encoded).
//      The server *does* store these — but only their sha256 hashes, in the
//      `refresh_tokens` table. So a DB compromise yields hashes, not bearer
//      tokens. The cleartext refresh token is returned to the client exactly
//      once, at signup/login/refresh. Clients keep it in OS-secure storage.

// HS256 is symmetric: same secret signs and verifies. That is appropriate
// here because we're a single-process backend — there is no second service
// that needs to verify without being able to sign. RS256 (asymmetric) would
// be the right call if we ever split the issuer from a separate verifier.
const ALG = 'HS256';

// jose wants the secret as a Uint8Array, not a string. We encode it once at
// module load and reuse the bytes — re-encoding per request would be wasted
// work. TextEncoder produces UTF-8 bytes; HMAC doesn't care about character
// encoding, only byte-length, so any 32+-byte secret works.
const SECRET_BYTES = new TextEncoder().encode(config.JWT_SECRET);

// JWT claims we issue. `sub` is the user id (standard "subject" claim).
// `iat` and `exp` are added by `SignJWT` automatically.
export type AccessTokenClaims = {
  sub: string;
};

export const signAccessToken = async (userId: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + config.ACCESS_TOKEN_TTL_SEC)
    .sign(SECRET_BYTES);
};

// Verify *and* parse — returns just the bits we need (the user id) so callers
// don't have to know about jose's payload shape. Throws on any failure
// (signature mismatch, expired, malformed); the caller (middleware) translates
// that into a 401 via Hono's onError.
export const verifyAccessToken = async (token: string): Promise<AccessTokenClaims> => {
  const { payload } = await jwtVerify(token, SECRET_BYTES, { algorithms: [ALG] });
  if (typeof payload.sub !== 'string') {
    // jose validates the signature and `exp`, but `sub` is application-defined
    // — we have to assert its presence and type ourselves. A token with no
    // `sub` is a malformed token from our perspective.
    throw new Error('access token missing sub claim');
  }
  return { sub: payload.sub };
};

// Refresh token format: 32 random bytes → base64url string. ~256 bits of
// entropy is overkill but cheap, and base64url is URL-safe so we never need
// to escape on the client. We deliberately do NOT use a JWT here: opaque
// random strings are simpler, smaller, and don't leak the user id when stolen.
export const generateRefreshToken = (): string => {
  // Bun (like Node 19+) ships Web Crypto. crypto.getRandomValues is the
  // CSPRNG — Math.random would be a real security bug here.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

// What lives in the DB is sha256 of the cleartext refresh token, hex-encoded.
// sha256 (not argon2id) is deliberate: refresh tokens are already 256 bits of
// random — there's nothing for argon2 to slow-down-attackers against, since
// brute force of a 256-bit random is not on the table. sha256 gives us
// constant-time equality lookups against a unique index without slowing down
// the refresh path.
export const hashRefreshToken = async (token: string): Promise<string> => {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hexEncode(new Uint8Array(digest));
};

// --- small encoding helpers, kept private ---

const base64UrlEncode = (bytes: Uint8Array): string => {
  // btoa needs a binary string, hence the chained char-code conversion.
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const hexEncode = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};
