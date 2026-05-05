package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.room.withTransaction
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import io.ktor.http.HttpMethod
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

// SyncEngine — slice B' (read-side reconciler).
//
// Single responsibility: pull `/sync/lists`, `/sync/items`, and
// `/sync/list_members` from the backend in that order, reconcile each batch
// into Room, and persist a per-resource `serverTime` cursor so the next
// reconcile picks up where this one left off.
//
// The drainer (slice C.3') will reuse [upsertListLww] / [upsertItemLww] for
// 409-→-reconcile-→-retry. Those are public-internal so the Drainer can
// call them; feature code should never reach them — it goes through
// [reconcile] which orders the three feeds correctly.
//
// Resource ordering (lists → items → members):
//   - Lists arrive first so their UI placeholder rows exist before items
//     try to attach to them visually.
//   - Items second so any locally-cached items in a now-deleted list have
//     a parent to drop.
//   - Members LAST so a self-revocation tombstone (which sweeps the local
//     list + items + other members) runs after any leftover rows have
//     landed. Putting it earlier would race the items pull and leave
//     orphan items visible for one tick.
//   This matches `backend/docs/sync.md` and the iOS reconciler.
//
// Tombstone application:
//   - For lists: a row with `deletedAt != null` causes us to delete the
//     local list row. Items and members of that list are NOT swept here —
//     they'll arrive as tombstones in their own feeds (the backend
//     cascades soft-deletes in app code).
//   - For items: same — delete the local row.
//   - For members: a `userId == self` tombstone is the revocation signal.
//     We sweep the entire local list (list + items + every member).
//     Other-member tombstones just delete the single member row.
//
// Coroutine context:
//   All DAO calls are `suspend` and Room hops to its own IO dispatcher
//   internally. We don't pin the engine to a particular dispatcher;
//   callers (the AppContainer's bootstrap, lifecycle resume, login
//   completion) decide. The drainer runs on its own scope.

public sealed class SyncEngineError(message: String) : Exception(message) {
    public object NotAuthenticated : SyncEngineError("not authenticated") {
        @Suppress("unused")
        private fun readResolve(): Any = NotAuthenticated
    }

    public data class FeedFailed(
        val resource: SyncResource,
        val underlying: Throwable,
    ) : SyncEngineError("feed ${resource.key} failed: ${underlying.message}")
}

