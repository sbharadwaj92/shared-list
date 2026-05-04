import { Hono } from 'hono';
import { healthRoutes } from './features/health/routes.ts';
import { onError } from './infra/middleware/error.ts';
import { type RequestIdVariables, requestId } from './infra/middleware/request-id.ts';

// Hono lets us declare a per-app `Env` to type `c.set/c.get`. Anything we put
// on the request context flows through this type, so feature handlers can
// `c.get('logger')` with full type safety. As more middleware lands (auth, etc.)
// extend `Variables` here.
export type AppEnv = {
  Variables: RequestIdVariables;
};

// Returning the Hono app instead of immediately calling `Bun.serve` is the key
// to fast tests: `app.request('/health')` in routes.test.ts goes straight into
// `app.fetch` without binding a port or starting a server. Production (index.ts)
// calls Bun.serve once with the same `app.fetch`. One construction path, two
// consumers — no test-only mocks of the HTTP layer.
export const buildApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  // Order matters: requestId must run *before* any handler that wants `c.get('logger')`.
  // `app.use('*', ...)` registers a middleware that runs on every path.
  app.use('*', requestId());
  // onError catches anything thrown anywhere downstream, including from middleware
  // registered after this point. Registering it once at the app root keeps us
  // from spreading try/catch across feature code.
  app.onError(onError);

  app.route('/health', healthRoutes);

  return app;
};
