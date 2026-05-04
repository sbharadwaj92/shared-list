import { Hono } from 'hono';
import type { AppEnv } from '../../app.ts';

export type HealthResponse = {
  ok: true;
};

export const healthRoutes = new Hono<AppEnv>().get('/', (c) => {
  const body: HealthResponse = { ok: true };
  return c.json(body, 200);
});