public class SyncEngine(
    private val api: ApiClient,
    private val database: SyncDatabase,
    private val monitor: NetworkMonitoring,
    /**
     * Lazy lookup of the current user id — slice C will use this when
     * queueing mutations; slice B uses it to recognize self-revocation in
     * the members feed. We pass a callable so the engine doesn't have to
     * take a hard dep on AuthService.
     */
    private val currentUserId: () -> String?,
) {
    private val listDao = database.listDao()
    private val itemDao = database.itemDao()
    private val memberDao = database.memberDao()
    private val cursorDao = database.syncCursorDao()

    /**
     * Pull all three feeds in order, applying updates and tombstones.
     * Throws [SyncEngineError.FeedFailed] on the first feed failure (no
     * partial-success silent swallowing). Call sites: app foreground,
     * post-login, slice-C.3' will add WS-reconnect (Phase 12).
     */
    public suspend fun reconcile() {
        currentUserId() ?: throw SyncEngineError.NotAuthenticated
        if (!monitor.isOnline.value) {
            // Offline-aware bail: not an error, just a no-op. The
            // caller's expectation is "if the network is up, get me
            // current state"; throwing here would surface as a
            // misleading "sync failed" in UI.
            return
        }

        reconcileLists()
        reconcileItems()
        reconcileListMembers()
    }

    // region Per-feed reconcilers
    //
    // Each follows the same shape: read the cursor, build the URL with
    // `?since=<cursor>` if present, decode the response, upsert /
    // tombstone every row, persist the new cursor. Extracted into
    // separate methods (rather than a generic helper) because the upsert
    // step is row-type-specific and pulling it through generics adds
    // more friction than the duplication saves at three resources —
    // same call as the iOS implementation.

    private suspend fun reconcileLists() {
        val cursor = cursorDao.find(SyncResource.Lists.key)?.serverTime
        val path = pathWithSince("/sync/lists", cursor)
        val response = try {
            api.send<SyncResponseDto<ListDto>>(method = HttpMethod.Get, path = path)
        } catch (t: Throwable) {
            throw SyncEngineError.FeedFailed(SyncResource.Lists, t)
        }

        // One Room transaction per feed: keeps the upserts and the
        // cursor write consistent under a crash mid-feed. Without the
        // transaction wrapper, a process kill between row 5 and the
        // cursor write would re-stream rows 0..5 on the next reconcile.
        // It's idempotent (LWW guard handles re-streamed rows) but the
        // transaction makes the partial-write window smaller and is
        // free to add.
        database.withTransaction {
            for (row in response.rows) {
                if (row.deletedAt != null) {
                    listDao.deleteById(row.id)
                } else {
                    upsertListLww(row)
                }
            }
            cursorDao.upsert(
                SyncCursorEntity(
                    resource = SyncResource.Lists.key,
                    serverTime = response.serverTime,
                ),
            )
        }
    }

    private suspend fun reconcileItems() {
        val cursor = cursorDao.find(SyncResource.Items.key)?.serverTime
        val path = pathWithSince("/sync/items", cursor)
        val response = try {
            api.send<SyncResponseDto<ItemDto>>(method = HttpMethod.Get, path = path)
        } catch (t: Throwable) {
            throw SyncEngineError.FeedFailed(SyncResource.Items, t)
        }

        database.withTransaction {
            for (row in response.rows) {
                if (row.deletedAt != null) {
                    itemDao.deleteById(row.id)
                } else {
                    upsertItemLww(row)
                }
            }
            cursorDao.upsert(
                SyncCursorEntity(
                    resource = SyncResource.Items.key,
                    serverTime = response.serverTime,
                ),
            )
        }
    }

    private suspend fun reconcileListMembers() {
        val selfUserId = currentUserId()
            ?: throw SyncEngineError.NotAuthenticated
        val cursor = cursorDao.find(SyncResource.ListMembers.key)?.serverTime
        val path = pathWithSince("/sync/list_members", cursor)
        val response = try {
            api.send<SyncResponseDto<ListMemberDto>>(method = HttpMethod.Get, path = path)
        } catch (t: Throwable) {
            throw SyncEngineError.FeedFailed(SyncResource.ListMembers, t)
        }

        database.withTransaction {
            for (row in response.rows) {
                if (row.deletedAt != null) {
                    if (row.userId == selfUserId) {
                        // Self-revocation: drop the local list + items
                        // + members. The user no longer has access; we
                        // shouldn't keep stale state around. See the
                        // iOS SyncEngine.sweepLocalList for matching
                        // rationale.
                        sweepLocalList(row.listId)
                    } else {
                        memberDao.deleteById(row.listId, row.userId)
                    }
                } else {
                    upsertMember(row)
                }
            }
            cursorDao.upsert(
                SyncCursorEntity(
                    resource = SyncResource.ListMembers.key,
                    serverTime = response.serverTime,
                ),
            )
        }
    }

    // endregion

    // region LWW upserts (also called by Drainer for 409 path)
    //
    // The `internal` modifier means feature code outside the sync
    // package can't bypass [reconcile]; only the Drainer (in this
    // package) can call these directly when applying a 409 response's
    // `latest` row.

    /**
     * Apply a single [ListDto] via the LWW guard. If a local row exists
     * with a strictly newer `updatedAt`, we keep ours — otherwise we
     * overwrite. The strict-`>` comparison means a same-tick re-pull
     * (rare but possible at a cursor boundary) doesn't touch the local
     * row spuriously.
     */
    internal suspend fun upsertListLww(dto: ListDto) {
        val existing = listDao.findById(dto.id)
        if (existing == null || dto.updatedAt > existing.updatedAt) {
            listDao.upsert(
                ListEntity(
                    id = dto.id,
                    name = dto.name,
                    createdBy = dto.createdBy,
                    createdAt = dto.createdAt,
                    updatedAt = dto.updatedAt,
                    deletedAt = dto.deletedAt,
                ),
            )
        }
    }

    /**
     * Same as [upsertListLww] for items. The Drainer's 409-on-PATCH
     * /items/:id handler calls this with the server's `latest` body.
     */
    internal suspend fun upsertItemLww(dto: ItemDto) {
        val existing = itemDao.findById(dto.id)
        if (existing == null || dto.updatedAt > existing.updatedAt) {
            itemDao.upsert(
                ItemEntity(
                    id = dto.id,
                    listId = dto.listId,
                    text = dto.text,
                    checkedAt = dto.checkedAt,
                    position = dto.position,
                    createdBy = dto.createdBy,
                    createdAt = dto.createdAt,
                    updatedAt = dto.updatedAt,
                    deletedAt = dto.deletedAt,
                ),
            )
        }
    }

    private suspend fun upsertMember(dto: ListMemberDto) {
        val existing = memberDao.findById(dto.listId, dto.userId)
        if (existing == null || dto.updatedAt > existing.updatedAt) {
            memberDao.upsert(
                MemberEntity(
                    listId = dto.listId,
                    userId = dto.userId,
                    role = dto.role,
                    createdAt = dto.createdAt,
                    updatedAt = dto.updatedAt,
                    deletedAt = dto.deletedAt,
                ),
            )
        }
    }

    /**
     * Self-revocation sweep — three DAO calls inside the same Room
     * transaction. Items first (cosmetic order; SQLite doesn't care),
     * then members, then the list itself. Matches the iOS sweep order
     * for teach-back symmetry.
     *
     * Distinct from [ListDao.deleteById] (which the per-list tombstone
     * path uses): there, items and members will arrive via their own
     * feeds. Here, we won't see those rows because we no longer have
     * membership — so we have to sweep proactively.
     */
    private suspend fun sweepLocalList(listId: String) {
        itemDao.deleteAllInList(listId)
        memberDao.deleteAllInList(listId)
        listDao.deleteById(listId)
    }

    // endregion

    // region Path / cursor helpers

    private fun pathWithSince(basePath: String, since: Instant?): String {
        if (since == null) return basePath
        // Truncate to milliseconds before formatting — the fixed-3-digit
        // formatter is a String concatenation under the hood, but
        // truncating up-front guarantees `Instant.from(formatter.parse)`
        // round-trips losslessly (the parse path expects exactly 3
        // digits). See `JsonCoders.kt` for the same precision argument.
        val truncated = since.truncatedTo(ChronoUnit.MILLIS)
        val isoString = ISO8601_MILLIS_FORMATTER.format(truncated)
        // Backend's Hono router accepts `:` unencoded in query values
        // (RFC 3986 sub-delim) — same observation we made on iOS in
        // slice A. URLEncoder would over-escape. Hand-build the query
        // suffix.
        return "$basePath?since=${urlEncodeQueryValue(isoString)}"
    }

    /**
     * Minimal query-value encoder. We only need to escape `+` (which
     * URLDecoder treats as space) — the colon, dot, and uppercase letters
     * the ISO-8601 string contains are safe in a query value per the
     * sub-delim rule, and the backend tested that during slice A. Avoids
     * pulling in Ktor's URL builder for one call site.
     */
    private fun urlEncodeQueryValue(value: String): String =
        value.replace("+", "%2B")

    // endregion

    public companion object {
        /**
         * Pinned ISO-8601 with exactly 3 fractional digits — the wire
         * format the backend's `since` query param expects. Same shape
         * the [InstantIso8601MillisSerializer] emits. Using a separate
         * formatter (rather than reusing the serializer's internals)
         * avoids a circular dependency between this file and
         * `JsonCoders.kt`.
         */
        private val ISO8601_MILLIS_FORMATTER: DateTimeFormatter =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
                .withZone(ZoneOffset.UTC)
    }
}
