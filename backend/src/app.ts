import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { type BuildAuthRoutesOptions, buildAuthRoutes } from './features/auth/routes.ts';
import { healthRoutes } from './features/health/routes.ts';
import type { Database } from './infra/db.ts';
import { onError } from './infra/middleware/error.ts';
import { type RequestIdVariables, requestId } from './infra/middleware/request-id.ts';

// Hono lets us declare a per-app `Env` to type `c.set/c.get`. Anything we put
// on the request context flows through this type, so feature handlers can
// `c.get('logger')` with full type safety. The base app exposes only
// `RequestIdVariables` here — feature subapps that need more (e.g. auth's
// `userId`) extend their *own* Env locally; that scoping prevents the global
// type from claiming variables that aren't actually set for every route.
export type AppEnv = {
  Variables: RequestIdVariables;
};

// We swap from `Hono` to `OpenAPIHono` at the root so we can mount the
// generated `/openapi.json` and Swagger UI. The base class is fully
// compatible with everything Phase 2/3 wired up — `Hono` features (use,
// route, onError, fetch) are inherited.
//
// Returning the app instance instead of immediately calling `Bun.serve` is
// the key to fast tests: `app.request('/health')` in routes.test.ts goes
// straight into `app.fetch` without binding a port or starting a server.
// Production (index.ts) calls Bun.serve once with the same `app.fetch`.
// One construction path, two consumers — no test-only mocks of the HTTP layer.
export type BuildAppOptions = {
  auth?: BuildAuthRoutesOptions;
};

export const buildApp = (db: Database, opts: BuildAppOptions = {}): OpenAPIHono<AppEnv> => {
  const app = new OpenAPIHono<AppEnv>();

  // Order matters: requestId must run *before* any handler that wants
  // `c.get('logger')`. `app.use('*', ...)` registers a middleware that runs
  // on every path.
  app.use('*', requestId());

  // onError catches anything thrown anywhere downstream, including from
  // middleware registered after this point. Registering it once at the app
  // root keeps us from spreading try/catch across feature code, AND it
  // catches HTTPExceptions thrown from validation in OpenAPIHono routes.
  app.onError(onError);

  app.route('/health', healthRoutes);
  app.route('/auth', buildAuthRoutes(db, opts.auth));

  // OpenAPI spec endpoint. The `doc` method walks the registered routes,
  // generates an OpenAPI 3.1 document, and serves it as JSON. Anything that
  // imports this app (Swagger UI here, future codegen pipelines) reads from
  // the same source — there is no parallel YAML to maintain.
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'shared-list backend',
      version: '0.0.0',
      description: 'Locally-hosted shared list. Phase 4 ships auth.',
    },
  });

  // Swagger UI is mounted at /swagger-ui and reads the spec at /openapi.json.
  // No login / no protection — this is a local dev backend.
  app.get('/swagger-ui', swaggerUI({ url: '/openapi.json' }));

  return app;
};
