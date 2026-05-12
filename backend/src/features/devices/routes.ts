import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Database } from '../../infra/db.ts';
import { type AuthVariables, requireAuth } from '../../infra/middleware/auth.ts';
import type { RequestIdVariables } from '../../infra/middleware/request-id.ts';
import { validationHook } from '../../infra/middleware/validation-hook.ts';
import type { DeviceToken } from '../../infra/schema.ts';
import { ErrorResponse } from '../auth/schemas.ts';
import { upsertDeviceToken } from './repo.ts';
import { DeviceTokenDTO, RegisterDeviceBody } from './schemas.ts';

// Devices feature subapp.
//
// Single endpoint for now: POST /devices. Registers the calling user's
// device token so the push fan-out (Phase 16) can deliver notifications.
// The action is idempotent at every layer:
//
//   - Same (client-id, token, user) → 200 with the canonical row.
//   - New token for an existing client-id (token rotation on the device) →
//     a fresh INSERT creates a new row; we leave the old row in place so
//     a still-valid old token can keep delivering during the rotation
//     handover. Stale tokens get cleaned up by APNs/FCM responses
//     downstream (Phase 16 will mark them invalid).
//   - Same token registered to a new user (device handover, mostly a
//     test/dev case) → the unique-on-token constraint triggers ON CONFLICT
//     DO UPDATE in the repo helper, which reassigns the row. Otherwise
//     the original user would keep getting pushes meant for the new user.
//
// We deliberately don't return 201 vs 200 distinction here — the client
// has no reason to care, and the spec for `POST /devices` is "make this
// state true," which is the PUT-ish semantic dressed up in POST.

type Env = {
  Variables: RequestIdVariables & AuthVariables;
};

const registerDeviceRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['devices'],
  summary: 'Register or update a device token for push delivery',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: RegisterDeviceBody } }, required: true },
  },
  responses: {
    200: {
      description: 'Device token registered or updated',
      content: { 'application/json': { schema: DeviceTokenDTO } },
    },
    400: {
      description: 'Invalid body',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const toDeviceTokenDTO = (row: DeviceToken) => ({
  id: row.id,
  userId: row.userId,
  platform: row.platform,
  token: row.token,
  lastSeenAt: row.lastSeenAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const buildDevicesRoutes = (db: Database): OpenAPIHono<Env> => {
  const r = new OpenAPIHono<Env>({ defaultHook: validationHook });

  r.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  r.use('*', requireAuth());

  r.openapi(registerDeviceRoute, async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const row = await upsertDeviceToken(db, {
      id: body.id,
      userId,
      platform: body.platform,
      token: body.token,
    });
    return c.json(toDeviceTokenDTO(row), 200);
  });

  return r;
};
