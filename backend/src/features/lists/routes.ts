import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Database } from '../../infra/db.ts';
import { type AuthVariables, requireAuth } from '../../infra/middleware/auth.ts';
import type { RequestIdVariables } from '../../infra/middleware/request-id.ts';
import { validationHook } from '../../infra/middleware/validation-hook.ts';
import { ErrorResponse } from '../auth/schemas.ts';
import { activeMembership } from '../list-members/repo.ts';
import type { EventPublisher } from '../realtime/publisher.ts';
import { toListDTO } from '../sync/dto.ts';
import {
  ListIdConflictWithTombstone,
  conditionalUpdateListName,
  findActiveListById,
  insertListWithOwner,
  softDeleteListCascade,
} from './repo.ts';
import {
  CreateListBody,
  IfMatchHeader,
  ListConflictResponse,
  ListDTO,
  ListIdParam,
  PatchListBody,
} from './schemas.ts';

// Lists write endpoints (Phase 7 slice C.1).
//
// Layering mirrors the auth subapp:
//   - request validation via Zod schemas at the route boundary
//   - auth gate via `requireAuth()` middleware on `*`
//   - per-route membership check inside the handler (POST /lists is the
//     only route that creates membership rather than reading it)
//   - business logic delegated to repo helpers; this file owns the HTTP
//     status code + response envelope decisions and nothing else
//
// Why POST /lists is its own route file rather than living in `sync/`: the
// sync subapp owns the read protocol (`?since=`) — these endpoints are the
// write surface for the same resource. Keeping them in `lists/` mirrors how
// `auth/` colocates routes + service + repo for that domain. The wire
// shape is shared via `sync/dto.ts` and `sync/schemas.ts` so a column
// rename touches one DTO file, not two.

type Env = {
  Variables: RequestIdVariables & AuthVariables;
};

// --- route configs ---

const createListRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['lists'],
  summary: 'Create a new list (idempotent on the client-supplied id)',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateListBody } }, required: true },
  },
  responses: {
    201: {
      description: 'List created; caller is now the owner-member',
      content: { 'application/json': { schema: ListDTO } },
    },
    200: {
      description: 'List already existed (idempotent retry); returning the canonical row',
      content: { 'application/json': { schema: ListDTO } },
    },
    400: {
      description: 'Invalid body (missing/malformed id or name)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'Supplied id collides with a tombstoned (soft-deleted) list',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const patchListRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['lists'],
  summary: 'Rename a list (conditional via If-Match header)',
  description:
    'Requires `If-Match: <updated_at>` header (ISO8601 datetime). Returns 409 with the latest row in the body when the precondition fails.',
  security: [{ bearerAuth: [] }],
  request: {
    params: ListIdParam,
    headers: IfMatchHeader,
    body: { content: { 'application/json': { schema: PatchListBody } }, required: true },
  },
  responses: {
    200: {
      description: 'List renamed; returning the new canonical row',
      content: { 'application/json': { schema: ListDTO } },
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
      description: 'Caller is not a member of the list',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'List does not exist or has been deleted',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description:
        'If-Match precondition failed; the row was modified since the cursor. Body includes the latest row.',
      content: { 'application/json': { schema: ListConflictResponse } },
    },
  },
});

const deleteListRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['lists'],
  summary: 'Soft-delete a list and cascade to its items (owner only)',
  security: [{ bearerAuth: [] }],
  request: { params: ListIdParam },
  responses: {
    204: { description: 'List soft-deleted (idempotent)' },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Caller is not a member of the list, or is not the owner',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'List does not exist or already deleted',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// --- registry ---

export const buildListsRoutes = (db: Database, publisher: EventPublisher): OpenAPIHono<Env> => {
  const listsRoutes = new OpenAPIHono<Env>({ defaultHook: validationHook });

  listsRoutes.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  listsRoutes.use('*', requireAuth());

  listsRoutes.openapi(createListRoute, async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    try {
      const { row, created } = await insertListWithOwner(db, {
        id: body.id,
        name: body.name,
        ownerId: userId,
      });
      // Only `created=true` triggers an event — an idempotent retry is by
      // definition NOT a state change, so emitting one would cause every
      // network blip + client retry to spam every subscriber with phantom
      // "list created" pings. Reconciliation handles the genuine case.
      if (created) {
        publisher.publish({
          entity: 'list',
          action: 'created',
          id: row.id,
          listId: row.id,
          at: row.updatedAt.toISOString(),
        });
      }
      return c.json(toListDTO(row), created ? 201 : 200);
    } catch (err) {
      if (err instanceof ListIdConflictWithTombstone) {
        // The id was previously used and the row is tombstoned. Picking a
        // new id is the right client behaviour — the client owns id generation
        // for exactly this kind of edge case.
        throw new HTTPException(409, {
          message: 'list id collides with a deleted list; pick a new uuid',
        });
      }
      throw err;
    }
  });

  listsRoutes.openapi(patchListRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    // Header presence is enforced by the Zod schema on the route config; if
    // the header is missing the central validator returns 400 with the
    // standard envelope before we ever reach this handler. We still parse
    // here so a malformed value (e.g. "garbage") returns a tailored 400
    // rather than passing through to the SQL layer as `Invalid Date`.
    const ifMatchRaw = c.req.header('If-Match') ?? '';
    const expected = parseIfMatch(ifMatchRaw);

    const membership = await activeMembership(db, id, userId);
    if (!membership) {
      // Two failure shapes collapse here: (1) the list exists but the caller
      // is not a member → 403; (2) the list does not exist at all → also 403,
      // because telling apart 403/404 leaks existence to non-members. The
      // sync feed is the only legitimate way to discover what lists you can
      // see; this endpoint will not contribute to a probing oracle.
      throw new HTTPException(403, { message: 'not a member of this list' });
    }

    const result = await conditionalUpdateListName(db, {
      id,
      name: body.name,
      expectedUpdatedAt: expected,
    });
    if (result.ok) {
      publisher.publish({
        entity: 'list',
        action: 'updated',
        id: result.row.id,
        listId: result.row.id,
        at: result.row.updatedAt.toISOString(),
      });
      return c.json(toListDTO(result.row), 200);
    }
    if (!result.latest) {
      // Existed when we checked membership above but is now gone. Race window
      // is small (concurrent DELETE during PATCH) but the right answer is
      // 404, not 412 — there's no "latest" to send.
      throw new HTTPException(404, { message: 'list not found' });
    }
    // 409 Conflict on If-Match mismatch (PLAN.md L62, L376). RFC 7232 would
    // strictly use 412 Precondition Failed for this, but PLAN picked 409 to
    // keep the LWW-merge story uniform with idempotency conflicts on POST —
    // both shapes are "your write didn't land because of a divergent state."
    // The body always carries the latest row so the client can fold the
    // divergent change in without a follow-up GET.
    return c.json(
      {
        error: {
          code: 'precondition_failed' as const,
          message: 'If-Match precondition failed; row was modified',
          requestId: c.get('requestId'),
        },
        latest: toListDTO(result.latest),
      },
      409,
    );
  });

  listsRoutes.openapi(deleteListRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    const membership = await activeMembership(db, id, userId);
    if (!membership) {
      throw new HTTPException(403, { message: 'not a member of this list' });
    }
    if (membership.role !== 'owner') {
      // Editor-role members can mutate items but cannot delete the list. The
      // narrower 403 message is OK here because the caller already knows
      // they are a member (no information leak).
      throw new HTTPException(403, { message: 'only the list owner can delete the list' });
    }

    const { deleted } = await softDeleteListCascade(db, id);
    if (!deleted) {
      // Race: somebody else just soft-deleted it. We have an existence
      // contract via membership above, so the right answer is 404 (the row
      // we were going to delete is now gone) rather than 204 (which would
      // suggest we did the delete).
      const stillThere = await findActiveListById(db, id);
      if (!stillThere) {
        throw new HTTPException(404, { message: 'list already deleted' });
      }
      // Should be unreachable — the row exists but the predicate found
      // nothing to update. Surface as 500 so we notice if the invariant
      // ever breaks.
      throw new Error('softDeleteListCascade returned deleted=false on an active row');
    }
    // One event for the list itself. The cascaded item tombstones go out
    // implicitly: subscribers pull `?since=` on receipt of any event for
    // the list and discover every item tombstone in the same response.
    // Emitting N item-deleted events here would just generate redundant
    // wake-ups on the client without delivering any new information.
    publisher.publish({
      entity: 'list',
      action: 'deleted',
      id,
      listId: id,
      at: new Date().toISOString(),
    });
    return c.body(null, 204);
  });

  return listsRoutes;
};

// `If-Match` is required to be an ISO8601 datetime string — the same shape
// the client receives in `updatedAt` from the read feed and write responses.
// We could accept other forms (epoch millis, an opaque etag), but ISO is
// what the protocol already speaks. Reject anything that does not parse so
// we don't silently treat "garbage" as "epoch" and overwrite a fresh row.
const parseIfMatch = (raw: string): Date => {
  // Strip optional weak/strong validator quoting in case a client sends
  // `"2026-..."` or `W/"..."` per RFC 7232. We accept the bare datetime too.
  const stripped = raw.replace(/^W\//, '').replace(/^"|"$/g, '');
  const d = new Date(stripped);
  if (Number.isNaN(d.getTime())) {
    throw new HTTPException(400, { message: 'If-Match must be ISO8601 datetime with timezone' });
  }
  return d;
};
