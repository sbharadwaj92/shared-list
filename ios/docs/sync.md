# iOS sync engine

The architecture of the iOS sync engine — how the seven files in
`SharedList/Core/Sync/` combine to give the app offline-first lists with
last-write-wins (LWW) reconciliation against the backend.

This is **not** the wire protocol. `backend/docs/sync.md` is the source
of truth on what bytes go over the wire. This file is the iOS-specific
"how does it work end-to-end" — read this if you want to understand the
local mutation flow without grepping eight source files.

---

## What it does, in one paragraph

Every user action goes through `Mutator`, which writes the local row
AND a queue entry in one SwiftData transaction. `Drainer` polls the
queue and translates each entry into an HTTP request via `APIClient`.
On success, the entry is deleted; on a 409 (server has newer state),
`SyncEngine.reconcile()` pulls the canonical row from `?since=`,
folds it in via LWW, and the drainer retries the original mutation
once with the refreshed `If-Match`. `NetworkMonitor` gates whether
the drainer attempts work at all; offline mutations stay in the
queue until reconnect. `SyncEngine.reconcile()` runs at app launch,
on foreground (Phase 11+), and after a 409 — pulling lists, items,
and memberships in that order, applying tombstones and self-
revocation sweeps as it goes.

---

## File map

| File | Role |
| ---- | ---- |
| `Models.swift` | SwiftData `@Model` classes for `UserModel`, `ListModel`, `ItemModel`, `MemberModel`, `SyncCursor`, `MutationQueueEntry`. |
| `SyncDTOs.swift` | Codable wire DTOs — what the backend sends. Match `backend/src/features/sync/dto.ts` exactly. |
| `NetworkMonitor.swift` | `@Observable @MainActor` wrapper around `NWPathMonitor`. Exposes `isOnline: Bool`. `MockNetworkMonitor` for tests. |
| `SyncEngine.swift` | Read-side reconciler. `reconcile()` pulls lists, items, members in order; LWW upsert; self-revocation sweep. Also exposes `internal upsertListLWW` / `upsertItemLWW` for the drainer's 409 path. |
| `Mutator.swift` | Every user action goes here. Atomic local-apply + queue-append in one SwiftData save. |
| `Drainer.swift` | Polls the queue, sends HTTP, handles 2xx/401/404/403/409/5xx. `kick()` fires from Mutator post-save and on `NetworkMonitor.isOnline` flips. |
| `*IntegrationTests.swift` (in `SharedListTests/`) | Env-gated tests that drive the full stack against a real backend. |

---

## Layer diagram

```
                 ┌────────────────────────┐
   user action ─▶│      Mutator           │── local row + queue entry ──▶ SwiftData
                 │  (one save() commits   │       (one transaction)
                 │   both rows atomically)│
                 └─────────┬──────────────┘
                           │ kick()
                           ▼
                 ┌────────────────────────┐
                 │       Drainer          │
                 │ — polls queue          │
                 │ — sends via APIClient  │── HTTP ──▶ backend
                 │ — 409 → SyncEngine     │
                 │   .upsert*LWW + retry  │
                 └─────────┬──────────────┘
                           │ on 409 reconciliation
                           ▼
                 ┌────────────────────────┐
                 │      SyncEngine        │
                 │ — reconcile() pulls    │
                 │   /sync/{lists,items,  │── HTTP ──▶ backend
                 │   list_members}        │
                 │ — LWW upsert / delete  │
                 └────────────────────────┘
                           ▲
                           │ (also called at app launch
                           │  and on foreground in
                           │  Phase 11+)
```

---

## The two-rows-one-save invariant

The single most important rule in `Mutator`:

```swift
context.insert(localRow)           // ← row 1 (UI sees this)
context.insert(MutationQueueEntry  // ← row 2 (drainer sees this)
context.insert(...))
try context.save()                 // commit point — both or neither
```

If we wrote the local row, called `save()`, then enqueued, a crash
between the two saves would leave the local row visible without ever
sending the change to the server. A future reconcile would pull the
canonical (un-mutated) row from `?since=` and overwrite the user's
"saved" change. Silent data loss.

Two rows in one save means there is no intermediate state where one
exists and the other doesn't. SwiftData's transaction either commits
both or neither.

