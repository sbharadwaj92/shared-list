import { rateLimiter } from 'hono-rate-limiter';

// Per-endpoint rate limits, in-memory.
//
// PLAN.md L81 numbers (kept here, not duplicated in routes.ts so future
// tuning is one file). The numbers are deliberately *generous* for a
// learning-project local-LAN deployment: the goal is to demonstrate the
// pattern (request → 429 → retry-after) without making local dev iteration
// painful. A production deployment would tighten these.
//   - login   30 req / minute / IP   (was 5/min — bumped Phase 9 because
//                                    the cross-platform harness boots ~8
//                                    test processes per run, each of
//                                    which signs in once or twice)
//   - signup  10 req / hour / IP     (was 3/hour — bumped Phase 9 for
//                                    the same reason; signups are still
//                                    the tightest endpoint because each
//                                    one creates a real DB row)
//   - refresh 60 req / minute / IP  (single-flight client should keep this
//                                    well under, but the limit catches a
//                                    misbehaving client cheaply.)
//
// Why in-memory: backend runs as a single Bun process under `bun --watch`.
// A Redis-backed store would be the right call for a horizontally scaled
// deployment; this codebase explicitly isn't that. PLAN.md is the source of
// truth on this decision.
//
// Why key by IP: there's no authenticated user yet at /signup or /login,
// so we have nothing else to key on. /refresh *does* have a refresh token
// in the body, but we'd rather not key by token (a hostile actor with one
// stolen token could push out limits for the legitimate user). IP is the
// pragmatic option; behind Caddy the upstream IP is `127.0.0.1` (loopback)
// which makes IP-based limits meaningless on a dev box without trusting an
// X-Forwarded-For header. We accept that for local dev — the limits exist
// to learn the pattern and to defend against a real client bug, not against
// a network attacker on localhost.

// hono-rate-limiter wants a sync `keyGenerator`. `c.req.header('x-forwarded-for')`
// would be the right pick behind Caddy if we were running off-LAN; for now,
// the loopback peer address is fine — it just means all dev requests share
// one bucket, which is exactly what we want for a learner verifying limits.
const ipKey = (c: Parameters<Parameters<typeof rateLimiter>[0]['keyGenerator']>[0]): string => {
  return c.req.header('x-forwarded-for') ?? 'local';
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const rateLimits = {
  login: rateLimiter({
    windowMs: MINUTE_MS,
    limit: 30,
    keyGenerator: ipKey,
    standardHeaders: 'draft-7',
  }),
  signup: rateLimiter({
    windowMs: HOUR_MS,
    limit: 10,
    keyGenerator: ipKey,
    standardHeaders: 'draft-7',
  }),
  refresh: rateLimiter({
    windowMs: MINUTE_MS,
    limit: 60,
    keyGenerator: ipKey,
    standardHeaders: 'draft-7',
  }),
} as const;
