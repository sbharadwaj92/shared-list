import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { type AuthVariables, requireAuth } from '../../infra/middleware/auth.ts';
import type { RequestIdVariables } from '../../infra/middleware/request-id.ts';
import { validationHook } from '../../infra/middleware/validation-hook.ts';
import type { Item, List, ListMember } from '../../infra/schema.ts';
import { ErrorResponse } from '../auth/schemas.ts';
import { itemsSince } from '../items/repo.ts';
import { membersSince } from '../list-members/repo.ts';
import { listsSince } from '../lists/repo.ts';
import {
  SinceQuery,
  SyncItemsResponse,
  SyncListMembersResponse,
  SyncListsResponse,
} from './schemas.ts';

// `GET /sync/<resource>?since=<ISO8601>` endpoints — the read side of the
// Phase 7 sync protocol. See `backend/docs/sync.md` for the full contract.
//
// Layering: handlers parse the `since` query to a Date (Zod's `.datetime()`
// transform), call the corresponding repo helper (which already enforces
// membership scoping + tombstone visibility rules), and serialize Date
// fields to ISO8601 strings via `Date.prototype.toJSON`.
//
// `serverTime` strategy: capture `now()` from the DB BEFORE running the
// query, then return that value. Reading `now()` from the DB (rather than
// `new Date()` in the app) keeps the cursor on the same clock as the
// stored `updated_at` values — no client/server clock skew can leak into
// the protocol. We also `date_trunc` to milliseconds to match the precision
// used by the trigger (see `0002_truncate_updated_at_ms.sql`); without
// that, a `serverTime` returned with microsecond precision would suffer
// the same JS-Date-roundtrip lossiness the trigger fix was supposed to
// eliminate.
//
// Why capture serverTime BEFORE the SELECT (not after): a row INSERT/UPDATE
// that commits during the SELECT will be invisible to the snapshot but its
// `updated_at` will be later than the captured `serverTime`, so the next
// pull (with `since=serverTime`) catches it. Capturing AFTER the SELECT
// would risk skipping rows: a write committing between SELECT-end and
// `now()`-call would have `updated_at < serverTime` and never surface to
// the client. The chosen ordering trades a possible duplicate (next pull
// sees a row that was already returned at the cursor's ms-tick) for a
// guarantee of no missed rows. Duplicates are idempotent on the client —
// missed rows are silent corruption.

type Env = {
  Variables: RequestIdVariables & AuthVariables;
};

// Captures a millisecond-truncated `now()` from the DB. We use a SQL
// expression (rather than `new Date()`) to keep the cursor on the same
// clock as `updated_at` — see the rationale in the file header.
//
// Drizzle's typed query builder coerces declared `timestamp` columns to
// `Date`, but a raw ``db.execute(sql`...`)`` returns the driver-native shape
// — for postgres-js that's the textual timestamptz `2026-05-05 08:35:02.008+00`,
// not a `Date`. We parse it explicitly here so callers receive a `Date`
// regardless of which driver layer the call went through.
const dbNow = async (db: Database): Promise<Date> => {
  const result = await db.execute(sql`SELECT date_trunc('milliseconds', now()) AS now`);
  const rows = result as unknown as { now: string | Date }[];
  const first = rows[0];
  if (!first) {
    // Defensive: a SELECT against `now()` cannot return zero rows in any
    // sane Postgres state, but the type system insists.
    throw new Error('SELECT now() returned no rows');
  }
  // bun-sql / typed selects already give `Date`; postgres-js raw execute
  // gives a string. Both shapes are accepted by the `Date` constructor.
  return first.now instanceof Date ? first.now : new Date(first.now);
};

