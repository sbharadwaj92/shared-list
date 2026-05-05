# Android sync engine

The architecture of the Android sync engine — how the seven files in
`app/src/main/java/in/santosh_bharadwaj/sharedlist/core/sync/` combine
to give the app offline-first lists with last-write-wins (LWW)
reconciliation against the backend.

This is **not** the wire protocol. `backend/docs/sync.md` is the source
of truth on what bytes go over the wire. This file is the Android-
specific "how does it work end-to-end" — read this if you want to
understand the local mutation flow without grepping eight source files.

The design intentionally mirrors the iOS sync engine
(`ios/docs/sync.md`); read that first if you want the conceptual
overview. This file focuses on Android-specific divergences and
Kotlin-/Room-specific gotchas.

---

## What it does, in one paragraph

Every user action goes through `Mutator`, which writes the local row
AND a queue entry in one Room transaction (`database.withTransaction
{ ... }`). `Drainer` polls the queue and translates each entry into an
HTTP request via `ApiClient`. On success, the entry is deleted; on a
409 (server has newer state), `SyncEngine.reconcile()` pulls the
canonical row from `?since=`, folds it in via LWW, and the drainer
retries the original mutation once with the refreshed `If-Match`.
`NetworkMonitor` wraps `ConnectivityManager.NetworkCallback` and
exposes `StateFlow<Boolean>`; offline mutations stay in the queue
until reconnect. `SyncEngine.reconcile()` runs at app launch, on
foreground (Phase 12+), and after a 409 — pulling lists, items, and
memberships in that order, applying tombstones and self-revocation
sweeps as it goes.

---

## File map

| File | Role |
| ---- | ---- |
| `SyncEntities.kt` | Room `@Entity` classes for `UserEntity`, `ListEntity`, `ItemEntity`, `MemberEntity`, `SyncCursorEntity`, `MutationQueueEntity`. |
| `SyncDtos.kt` | kotlinx.serialization `@Serializable` wire DTOs. Match `backend/src/features/sync/dto.ts` exactly. |
| `JsonCoders.kt` | Shared `Json` instance with custom `InstantIso8601MillisSerializer` — fixed-3-digit fractional seconds, lenient parse. Front-loaded fix for the Foundation/.iso8601 trap on iOS, made explicit on Android. |
| `SyncDao.kt` | Room DAO interfaces (`UserDao`, `ListDao`, `ItemDao`, `MemberDao`, `SyncCursorDao`, `MutationQueueDao`). |
| `SyncDatabase.kt` | `@Database` Room class. Exposes the DAOs + `inMemory(context)` for tests. |
| `SyncTypeConverters.kt` | Room `@TypeConverter` for `Instant` ↔ `Long` (epoch millis). |
| `NetworkMonitor.kt` | `NetworkMonitoring` interface; production impl wraps `ConnectivityManager.NetworkCallback`. `FakeNetworkMonitor` for tests. |
| `SyncEngine.kt` | Read-side reconciler. `reconcile()` pulls lists, items, members in order; LWW upsert; self-revocation sweep wrapped in `database.withTransaction`. Also exposes `internal upsertListLww` / `upsertItemLww` for the drainer's 409 path. |
| `Mutator.kt` | Every user action goes here. Atomic local-apply + queue-append in one Room transaction. |
| `Drainer.kt` | Polls the queue, sends HTTP, handles 2xx/401/404/403/409/5xx. `kick()` fires from Mutator post-save and on `NetworkMonitor.isOnline` flips. |

---

## Layer diagram

(Identical to iOS; reproduced here so this doc is self-contained.)

```
                 ┌────────────────────────┐
   user action ─▶│      Mutator           │── local row + queue entry ──▶ Room
                 │  (one withTransaction  │       (one transaction)
                 │   commits both rows)   │
                 └─────────┬──────────────┘
                           │ kick()
                           ▼
                 ┌────────────────────────┐
                 │       Drainer          │
                 │ — polls queue          │
                 │ — sends via ApiClient  │── HTTP ──▶ backend
                 │ — 409 → SyncEngine     │
                 │   .upsert*Lww + retry  │
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
                           │  Phase 12+)
```

---

## The two-rows-one-save invariant

Same rule as iOS, expressed via Room's `withTransaction`:

```kotlin
database.withTransaction {
    listDao.upsert(localRow)               // row 1 (UI sees this)
    mutationQueueDao.insert(queueRow)      // row 2 (drainer sees this)
}
```

If we wrote the local row outside a transaction, called the queue
insert separately, and the second call failed, the local row would be
visible without ever sending the change to the server. A future
reconcile would pull the canonical (un-mutated) row from `?since=` and
overwrite the user's "saved" change. Silent data loss.

`database.withTransaction { }` is the database-level extension function
(not the per-`@Dao` `@Transaction` annotation). Per-DAO `@Transaction`
methods can't compose cross-DAO writes cleanly because Room generates
each DAO as an independent class. The database extension wraps both
`listDao.upsert` and `mutationQueueDao.insert` in one BEGIN/COMMIT
boundary, exactly the iOS behavior with a single `context.save()`.

---

## Optimistic local-apply

`Mutator.createList(name)` returns the new list's `id` *immediately*
after the Room transaction commits. The view layer reads from a
`StateFlow` backed by the DAO's `Flow<List<ListEntity>>`, and Compose
recomposes within one frame. Same UX as iOS.

The local row is pre-stamped to `clock.now()` (test seam — `SystemClock`
in production) so that:

- The LWW guard in `SyncEngine.upsertListLww` correctly resolves an
  at-the-cursor server response without overwriting the user's
  optimistic state.
- The drainer captures the prior `updatedAt` as the `If-Match`
  header, satisfying the backend's CAS predicate.

---

## Mutation queue

Same shape as iOS's `MutationQueueEntry`, expressed as Room
`MutationQueueEntity`:

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `String` (UUID) | Queue's own row id, separate from `targetId`. |
| `opType` | `String` | `createList` / `renameList` / `deleteList` / `createItem` / `patchItem` / `deleteItem` |
| `targetId` | `String` | List or item id the operation targets. |
| `payload` | `String` (JSON) | kotlinx.serialization-encoded; the drainer decodes per `opType`. |
| `createdAt` | `Instant` (millis) | Pre-stamped; oldest first. |
| `status` | `String` | `pending` / `inFlight` / `failed`. |
| `retryCount` | `Int` | Bumped on transient failures. |
| `lastError` | `String?` | Set when `status = failed`. |

Stale `inFlight` rows are reset to `pending` at Drainer init via
`MutationQueueDao.resetStaleInFlight()` — an `inFlight` row at startup
means a previous run crashed mid-request, and the safe action is to
retry.

Why Room (not DataStore, not SharedPreferences):

- **Atomic with local-apply.** The two-rows-one-save invariant
  requires the queue and the domain rows to live in the same store.
- **Survives restart.** Room writes go through SQLite, persisted to
  disk before `withTransaction` returns.
- **Single mental model.** The drainer reads the queue the same way
  any feature ViewModel reads `ListEntity`s — through DAO interfaces.

---

## The drainer's 409 dance

Identical contract to iOS:

1. Server responds 409 with `{ error, latest: <DTO> }`.
2. Drainer parses `latest` and calls `SyncEngine.upsertListLww(latest)`
   (or `upsertItemLww`). Same merge logic the read-side reconciler
   uses.
3. Drainer rebuilds the request body using the now-merged local row
   (the LWW upsert may or may not have written through, depending on
   whether `latest.updatedAt > local.updatedAt`).
4. One retry. If 409s again → mark `failed` with `lastError = "concurrent edits"`.

The `internal` keyword on `upsertListLww` / `upsertItemLww` exposes
them inside the module without making them part of the public API
surface — same as iOS's `internal access`. Production code should not
call these directly; only the reconciler and the drainer's 409 path
do.

---

## Self-revocation sweep — wrapped in `withTransaction`

The "I was kicked from this list" path, identical to iOS but
wrapped in a Room transaction:

```kotlin
database.withTransaction {
    listDao.deleteById(listId)
    itemDao.deleteByListId(listId)
    memberDao.deleteByListId(listId)
}
```

Three separate DAO deletes in one transaction. If we did them
individually, a process kill between the first and second delete would
leave items orphaned (their parent list gone, their `listId` pointing
at nothing). The transaction ensures all-or-none. `withTransaction`
is the database extension (same one Mutator uses), not per-DAO
`@Transaction`.

---

## Test seams

