import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Database } from '../../infra/db.ts';
import { type AuthVariables, requireAuth } from '../../infra/middleware/auth.ts';
import type { RequestIdVariables } from '../../infra/middleware/request-id.ts';
import { validationHook } from '../../infra/middleware/validation-hook.ts';
import { ErrorResponse } from '../auth/schemas.ts';
import { activeMembership } from '../list-members/repo.ts';
import type { EventPublisher } from '../realtime/publisher.ts';
import { toItemDTO } from '../sync/dto.ts';
import {
  ItemIdConflictWithTombstone,
  type ItemPatch,
  conditionalUpdateItem,
  findActiveItemById,
  insertItem,
  softDeleteItem,
} from './repo.ts';
import {
  CreateItemBody,
  IfMatchHeader,
  ItemConflictResponse,
  ItemDTO,
  ItemIdParam,
  ListIdInItemPath,
  PatchItemBody,
} from './schemas.ts';

// Items write endpoints (Phase 7 slice C.1). Two routers under one builder:
//
//   - `buildItemsCreateRoutes(db)` → mounted under `/lists` so the create
//     path is `/lists/:id/items`. Nesting under the parent makes the
//     parent-id always present without a body field, matching REST custom
//     for nested resources.
//   - `buildItemsRoutes(db)` → mounted under `/items` for PATCH/DELETE keyed
//     on item id. Items are addressable globally (the id is a UUID), so
//     `/items/:id` is the natural shape — no need to repeat the listId in
//     the path on update/delete.
//
// We keep them in one file because they share repo helpers, schemas, the
// auth pattern, and the DTO converter; splitting would just duplicate
// imports without adding clarity.

type Env = {
  Variables: RequestIdVariables & AuthVariables;
};

// --- nested create route under /lists/:id/items ---