const listsRoute = createRoute({
  method: 'get',
  path: '/lists',
  tags: ['sync'],
  summary: 'Lists changed since the cursor (including tombstones)',
  security: [{ bearerAuth: [] }],
  request: {
    query: SinceQuery,
  },
  responses: {
    200: {
      description: 'Lists touched after `since` for the caller; tombstones included',
      content: { 'application/json': { schema: SyncListsResponse } },
    },
    400: {
      description: 'Invalid `since` (not ISO8601)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const itemsRoute = createRoute({
  method: 'get',
  path: '/items',
  tags: ['sync'],
  summary: 'Items changed since the cursor across the caller’s lists',
  security: [{ bearerAuth: [] }],
  request: { query: SinceQuery },
  responses: {
    200: {
      description: 'Items touched after `since` in lists where the caller is an active member',
      content: { 'application/json': { schema: SyncItemsResponse } },
    },
    400: {
      description: 'Invalid `since` (not ISO8601)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const listMembersRoute = createRoute({
  method: 'get',
  path: '/list_members',
  tags: ['sync'],
  summary: 'Membership rows changed since the cursor (including own revocations)',
  security: [{ bearerAuth: [] }],
  request: { query: SinceQuery },
  responses: {
    200: {
      description:
        'Member rows touched after `since`: the caller’s own (active or tombstoned) plus other members of lists the caller is currently in',
      content: { 'application/json': { schema: SyncListMembersResponse } },
    },
    400: {
      description: 'Invalid `since` (not ISO8601)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// `since` defaults to epoch when omitted. epoch (1970) reliably precedes any
// real `updated_at` and is the simplest "give me everything" semantics for
// the first sync after a fresh install.
const EPOCH = new Date(0);

const parseSince = (raw: string | undefined): Date => (raw ? new Date(raw) : EPOCH);

export const buildSyncRoutes = (db: Database): OpenAPIHono<Env> => {
  // Subapp needs its own validation hook for the same reason auth does —
  // `defaultHook` is per-OpenAPIHono-instance, not inherited.
  const syncRoutes = new OpenAPIHono<Env>({ defaultHook: validationHook });

  // Every sync endpoint is authenticated. Mounting `requireAuth()` on `*`
  // is more robust than per-route mounting — a future endpoint added to
  // this subapp inherits auth automatically rather than relying on the
  // implementer to remember.
  syncRoutes.use('*', requireAuth());

  // Bearer auth scheme registration so Swagger UI can offer the "Authorize"
  // button; the auth subapp registers the same component, but a second
  // registration on this subapp is harmless and keeps each subapp self-
  // contained. The OpenAPI generator de-duplicates components by name.
  syncRoutes.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  // Each handler captures `serverTime` before the read (header-rationale
  // above), runs the membership-scoped query, and serializes Date columns
  // to ISO8601 strings explicitly. We don't lean on Hono's automatic
  // `JSON.stringify` Date-coercion because the response Zod schema declares
  // `string` (date-time) for those fields — keeping the wire shape and the
  // schema in alignment is what makes the OpenAPI doc trustworthy.
  syncRoutes.openapi(listsRoute, async (c) => {
    const userId = c.get('userId');
    const { since } = c.req.valid('query');
    const serverTime = await dbNow(db);
    const rows = await listsSince(db, userId, parseSince(since));
    return c.json(
      {
        serverTime: serverTime.toISOString(),
        rows: rows.map(toListDTO),
      },
      200,
    );
  });

  syncRoutes.openapi(itemsRoute, async (c) => {
    const userId = c.get('userId');
    const { since } = c.req.valid('query');
    const serverTime = await dbNow(db);
    const rows = await itemsSince(db, userId, parseSince(since));
    return c.json(
      {
        serverTime: serverTime.toISOString(),
        rows: rows.map(toItemDTO),
      },
      200,
    );
  });

  syncRoutes.openapi(listMembersRoute, async (c) => {
    const userId = c.get('userId');
    const { since } = c.req.valid('query');
    const serverTime = await dbNow(db);
    const rows = await membersSince(db, userId, parseSince(since));
    return c.json(
      {
        serverTime: serverTime.toISOString(),
        rows: rows.map(toListMemberDTO),
      },
      200,
    );
  });

  return syncRoutes;
};

// DB-row → wire-DTO converters. We hand-write these (instead of leaning on
// JSON.stringify's automatic Date-toISO behavior) so the wire shape is
// explicit at the boundary, easy to grep when tracing field changes, and
// type-checked against the response schema. Any field rename in the DB
// surfaces as a TS error here rather than as a silent omission on the wire.

const toListDTO = (r: List) => ({
  id: r.id,
  name: r.name,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
});

const toItemDTO = (r: Item) => ({
  id: r.id,
  listId: r.listId,
  text: r.text,
  // The DB column is `checked_at` mapped to the `checked` field — `null`
  // for unchecked, ISO timestamp once checked. Pass-through preserves the
  // when-was-it-checked information for any UI that wants to render it.
  checked: r.checked ? r.checked.toISOString() : null,
  position: r.position,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
});

const toListMemberDTO = (r: ListMember) => ({
  listId: r.listId,
  userId: r.userId,
  role: r.role,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
});
