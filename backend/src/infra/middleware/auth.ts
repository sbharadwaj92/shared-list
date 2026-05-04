import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyAccessToken } from '../../features/auth/tokens.ts';

// `requireAuth` middleware.
//
// Gate any route that needs an authenticated user. It reads the bearer token
// from `Authorization: Bearer <jwt>`, verifies it via jose, and stashes the
// user id on the request context as `c.get('userId')`. The downstream handler
// can then trust that `userId` exists and is a real, signature-verified
// identifier — no per-route "did the middleware run" defensive checks.
//
// Failure modes:
//   - missing/malformed Authorization header  → 401
//   - signature invalid                       → 401
//   - expired                                 → 401
//   - missing `sub` claim                     → 401
//
// We use the same status (401) for all four because they're all "you are
// not (provably) authenticated." No 403, no 422 — those would distinguish
// "we know who you are but you can't do this" (authorization, not relevant
// here) and "your input was malformed" (which a tampered JWT *technically*
// is, but Bearer-token presence is a binary auth check).

// Adds the `userId` slot to the request context types. The Hono `Variables`
// extension is purely a type-system thing; the value is whatever you stash
// via `c.set('userId', '...')`.
export type AuthVariables = {
  userId: string;
};

export const requireAuth = (): MiddlewareHandler<{ Variables: AuthVariables }> => {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header) {
      throw new HTTPException(401, { message: 'missing Authorization header' });
    }

    // Lowercase comparison so `bearer xxx`, `Bearer xxx`, `BEARER xxx` all
    // work. Some HTTP libraries lowercase scheme names; being strict here
    // would cause hard-to-debug 401s on edge clients.
    const match = /^Bearer\s+(.+)$/i.exec(header);
    // `match[1]` exists if the regex matched (it has one capturing group), but
    // tsconfig's `noUncheckedIndexedAccess` requires we treat array access as
    // potentially undefined. Destructure with a default for an explicit guard.
    const token = match?.[1]?.trim();
    if (!token) {
      throw new HTTPException(401, { message: 'malformed Authorization header' });
    }

    try {
      const claims = await verifyAccessToken(token);
      c.set('userId', claims.sub);
    } catch {
      // Don't leak the underlying jose error message ("signature verification
      // failed", "exp claim timestamp check failed") — same 401 for every
      // failure shape so a probing client can't tell expired-vs-tampered.
      throw new HTTPException(401, { message: 'invalid or expired access token' });
    }

    await next();
  };
};
