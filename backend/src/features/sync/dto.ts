import type { Item, List, ListMember } from '../../infra/schema.ts';

// DB-row → wire-DTO converters, shared between the read-side `?since=` feed
// (sync/routes.ts) and the write-side endpoints (lists/routes.ts,
// items/routes.ts).
//
// We hand-write these (rather than letting JSON.stringify auto-coerce Dates
// to ISO strings) so the wire shape is explicit at the boundary, easy to
// grep when tracing field changes, and type-checked against the response
// Zod schemas. Any column rename in the DB surfaces as a TS error here
// rather than as a silent omission on the wire.
//
// Sharing matters because POST /lists, PATCH /lists/:id, etc. must return
// the EXACT same shape as `GET /sync/lists` — clients deserialize both into
// the same `Decodable` type. A drift between two copies of these helpers
// would be a protocol bug visible only at runtime.

export const toListDTO = (r: List) => ({
  id: r.id,
  name: r.name,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
});

export const toItemDTO = (r: Item) => ({
  id: r.id,
  listId: r.listId,
  text: r.text,
  // The DB column is `checked_at` mapped to the `checked` field — `null` for
  // unchecked, ISO timestamp once checked. Pass-through preserves the
  // when-was-it-checked information for any UI that wants to render it.
  checked: r.checked ? r.checked.toISOString() : null,
  position: r.position,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
});

export const toListMemberDTO = (r: ListMember) => ({
  listId: r.listId,
  userId: r.userId,
  role: r.role,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
});
