# Sync protocol

The contract between the backend and any sync-engine client (iOS/Android).
Phase 7 builds this incrementally — this document grows as each slice lands.

This is **not** an architecture overview. PLAN.md owns the "why we have a
sync engine at all" framing. This file is the wire-level reference: every
endpoint, every header, every status code, every edge case the client has
to handle. If something here is wrong, the client will be wrong.

---

## Status

| Slice | Status | What it adds |
| ----- | ------ | ------------ |
| A — read side: `?since=` for lists/items/list_members | **Landed** (2026-05-05) | Cursor-based pull; tombstones; membership-scoped privacy |
| B — iOS sync engine skeleton | Pending | First real consumer of slice A |
| C — write side: `If-Match` conditional updates + idempotent `POST` | Pending | Mutations + LWW conflict path |
| D — tombstone fuzz + learning doc | Pending | Phase-completion deliverables |

If you're implementing slice B (or porting later to Android), the contract
covered by slice A is below. Slice C/D are not specified yet — they will be
added here when their behavior is locked down by tests.

---

## Cursor model

Every sync pull returns a `serverTime` string. The client passes the most
recent `serverTime` it received back as the `since` parameter on the next
pull. The server's clock is the only one that defines truth — the client
never computes a cursor itself.

```
client                                server
───────────────────────────────────────────────
GET /sync/lists                  ──▶  
                                       SELECT date_trunc('ms', now()) AS t
                                       SELECT * FROM lists WHERE updated_at > epoch ...
                                 ◀──   { serverTime: t, rows: [...] }
(persist t locally as `lastSyncedAt`)

(time passes, writes happen)

GET /sync/lists?since=<t>        ──▶  
                                       SELECT date_trunc('ms', now()) AS t2
                                       SELECT * FROM lists WHERE updated_at > t ...
                                 ◀──   { serverTime: t2, rows: [...new...] }
```

### Why the server vouches for the cursor

A naive design would have the client compute the next cursor as
`max(updated_at over received rows)`. That fails in two ways:

1. **Empty pull.** No rows came back → there is no max. The client now has
   to fall back to its own clock or persist the previous cursor verbatim.
   Either path leaks complexity into every client.

2. **Precision drift across languages.** Postgres `timestamptz` natively
   stores microseconds. JS `Date`, Swift `Date`, and Kotlin `Instant` are
   all millisecond-precision. A client receiving `updated_at` and echoing
   it back loses the sub-millisecond bits, and `>` filtering can re-stream
   the row that was supposed to be at-the-cursor.

The Phase 7 fix is two-pronged:

- The `set_updated_at()` trigger truncates to milliseconds (see
  `drizzle/0002_truncate_updated_at_ms.sql`). All sides agree on the
  precision of stored timestamps.
- The cursor returned to clients is `serverTime`, captured by the server
  via `SELECT date_trunc('milliseconds', now())` *before* the SELECT
  runs. Clients never derive cursors from row data.

### Why `serverTime` is captured BEFORE the SELECT

A write that commits *during* the SELECT is invisible to the SELECT's
snapshot but its `updated_at` is necessarily later than the captured
`serverTime`. The next pull (`since=serverTime`) will surface it.

Capturing AFTER the SELECT would break this: a write committing between
SELECT-end and `now()`-call would have `updated_at < serverTime` and
the client would never see it. Silent corruption.

The trade is: a pull with no concurrent writes returns rows whose maximum
`updated_at` may be slightly less than `serverTime`. That just means a
follow-up pull with `since=serverTime` may surface no new rows — fine,
that's the intended idle case. The other direction (missed rows) is what
we cannot tolerate.

### Tie-breaking under same-millisecond writes

Two writes within the same millisecond produce the same `updated_at` and
the order between them is ambiguous. Both rows still surface on the next
pull (`>` is the comparison). Clients should:

- Treat the receive order as ambiguous.
- Apply LWW (last-write-wins) per row id, comparing `updated_at` directly.
  When equal, fall back to UUID v7 ordering (UUID v7 ids embed
  millisecond timestamps with random bits as tiebreakers — sorting by id
  is stable and approximates write order).

For a 3-user app the same-ms collision rate is negligible; the
specification exists so slice B can write its merge logic against an
unambiguous rule.

---

## Authentication

All sync endpoints require `Authorization: Bearer <access_token>`. The
token is the JWT from `/auth/login` or `/auth/refresh` — same machinery
as `/auth/me`. Failures (missing, malformed, expired, signature-invalid)
all return `401`. The client's existing 401-handling/refresh path is the
right response: refresh and retry.

---

## Endpoints

### `GET /sync/lists?since=<ISO8601>`

Returns lists the caller is currently a member of, INCLUDING soft-deleted
("tombstoned") rows, where `updated_at > since`.

**Query parameter**

- `since` — optional ISO8601 datetime with timezone (e.g.
  `2026-05-05T12:34:56.789Z`). Omitted ⇒ epoch (return everything from
  the dawn of time).

**Response 200**

```json
{
  "serverTime": "2026-05-05T12:34:57.001Z",
  "rows": [
    {
      "id": "019470fd-…",
      "name": "Groceries",
      "createdBy": "019470fd-…",
      "createdAt": "2026-04-01T08:00:00.000Z",
      "updatedAt": "2026-05-05T12:00:00.000Z",
      "deletedAt": null
    },
    {
      "id": "019470fd-…",
      "name": "Old list",
      "createdBy": "019470fd-…",
      "createdAt": "2026-03-12T12:00:00.000Z",
      "updatedAt": "2026-05-04T22:00:00.000Z",
      "deletedAt": "2026-05-04T22:00:00.000Z"
    }
  ]
}
```