| Seam | Production | Test stand-in |
| ---- | ---------- | ------------- |
| `Clock` | `SystemClock` (`Clock.System.now()`) | `FixedClock`, `AdvancingClock` |
| `UuidGenerating` | `SystemUuidGenerator` | `SequenceUuidGenerator` |
| `NetworkMonitoring` | `NetworkMonitor` (ConnectivityManager) | `FakeNetworkMonitor` |
| `HttpClient` (in `ApiClient`) | OkHttp engine | Ktor `MockEngine` |
| `SyncDatabase` | on-disk Room | `SyncDatabase.inMemory(context)` |

`runTest` from `kotlinx-coroutines-test` runs the test body on a
deterministic scheduler. Rooms's suspending DAO calls and the
Drainer's `Mutex.withLock { }` block both Just Work under `runTest`
*provided* you don't accidentally schedule onto a non-test dispatcher.

---

## Kotlin-/Room-specific subtleties

Things that differ from iOS in non-obvious ways:

### `Instant.toString()` zero-truncation

kotlinx.datetime's `Instant.toString()` strips trailing zero
fractional digits, matching the Foundation `.iso8601` trap on iOS:
`9000.001000Z` becomes `9000.001Z`, `9000.000Z` becomes `9000Z`. The
backend's `?since=` parser is strict about ISO8601 with timezone but
flexible on fractional digits, so reads still work — but on the wire
it makes Android's serialized `If-Match` look different from iOS's
for the same logical instant.

The fix lives in `JsonCoders.kt`:

```kotlin
private object InstantIso8601MillisSerializer : KSerializer<Instant> {
    override fun serialize(encoder: Encoder, value: Instant) {
        // Always emit exactly 3 fractional digits, including .000
        encoder.encodeString(formatWithFixedMillis(value))
    }
}
```

Used by the shared `Json` instance for every Instant field. Pinned by
`JsonCodersTest.writesExactlyThreeFractionalDigitsEvenForZero`.

### `runTest` + auto-kick race

The Mutator can be configured to `attachDrainer(drainer)` so every
mutation auto-kicks a drain. Production wires this. Tests using
`runTest`'s `TestScope` deliberately do NOT call `attachDrainer` —
the Mutator's auto-kick launches into the Drainer's own
`Dispatchers.IO`, which races with the test's explicit `tick()` from
`TestScope`. Both serialize through the Drainer's mutex, but
`tick()` returns early when the kicked tick is mid-request and the
queue assertion runs before the in-flight drain finishes.

The unit-scoped `DrainerTest` covers the attached path through
scripted scenarios; integration / fuzz / cross-platform tests that
need deterministic post-drain assertions skip `attachDrainer`.

### Composite primary keys

Room natively supports `@Entity(primaryKeys = ["listId", "userId"])`
on `MemberEntity`. iOS's SwiftData has no analog, so the iOS engine
synthesizes a `compositeKey: String = "\(listId)|\(userId)"` and
indexes on it. The Android implementation is cleaner here.

### `database.withTransaction` vs per-DAO `@Transaction`

`@Transaction` annotations on DAO methods give you a transaction
*within that DAO*. They don't compose across DAOs because Room
generates each DAO interface as an independent class. The
`database.withTransaction` extension function wraps any suspend block
in a single SQLite BEGIN/COMMIT — that's what Mutator and the self-
revocation sweep use. Keep it in mind: per-DAO `@Transaction`
suffices for a single DAO's multi-statement logic, but anything
cross-DAO needs the database-level extension.

---

## Cross-platform parity

The iOS sync engine (`ios/docs/sync.md`) is the design reference;
this Android port mirrors it layer-by-layer. The non-trivial
divergences are documented above. Phase 9's
`CrossPlatformConvergenceTest` is the harness that proves the parity
holds end-to-end against a real backend.

---

## Things this engine does NOT do

Same list as iOS (PLAN.md owns these decisions):

- **No optimistic conflict UI.** A 409 that the retry-once couldn't
  resolve fails silently in the queue. Phase 18 introduces a "stale
  data" indicator and per-entry retry surface.
- **No background drain when the app is in the background.**
  WorkManager is explicitly out-of-scope per PLAN.md. Drain happens on
  launch, foreground (Phase 12+), and after Mutator calls.
- **No deltas, only full rows.** The wire format is snapshot-based;
  the engine merges by id with LWW.
- **No fractional-position reorders.** Items use plain integer
  positions. PLAN.md L165 documents the trade-off.