const createItemRoute = createRoute({
  method: 'post',
  path: '/{id}/items',
  tags: ['items'],
  summary: 'Add an item to a list (idempotent on the client-supplied id)',
  security: [{ bearerAuth: [] }],
  request: {
    params: ListIdInItemPath,
    body: { content: { 'application/json': { schema: CreateItemBody } }, required: true },
  },
  responses: {
    201: {
      description: 'Item created',
      content: { 'application/json': { schema: ItemDTO } },
    },
    200: {
      description: 'Item already existed (idempotent retry); returning the canonical row',
      content: { 'application/json': { schema: ItemDTO } },
    },
    400: {
      description: 'Invalid body or path',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Caller is not a member of the list',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'Supplied id collides with a tombstoned (soft-deleted) item',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

export const buildItemsCreateRoutes = (
  db: Database,
  publisher: EventPublisher,
): OpenAPIHono<Env> => {
  const r = new OpenAPIHono<Env>({ defaultHook: validationHook });
  r.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  r.use('*', requireAuth());

  r.openapi(createItemRoute, async (c) => {
    const userId = c.get('userId');
    const { id: listId } = c.req.valid('param');
    const body = c.req.valid('json');

    const membership = await activeMembership(db, listId, userId);
    if (!membership) {
      // 403 (not 404) so non-member probing cannot enumerate list ids — same
      // privacy stance as the patch/delete handlers in lists/routes.ts.
      throw new HTTPException(403, { message: 'not a member of this list' });
    }

    try {
      const { row, created } = await insertItem(db, {
        id: body.id,
        listId,
        text: body.text,
        position: body.position,
        createdBy: userId,
      });
      // Same idempotency guard as lists: only publish on a real insert.
      if (created) {
        publisher.publish({
          entity: 'item',
          action: 'created',
          id: row.id,
          listId: row.listId,
          at: row.updatedAt.toISOString(),
        });
      }
      return c.json(toItemDTO(row), created ? 201 : 200);
    } catch (err) {
      if (err instanceof ItemIdConflictWithTombstone) {
        throw new HTTPException(409, {
          message: 'item id collides with a deleted item; pick a new uuid',
        });
      }
      throw err;
    }
  });

  return r;
};

// --- patch + delete routes under /items/:id ---

const patchItemRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['items'],
  summary: 'Update text / position / checked (conditional via If-Match header)',
  security: [{ bearerAuth: [] }],
  request: {
    params: ItemIdParam,
    headers: IfMatchHeader,
    body: { content: { 'application/json': { schema: PatchItemBody } }, required: true },
  },
  responses: {
    200: {
      description: 'Item patched; returning the new canonical row',
      content: { 'application/json': { schema: ItemDTO } },
    },
    400: {
      description: 'Invalid body or missing If-Match header',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Caller is not a member of the list this item belongs to',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Item does not exist or has been deleted',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'If-Match precondition failed; the row was modified since the cursor',
      content: { 'application/json': { schema: ItemConflictResponse } },
    },
  },
});

const deleteItemRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['items'],
  summary: 'Soft-delete an item',
  security: [{ bearerAuth: [] }],
  request: { params: ItemIdParam },
  responses: {
    204: { description: 'Item soft-deleted (idempotent)' },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Caller is not a member of the list this item belongs to',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Item does not exist or already deleted',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

export const buildItemsRoutes = (db: Database, publisher: EventPublisher): OpenAPIHono<Env> => {
  const r = new OpenAPIHono<Env>({ defaultHook: validationHook });
  r.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  r.use('*', requireAuth());

  r.openapi(patchItemRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    // Header presence enforced by the Zod route schema (see lists/routes.ts
    // for the same rationale). We still parse here so a malformed value
    // returns a tailored 400.
    const ifMatchRaw = c.req.header('If-Match') ?? '';
    const expected = parseIfMatch(ifMatchRaw);

    // Membership lookup needs the listId — we read it off the current item
    // row. If the row is gone, treat as 404 (we can't even decide what list
    // to gate against).
    const existing = await findActiveItemById(db, id);
    if (!existing) {
      throw new HTTPException(404, { message: 'item not found' });
    }
    const membership = await activeMembership(db, existing.listId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: 'not a member of this list' });
    }

    // Translate the wire-shaped patch (ISO string for `checked`) into the
    // repo-shaped patch (Date | null). The repo layer doesn't know about the
    // wire format — keeping that translation here keeps the repo a thin
    // SQL layer.
    const patch: ItemPatch = {};
    if (body.text !== undefined) patch.text = body.text;
    if (body.position !== undefined) patch.position = body.position;
    if (body.checked !== undefined)
      patch.checked = body.checked === null ? null : new Date(body.checked);

    const result = await conditionalUpdateItem(db, {
      id,
      patch,
      expectedUpdatedAt: expected,
    });
    if (result.ok) {
      publisher.publish({
        entity: 'item',
        action: 'updated',
        id: result.row.id,
        listId: result.row.listId,
        at: result.row.updatedAt.toISOString(),
      });
      return c.json(toItemDTO(result.row), 200);
    }
    if (!result.latest) {
      throw new HTTPException(404, { message: 'item not found' });
    }
    // 409 mirrors the lists handler — see the rationale comment there. The
    // protocol uses one status for both kinds of conflict (idempotency-id
    // collision and If-Match mismatch).
    return c.json(
      {
        error: {
          code: 'precondition_failed' as const,
          message: 'If-Match precondition failed; row was modified',
          requestId: c.get('requestId'),
        },
        latest: toItemDTO(result.latest),
      },
      409,
    );
  });

  r.openapi(deleteItemRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    const existing = await findActiveItemById(db, id);
    if (!existing) {
      throw new HTTPException(404, { message: 'item not found' });
    }
    const membership = await activeMembership(db, existing.listId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: 'not a member of this list' });
    }

    const { deleted } = await softDeleteItem(db, id);
    if (!deleted) {
      // Race: row was active when we read it but is now gone. 404 is the
      // honest answer.
      throw new HTTPException(404, { message: 'item already deleted' });
    }
    publisher.publish({
      entity: 'item',
      action: 'deleted',
      id,
      listId: existing.listId,
      at: new Date().toISOString(),
    });
    return c.body(null, 204);
  });

  return r;
};

// Same parser used in lists/routes.ts. We duplicate it here (small, stable)
// rather than reach across feature boundaries — moving to a shared helper
// makes sense if a third route ever needs it.
const parseIfMatch = (raw: string): Date => {
  const stripped = raw.replace(/^W\//, '').replace(/^"|"$/g, '');
  const d = new Date(stripped);
  if (Number.isNaN(d.getTime())) {
    throw new HTTPException(400, { message: 'If-Match must be ISO8601 datetime with timezone' });
  }
  return d;
};