This pairs with the backend's idempotent `POST` (client-owned UUID v7)
and `If-Match` PATCH: the queue entry can be retried indefinitely
without double-effect, because the wire side is idempotent.

---

## Optimistic local-apply

`Mutator.createList(name:)` returns the new list's `id` *immediately*
after the SwiftData save. The view layer reads SwiftData via `@Query`
and re-renders within one frame. The user perceives the action as
instant, regardless of network.

The local row is pre-stamped to `clock.now()` (the test seam — `SystemClock`
in production) so that:

- The `LWW` guard in `SyncEngine.upsertListLWW` correctly resolves an at-
  the-cursor server response without overwriting the user's optimistic
  state. Both sides compare `updatedAt`; the server's incoming row is
  *equal-or-older* than the local one we just stamped, so the local one
  wins and the optimistic UI stays stable until the server's actual
  newer-than-now `updated_at` arrives on the next reconcile.
- The drainer can capture the prior-`updatedAt` as the `If-Match`
  header, satisfying the backend's CAS predicate without a separate
  GET.

The local apply is "optimistic" because we don't know yet whether the
server will accept it (network, 409, 403). If it doesn't, the next
reconcile pulls the canonical truth and LWW resolves; the user sees
their change get reverted.

---

## Mutation queue — persistent, ordered, idempotent

`MutationQueueEntry` rows live in SwiftData (the same store as the
domain models, deliberately). Each entry has:

- `id` — UUID; the queue's own row id, separate from the target id.
- `opType` — string-encoded enum: `createList`, `renameList`, `deleteList`, `createItem`, `patchItem`, `deleteItem`.
- `targetId` — the id of the list/item the operation targets. The drainer derives the URL path from this.
- `payload` — JSON-encoded `*Payload` struct. The drainer decodes per opType and uses it as the request body.
- `createdAt` — pre-stamped at enqueue time. The drainer processes oldest-first.
- `status` — `pending` / `inFlight` / `failed`. `inFlight` rows are reset to `pending` on Drainer init (in case a previous run crashed mid-request).
- `retryCount` — bumped on transient failures (network, 5xx).

Why SwiftData (not a separate sqlite, not `URLSession`'s background
task):

- **Atomic with local-apply.** The two-rows-one-save invariant requires
  the queue and the domain rows to live in the same store. A separate
  store would give us two transactions, two commit points, two failure
  modes.
- **Survives restart.** `URLSession.background` would survive process
  exit, but the queue-as-source-of-truth model is stronger — a queue
  entry is *the* representation of intent until it's drained, full
  stop. There's no "this URLSession task got stuck" debugging path.
- **Single mental model.** The drainer reads the queue the same way
  any feature view reads `ListModel`s — through SwiftData's
  `FetchDescriptor`. No bespoke task observer.

---

## The drainer's 409 dance

The richest behavior in the whole engine. When a PATCH fails with 409:

1. The server's response body carries the `latest` row (the canonical
   current state).
2. The drainer parses `latest` and applies it through
   `SyncEngine.upsertListLWW` (or `upsertItemLWW`). This is the same
   merge logic the read-side reconciler uses — the local row gets the
   server's content if and only if `latest.updatedAt > local.updatedAt`.
   Critically, our optimistic local edit's `updatedAt` is *before* the
   user's tap (it was pre-stamped at call time to "now"), so the
   server's `latest.updatedAt` (post-conflicting-write on the other
   device) is newer and wins.
3. The drainer rebuilds the request body using the now-merged local
   row's data, with `If-Match` set to the new local `updatedAt`.
4. One retry. If that retries 409s too, the entry is marked `failed`
   with `lastError = "concurrent edits"`. The user sees no resolution
   — their change is gone, replaced by the server's truth. UI in
   later phases will surface this; for now it's a logged failure.

A retry-once cap is deliberate. Retry-N-times under high contention
would create cascading failures that look like a stuck queue. One
retry covers the realistic case (two devices wrote within seconds of
each other); persistent contention is something the app developer
should see, not silently absorb.

---

## Self-revocation sweep

The most subtle path in `SyncEngine`. When the read-side reconcile
encounters a `members` row where `userId == self && deletedAt != nil`,
it doesn't just remove that one row — it sweeps:

```swift
// Pseudocode in SyncEngine.sweepLocalList
let listId = revokedRow.listId
context.delete(listModel(id: listId))
context.delete(every itemModel where listId == listId)
context.delete(every memberModel where listId == listId)
```

This is the "I was kicked from this list" path. The list's other
members were never tombstoned (no reason to be), so they'd linger
without this sweep. The items in the list would similarly remain. The
sweep guarantees that after revocation, no rows from that list exist
locally — the only way to see them again is to be re-invited.

The membership feed runs LAST in the reconcile order (`lists` → `items`
→ `members`). Putting it last guarantees the sweep happens after any
leftover items/members rows that arrived in steps 1+2 — so the cleanup
is consistent regardless of intra-pull race conditions.

---

## Test seams

Every non-deterministic dependency is injected behind a protocol:

| Seam | Production | Test stand-in |
| ---- | ---------- | ------------- |
| `Clock` | `SystemClock` (`Date()`) | `FixedClock`, `AdvancingClock` |
| `UUIDGenerating` | `SystemUUIDGenerator` | `SequenceUUIDGenerator` |
| `NetworkMonitoring` | `NetworkMonitor` (`NWPathMonitor`) | `MockNetworkMonitor` |
| `URLSession` (in `APIClient`) | shared session | `MockSession` (records requests, returns scripted responses) |
| `ModelContainer` | on-disk SwiftData | in-memory configuration |

Without these, asserting on "did the queue row's `createdAt` match the
local row's `updatedAt`?" would require sleep-and-poll tactics. With
them, the test reads as "set the clock to T, do the action, read the
two rows, assert both are T." Deterministic and fast.

The `DrainerIntegrationTests` and `CrossPlatformConvergenceTests`
deliberately bypass the mock seams for `URLSession` — they want to
exercise the real wire protocol against a real backend.
`MockNetworkMonitor` and the in-memory `ModelContainer` stay even in
those tests, because the *intent* is "test that the wire contract
works," not "test that NWPathMonitor reports the right thing."

---

## Cross-platform parity (Phase 8 → Phase 9)

The Android port (`android/docs/sync.md`) mirrors this design layer-by-
layer. Differences are documented there, but in summary:

- SwiftData's `@Model` ↔ Room's `@Entity` + `@Dao`. Room is more
  ceremonial (DAO interfaces vs. SwiftData's implicit context API)
  but supports composite primary keys natively, which lets
  `MemberEntity` use `(listId, userId)` directly instead of iOS's
  pipe-joined string workaround.
- `@Observable` ↔ `StateFlow<UiState>`. Both are observable-by-
  property; the Compose / SwiftUI render layer subscribes uniformly.
- `URLSession` + `RefreshCoordinator actor` ↔ Ktor + `Mutex` +
  `CompletableDeferred`. Different idioms, same single-flight-
  refresh contract.
- Foundation's default `JSONEncoder.dateEncodingStrategy = .iso8601`
  is second-precision and silently truncates fractional seconds —
  the iOS sync engine had to write a `JSONCoders` module with a
  `withFractionalSeconds`-aware ISO8601 formatter. Android's
  kotlinx-serialization had a parallel issue with `Instant.toString()`
  zero-truncation; both platforms ship custom serializers documented
  in their respective files.

Phase 9's `CrossPlatformConvergenceTests` are the harness that proves
this parity holds: iOS-A and Android-B (and vice versa) acting on a
shared backend converge on identical local state, scenario by scenario.

---

## Things this engine does NOT do

Documented for the next-phase implementer:

- **No optimistic conflict UI.** A 409 that the retry-once couldn't
  resolve fails silently in the queue. Phase 18 (sync hardening)
  introduces a "stale data" indicator and per-entry retry surface.
- **No background drain when the app is suspended.** `BGAppRefreshTask`
  is explicitly out-of-scope per PLAN.md. Drain happens on launch,
  foreground (Phase 11+), and after Mutator calls.
- **No deltas, only full rows.** The wire format is snapshot-based;
  the engine merges by id with LWW. This matches the backend's
  read feed behavior.
- **No fractional-position reorders.** Items use plain integer
  positions; concurrent reorders may produce a visible glitch.
  PLAN.md L165 documents the trade-off.
