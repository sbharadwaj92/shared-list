import { z } from '@hono/zod-openapi';

// Zod schemas for the `?since=` sync feed.
//
// Three resource types share the same shape — a request with one query
// parameter (`since`, ISO8601) and a response with `serverTime` plus an
// array of rows. The actual row shapes differ (lists vs items vs members),
// so we factor out the envelope and parameterize the row schema per resource.
//
// Why ISO8601 strings on the wire instead of unix-millis numbers:
//   - human-readable in URL query params and Swagger UI
//   - timezone-explicit (the trailing Z)
//   - what `Date.toISOString()` produces by default in JS, what `Instant`
//     prints in Swift, what `Instant.toString()` produces in Kotlin —
//     no per-platform formatting to keep in sync
//
// The full distributed-systems story for `serverTime` and the cursor
// invariant lives in `backend/docs/sync.md`. The short version: the client
// always echoes back the `serverTime` it received last; the server's clock
// is the only one that defines truth. Clients never compute timestamps
// themselves for cursor purposes.

// `since` accepts an ISO8601 datetime string. We use Zod's built-in
// datetime check (matches the OpenAPI `format: date-time`) and transform
// to a Date so handlers don't reparse. `optional()` lets clients omit
// `since` to mean "give me everything from epoch" — the very first sync
// after a fresh install.
export const SinceQuery = z
  .object({
    since: z
      .string()
      .datetime({ offset: true, message: 'since must be ISO8601 with timezone' })
      .optional()
      .openapi({
        description:
          'High-water cursor returned as `serverTime` by the previous sync response. Omit on first sync to receive every row from epoch.',
        example: '2026-05-05T12:34:56.789Z',
      }),
  })
  .openapi('SinceQuery');

// Row shapes mirror the database columns. We hand-write these instead of
// auto-deriving from drizzle's `$inferSelect` because:
//   1. The wire shape is part of the protocol contract — it should change
//      only when we deliberately change the protocol, not when an internal
//      column rename happens (loose coupling).
//   2. Zod gives us `.openapi()` annotations and runtime validation on the
//      response shape, which the inferred type does not.
//
// Dates serialize as ISO8601 strings (Hono's `c.json()` calls `JSON.stringify`,
// which calls `Date.prototype.toJSON`, which is `toISOString()`). The schemas
// reflect that wire shape — string, not Date.
const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .openapi({ format: 'date-time', example: '2026-05-05T12:34:56.789Z' });

export const ListDTO = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdBy: z.uuid(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    // `null` (not omitted) when the row is alive. A non-null `deletedAt` IS
    // the tombstone signal — clients drop the row from local state on seeing
    // it, regardless of any other field changes.
    deletedAt: isoDateTime.nullable(),
  })
  .openapi('ListDTO');

export const ItemDTO = z
  .object({
    id: z.uuid(),
    listId: z.uuid(),
    text: z.string(),
    // `checked` in the DB is a `timestamp` column — null while unchecked,
    // set to the check-time when checked. We pass it through as-is so the
    // client can render "checked at 4:32pm" if they want; the boolean
    // "is checked?" question is `checked != null`.
    checked: isoDateTime.nullable(),
    position: z.number().int(),
    createdBy: z.uuid(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable(),
  })
  .openapi('ItemDTO');

export const ListMemberDTO = z
  .object({
    listId: z.uuid(),
    userId: z.uuid(),
    role: z.enum(['owner', 'editor']),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable(),
  })
  .openapi('ListMemberDTO');

// Response envelope. `serverTime` is the cursor for the NEXT pull — see
// `backend/docs/sync.md` for the full invariant. `rows` is the resource-
// specific payload.
//
// We expose three concrete response schemas (one per resource) instead of
// a single generic `SyncResponse<T>` because OpenAPI doesn't model generics
// — `@hono/zod-openapi` would have to register a fresh schema per resource
// anyway, so we may as well name them upfront.
export const SyncListsResponse = z
  .object({
    serverTime: isoDateTime.openapi({
      description: 'Pass back as `since` on the next sync request.',
    }),
    rows: z.array(ListDTO),
  })
  .openapi('SyncListsResponse');

export const SyncItemsResponse = z
  .object({
    serverTime: isoDateTime,
    rows: z.array(ItemDTO),
  })
  .openapi('SyncItemsResponse');

export const SyncListMembersResponse = z
  .object({
    serverTime: isoDateTime,
    rows: z.array(ListMemberDTO),
  })
  .openapi('SyncListMembersResponse');