**Other responses**

- `400` — invalid `since` (not parseable as ISO8601). Standard error envelope.
- `401` — missing / invalid bearer.

**Membership scoping**

The caller sees lists where they are a *currently active* member
(`list_members.deleted_at IS NULL` for that user). A user revoked from a
list immediately stops receiving subsequent updates to that list — the
revocation itself surfaces via `GET /sync/list_members` instead.

This means a list-rename that lands in the same write window as a
member-revocation will not reach the revoked user. They learn about the
revocation from the members feed and drop the list locally — the correct
end state regardless.

### `GET /sync/items?since=<ISO8601>`

Returns items in any list the caller is currently a member of, INCLUDING
tombstones. Same `serverTime`/`since` semantics as `/sync/lists`.

**Response shape**

```json
{
  "serverTime": "...",
  "rows": [
    {
      "id": "...",
      "listId": "...",
      "text": "milk",
      "checked": null,                              // ISO string when checked, null otherwise
      "position": 1,
      "createdBy": "...",
      "createdAt": "...",
      "updatedAt": "...",
      "deletedAt": null
    }
  ]
}
```

`checked` is the timestamp the item was checked off (or `null`). The
boolean question "is this item checked?" is `checked != null`. Phase 13
will revisit whether the wire format should expose the timestamp or just
a boolean — for now the timestamp is preserved end-to-end so a future
"checked at 4:32pm" UI doesn't need a schema migration.

`position` is a plain integer; concurrent reorders resolve LWW and may
produce a visible glitch. PLAN.md L165 documents this trade-off.

**Membership scoping**: same as `/sync/lists`. Items in lists the caller
was revoked from do not surface.

### `GET /sync/list_members?since=<ISO8601>`

The most subtle of the three feeds. Returns membership rows the caller
"has a stake in":

1. The caller's *own* membership rows for any list, active or tombstoned.
   Surfaces self-revocations: a caller's tombstoned membership is the
   signal the client uses to drop the list locally.

2. *Other* members' rows for lists where the caller is currently an
   active member. Lets the client render "people in this list" and keep
   it fresh. Once the caller is revoked from a list (case 1 fires), they
   stop seeing further changes to that list's member set.

**Response shape**

```json
{
  "serverTime": "...",
  "rows": [
    {
      "listId": "...",
      "userId": "...",
      "role": "owner" | "editor",
      "createdAt": "...",
      "updatedAt": "...",
      "deletedAt": null
    }
  ]
}
```

There is no `id` field — `(listId, userId)` is the composite primary
key in the database, and clients should index local membership state on
the same pair.

---

## Reconciliation algorithm (recommended, not enforced)

Sketch of how a client should consume these feeds. Slice B will lock this
down with code; this is the design intent.

```
on every reconciliation tick (launch, foreground, post-WS-reconnect):

  // 1. Pull lists.
  let listsResp = GET /sync/lists?since=lastSyncedLists
  for each row in listsResp.rows:
    if row.deletedAt != null:
      remove local list with row.id
    else:
      upsert local list (LWW: only overwrite if row.updatedAt > local.updatedAt)
  lastSyncedLists = listsResp.serverTime

  // 2. Pull items.  (Same shape.)
  ...

  // 3. Pull memberships. Includes revocation tombstones.
  let memResp = GET /sync/list_members?since=lastSyncedMembers
  for each row in memResp.rows:
    if row.userId == self && row.deletedAt != null:
      remove local list (row.listId) entirely + its items + its other members
    else if row.deletedAt != null:
      remove the (row.listId, row.userId) member row
    else:
      upsert (LWW)
  lastSyncedMembers = memResp.serverTime
```

Order matters: pull lists first, items second, members third. A revocation
encountered in step 3 would otherwise race the rendering of items that
just arrived in step 2 — putting the membership pull last guarantees the
"drop everything for this list" sweep happens after any leftover rows
have landed, so the cleanup is consistent.

---

## Things this protocol does NOT do

Documented for the slice-B implementer so they don't expect them:

- **No pagination.** All matching rows return in one response. For a
  3-user grocery-list app the working set is small enough that this is
  fine; revisit at Phase 18 if real data ever proves otherwise.
- **No deltas, only snapshots.** Each row in the response is the *current*
  full row, not a patch. Clients merge by id with LWW.
- **No row count cap.** First-sync after a fresh install can return
  arbitrarily many rows (limited only by the tables' actual contents).
- **No order guarantee.** `rows` may arrive in any order. Sort locally
  on `updated_at` if you need to.

---

## Test reference

Behaviors this document specifies are pinned by tests:

- Repo layer (SQL semantics):
  - `src/features/lists/repo.test.ts` — `listsSince` membership scoping,
    tombstones, strict-greater-than cursor.
  - `src/features/items/repo.test.ts` — `itemsSince` cross-list, cross-user
    privacy, cursor.
  - `src/features/list-members/repo.test.ts` — `membersSince` self-tombstone
    visibility, "other members" visibility, post-revocation scoping.
- HTTP layer (wire contract):
  - `src/features/sync/integration.test.ts` — auth, validation,
    `serverTime` round-trip, tombstone field shape.

When the protocol changes, update both this doc and the relevant tests in
the same PR. A doc that drifts from tests is worse than no doc.
