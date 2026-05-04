import { Hono } from 'hono';
import { healthRoutes } from './features/health/routes.ts';
import { onError } from './infra/middleware/error.ts';
import { type RequestIdVariables, requestId } from './infra/middleware/request-id.ts';

export type AppEnv = {
  Variables: RequestIdVariables;
};

export const buildApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.use('*', requestId());
  app.onError(onError);

  app.route('/health', healthRoutes);

  return app;
};
