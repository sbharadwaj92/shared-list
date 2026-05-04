import type { Hook } from '@hono/zod-openapi';
import type { Env } from 'hono';
import type { RequestIdVariables } from './request-id.ts';

// `Env` is imported only to constrain the generic parameter — the hook is
// independent of any specific Variables shape, so each call site can pass
// in its own (e.g. routes.ts uses RequestIdVariables & AuthVariables).

// Validation hook that runs after `OpenAPIHono`'s Zod parse step.
//
// Without this, a request body that fails validation (e.g. password too
// short, malformed email) returns the raw `ZodError` tree as the response —
// which is what an early Phase 5 iOS test surfaced. The Hono central
// `onError` handler never sees the failure because the validator
// short-circuits with its own `c.json(...)` before any handler can throw.
// Threading a `defaultHook` through `new OpenAPIHono({ defaultHook })`
// lets us reshape the error into the same `{error:{code,message,requestId}}`
// envelope every other failure already uses, so iOS / Android can decode
// the response with a single `APIErrorEnvelope` Codable type instead of
// branching on "raw ZodError" vs "wrapped envelope."
//
// Why a separate file rather than inlining: app.ts and routes.ts both
// instantiate OpenAPIHono and both want this hook. Keeping the function
// in one place means if we ever want to log the failure differently,
// add a `details` array, or distinguish 422 from 400 by error code,
// the change lands in exactly one spot.
//
// Status code choice: 400 (Bad Request) over 422 (Unprocessable Entity).
// Both are defensible — 422 is the "well-formed but semantically wrong"
// pedant's choice — but Hono's HTTPException default and most JS-ecosystem
// validation responses use 400. Picking 400 here matches the rest of our
// 4xx surface (the explicit HTTPException paths in service.ts also throw
// 400/401/409). One status per failure class is easier on a learner-aimed
// client than a 400/422 split.

// We require `requestId` to be on context Variables (every app must run the
// requestId middleware before this hook); beyond that the hook doesn't care
// what other Variables exist. Using a type intersection like this lets each
// call site pass its own richer Env shape — `RequestIdVariables &
// AuthVariables` for the auth subapp, plain `RequestIdVariables` for the
// root buildApp — without us re-typing here.
type WithRequestId<E extends Env> = E extends { Variables: infer V }
  ? V extends RequestIdVariables
    ? E
    : never
  : never;

// `flattenIssues` produces a single human-readable message from a ZodError.
// We could surface every issue separately (`.error.issues` is an array),
// but the iOS UI just renders one string — a flat join is plenty here.
// Format: "<path>: <message>; <path>: <message>" so the user can tell
// which field complained.
//
// The function is exported so the test can call it without standing up a
// full Hono app to assert on the message shape.
type ZodLikeError = { issues?: Array<{ path: ReadonlyArray<unknown>; message: string }> };

export const flattenIssues = (err: unknown): string => {
  // We accept `unknown` because `@hono/zod-openapi` types the `error` field
  // as `ZodError`, but at runtime we want to be defensive — if a future
  // version changes the shape, we still produce *some* string rather than
  // crashing in the error path. Defensive is appropriate here because the
  // validation hook IS the error path — a bug here would log nothing.
  const e = err as ZodLikeError;
  if (!e?.issues || e.issues.length === 0) {
    return 'invalid request';
  }
  return e.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : 'body';
      return `${path}: ${i.message}`;
    })
    .join('; ');
};

// Generic over the host app's Env so this hook works as `defaultHook` for
// the root `buildApp` AND for the auth subapp (which extends Variables with
// `userId` from `requireAuth()`). The generic constraint `WithRequestId<E>`
// statically requires that `requestId` middleware ran before the validator
// — without it, `c.get('requestId')` below would be `undefined` and the
// envelope would be malformed.
export const validationHook = <E extends Env>(
  result: Parameters<Hook<unknown, WithRequestId<E>, string, unknown>>[0],
  c: Parameters<Hook<unknown, WithRequestId<E>, string, unknown>>[1],
) => {
  if (result.success) {
    // The hook runs on success too; on success we do nothing and let the
    // route handler proceed. Returning `undefined` here is the documented
    // pass-through behaviour.
    return;
  }

  const requestId = c.get('requestId');
  const message = flattenIssues(result.error);

  // We bypass the central onError because OpenAPIHono's validator short-
  // circuits before throw can land. Building the envelope inline here is
  // the simplest fix; it does mean the shape is duplicated in two places
  // (here + error.ts). The duplication is small and stable (same three
  // fields), and the alternative — throwing HTTPException from the hook
  // and letting onError shape it — works in some Hono versions but not
  // others, and the version-dependence is a worse trap than ten lines
  // of envelope construction.
  return c.json(
    {
      error: {
        code: 'validation_error',
        message,
        requestId,
      },
    },
    400,
  );
};
