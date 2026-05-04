import { z } from '@hono/zod-openapi';

// Zod schemas for auth requests + responses.
//
// They live in their own file (not in routes.ts) so that:
//   1. Test code can import them without dragging in the full route registry.
//   2. The shape is the bit that matters — keeping it visible and unobscured
//      by handler glue makes "what does signup *accept*?" answerable from one
//      file. The OpenAPI/Swagger output is generated directly from these.
//
// We import `z` from `@hono/zod-openapi` rather than from `zod` itself.
// `@hono/zod-openapi` re-exports a Zod instance that has `.openapi()` patched
// onto schema instances — using that patched instance is what makes the
// generated OpenAPI spec carry our examples and field descriptions.
//
// Naming convention: `<Verb><Subject>Body` for request bodies, `<Subject>Response`
// for the success-shape body. Error envelopes are NOT defined here — those
// are the central `error.ts` shape, identical across every endpoint.

// Password rule: minimum 12 chars. PLAN.md doesn't specify a length policy
// for v1 (the threat model is small), but 12 is a defensible learner-friendly
// floor: long enough that a brute force is infeasible against argon2id, short
// enough that no real user complains. We can tighten later (e.g. NIST 800-63B
// composition rules) without a migration.
const password = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(256, 'password too long');

const email = z.email('must be a valid email').max(254);

const displayName = z
  .string()
  .trim()
  .min(1, 'display name required')
  .max(80, 'display name too long');

export const SignupBody = z
  .object({
    email,
    password,
    displayName,
  })
  .openapi('SignupBody', {
    example: {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      displayName: 'Alice',
    },
  });

export const LoginBody = z
  .object({
    email,
    password,
  })
  .openapi('LoginBody', {
    example: { email: 'alice@example.com', password: 'correct horse battery staple' },
  });

export const RefreshBody = z
  .object({
    refreshToken: z.string().min(1),
  })
  .openapi('RefreshBody');

export const LogoutBody = z
  .object({
    refreshToken: z.string().min(1),
  })
  .openapi('LogoutBody');

export const AuthUser = z
  .object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
  })
  .openapi('AuthUser');

export const AuthResponse = z
  .object({
    user: AuthUser,
    accessToken: z.string(),
    refreshToken: z.string(),
  })
  .openapi('AuthResponse');

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .openapi('ErrorResponse');

export const MeResponse = AuthUser.openapi('MeResponse');
