import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { type BuildAuthRoutesOptions, buildAuthRoutes } from './features/auth/routes.ts';
import { healthRoutes } from './features/health/routes.ts';
import { buildItemsCreateRoutes, buildItemsRoutes } from './features/items/routes.ts';
import { buildListsRoutes } from './features/lists/routes.ts';
import { type EventPublisher, InMemoryEventPublisher } from './features/realtime/publisher.ts';
import { buildSyncRoutes } from './features/sync/routes.ts';
import type { Database } from './infra/db.ts';
import { onError } from './infra/middleware/error.ts';
import { type RequestIdVariables, requestId } from './infra/middleware/request-id.ts';
import { validationHook } from './infra/middleware/validation-hook.ts';

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
// `eventPublisher` is the seam Phase 10 introduces: mutation routes call
// `publisher.publish(event)` after a write commits, and the publisher fans
// it out to subscribed WebSockets. Tests pass an `InMemoryEventPublisher`
// to assert on published events without booting a real server; production
// passes a `BunEventPublisher` that's bound to the live `Bun.Server`
// instance. Defaulting to InMemory here means existing integration tests
// (which don't care about events) work unchanged and pre-Phase-10 routes
// have a no-op recorder rather than a `null` they'd have to guard against.
export type BuildAppOptions = {
  auth?: BuildAuthRoutesOptions;
  eventPublisher?: EventPublisher;
};

export const buildApp = (db: Database, opts: BuildAppOptions = {}): OpenAPIHono<AppEnv> => {
  const eventPublisher = opts.eventPublisher ?? new InMemoryEventPublisher();

  // `defaultHook` reshapes Zod validation failures into our standard
  // `{error:{code,message,requestId}}` envelope. Without this, a request
  // body that fails Zod parsing (e.g. password too short) returns the raw
  // ZodError tree, which is unreadable in client UIs. See
  // `validation-hook.ts` for the full rationale.
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

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
  app.route('/sync', buildSyncRoutes(db));
  // Two subapps mount under `/lists` because the create-item endpoint
  // (`POST /lists/:id/items`) is naturally nested under the parent list,
  // while POST/PATCH/DELETE on the list itself live next to it. Hono merges
  // routers mounted at the same path, so both register cleanly.
  app.route('/lists', buildListsRoutes(db, eventPublisher));
  app.route('/lists', buildItemsCreateRoutes(db, eventPublisher));
  app.route('/items', buildItemsRoutes(db, eventPublisher));

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
