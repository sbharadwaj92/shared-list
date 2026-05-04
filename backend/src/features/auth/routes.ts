import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Database } from '../../infra/db.ts';
import { type AuthVariables, requireAuth } from '../../infra/middleware/auth.ts';
import type { RequestIdVariables } from '../../infra/middleware/request-id.ts';
import { validationHook } from '../../infra/middleware/validation-hook.ts';
import { rateLimits } from './rate-limits.ts';
import { findUserById } from './repo.ts';
import {
  AuthResponse,
  ErrorResponse,
  LoginBody,
  LogoutBody,
  MeResponse,
  RefreshBody,
  SignupBody,
} from './schemas.ts';
import { login, logout, refresh, signup } from './service.ts';

// Auth HTTP routes.
//
// We use `OpenAPIHono` (not plain `Hono`) so each route is declared as a
// `createRoute({...})` config — request/response Zod schemas, status codes,
// summaries, examples — and the OpenAPI spec is generated automatically from
// those. The Swagger UI mount in `app.ts` reads /openapi.json from this
// machinery; if a schema changes, the docs change in lockstep without an
// extra YAML file to keep in sync.
//
// We intentionally KEEP `/health` on plain Hono — that route has no schema
// surface worth documenting and adding it to OpenAPI would just be noise.
// Mixing OpenAPIHono and Hono is fine: `app.route('/auth', authRoutes)`
// works the same way for both, and OpenAPIHono extends Hono.
//
// The `Env` generic on OpenAPIHono lets handlers see `c.get('userId')` (set
// by requireAuth) and `c.get('requestId')` / `c.get('logger')` (set by the
// global request-id middleware) with full types.

type Env = {
  Variables: RequestIdVariables & AuthVariables;
};

// --- route configs ---
//
// Each route is a separate `createRoute` so the OpenAPI tags + descriptions
// can be tuned independently. Defining them outside the chained builder also
// makes the file readable — handlers stay short.

const signupRoute = createRoute({
  method: 'post',
  path: '/signup',
  tags: ['auth'],
  summary: 'Register a new user',
  request: {
    body: {
      content: { 'application/json': { schema: SignupBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'User created; returns access + refresh tokens',
      content: { 'application/json': { schema: AuthResponse } },
    },
    409: {
      description: 'Email already registered',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['auth'],
  summary: 'Exchange email + password for tokens',
  request: {
    body: { content: { 'application/json': { schema: LoginBody } }, required: true },
  },
  responses: {
    200: {
      description: 'Authenticated; returns access + refresh tokens',
      content: { 'application/json': { schema: AuthResponse } },
    },
    401: {
      description: 'Invalid credentials',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  tags: ['auth'],
  summary: 'Rotate refresh token, issue new access token',
  request: {
    body: { content: { 'application/json': { schema: RefreshBody } }, required: true },
  },
  responses: {
    200: {
      description: 'Fresh token pair issued; old refresh token marked used',
      content: { 'application/json': { schema: AuthResponse } },
    },
    401: {
      description: 'Refresh token invalid, expired, or reuse detected',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['auth'],
  summary: 'Revoke this device’s refresh token',
  request: {
    body: { content: { 'application/json': { schema: LogoutBody } }, required: true },
  },
  responses: {
    204: { description: 'Logged out (idempotent)' },
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['auth'],
  summary: 'Return the currently-authenticated user',
  // `security` on the route declaration tells Swagger UI to surface an
  // "Authorize" button so a manual tester can paste in a Bearer token and
  // exercise this endpoint. The actual enforcement is requireAuth() below.
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Authenticated user profile',
      content: { 'application/json': { schema: MeResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// --- registry ---
//
// `buildAuthRoutes(db, opts)` takes the DB client as an argument so tests can
// pass in a Testcontainers-backed Drizzle instance without going through the
// module-level singleton. Production wiring in `app.ts` passes the real
// singleton in. This is the same pattern the repo helpers use — see lists/repo.ts.
//
// `opts.rateLimits` lets integration tests disable the per-IP throttles,
// which would otherwise refuse signups across test cases (the in-memory
// limiter has process-wide state and a 3/hour signup cap). A dedicated
// rate-limit test enables the limits explicitly and verifies the 429.

export type BuildAuthRoutesOptions = {
  enableRateLimits?: boolean;
};

export const buildAuthRoutes = (
  db: Database,
  opts: BuildAuthRoutesOptions = {},
): OpenAPIHono<Env> => {
  const enableRateLimits = opts.enableRateLimits ?? true;
  // Subapp also needs the validation hook — `defaultHook` is per-instance,
  // not inherited from the parent `buildApp` instance. Without this, a
  // POST /auth/signup with a bad body still returns the raw ZodError.
  const authRoutes = new OpenAPIHono<Env>({ defaultHook: validationHook });

  // Register the bearer-auth security scheme so the meRoute `security` block
  // resolves to a real definition in the generated OpenAPI doc. Without this,
  // Swagger UI shows the lock icon but no "Authorize" button.
  authRoutes.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  // Rate limits attach BEFORE the openapi handlers, so the limiter runs first.
  // Hono evaluates middleware in registration order, so registering the
  // limiter on `/signup` etc. before `app.openapi(signupRoute, ...)` ensures
  // we throttle at the door rather than after validation has consumed the body.
  if (enableRateLimits) {
    authRoutes.use('/signup', rateLimits.signup);
    authRoutes.use('/login', rateLimits.login);
    authRoutes.use('/refresh', rateLimits.refresh);
  }
  // /me requires a valid access token. We attach `requireAuth()` only here.
  authRoutes.use('/me', requireAuth());

  authRoutes.openapi(signupRoute, async (c) => {
    const body = c.req.valid('json');
    const result = await signup(db, body);
    return c.json(result, 201);
  });

  authRoutes.openapi(loginRoute, async (c) => {
    const body = c.req.valid('json');
    const result = await login(db, body);
    return c.json(result, 200);
  });

  authRoutes.openapi(refreshRoute, async (c) => {
    const body = c.req.valid('json');
    const result = await refresh(db, body.refreshToken);
    return c.json(result, 200);
  });

  authRoutes.openapi(logoutRoute, async (c) => {
    const body = c.req.valid('json');
    await logout(db, body.refreshToken);
    // 204 = success, no body. Hono's `c.body(null, 204)` is the standard idiom.
    return c.body(null, 204);
  });

  authRoutes.openapi(meRoute, async (c) => {
    const userId = c.get('userId');
    const user = await findUserById(db, userId);
    if (!user) {
      // Token signature was valid but the user row vanished — should be
      // unreachable in normal operation (we don't delete users in v1), but
      // surface a clean 401 if it happens.
      return c.json(
        {
          error: {
            code: 'http_exception',
            message: 'user not found',
            requestId: c.get('requestId'),
          },
        },
        401,
      );
    }
    return c.json({ id: user.id, email: user.email, displayName: user.displayName }, 200);
  });

  return authRoutes;
};
