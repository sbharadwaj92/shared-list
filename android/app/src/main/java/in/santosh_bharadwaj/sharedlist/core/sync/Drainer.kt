package `in`.santosh_bharadwaj.sharedlist.core.sync

import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiError
import `in`.santosh_bharadwaj.sharedlist.core.networking.JsonCoders
import io.ktor.http.HttpMethod
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// Drainer — slice C.3'.
//
// The drainer is the back half of the offline-first write loop. Slice C.2'
// gave us the [Mutator], which applies every user action to the local
// Room database optimistically AND appends a [MutationQueueEntity]. This
// file consumes those entries: pick the oldest pending row, decode its
// payload, build the right HTTP request against the slice-C.1 backend,
// react to the response, repeat until the queue is empty (or we hit a
// reason to stop).
//
// Sequencing model:
//   - Serial drain: one in-flight HTTP request at a time per drainer
//     instance. PLAN.md and the slice-C scope agree: parallelism is a
//     backend-throughput concern that has no measurable upside at 3
//     users / single-Mac backend, and serial drain keeps the merge logic
//     for 409→reconcile→retry trivially correct.
//   - Single-flight via [drainMutex] + [isDraining]. Multiple [kick]
//     calls during a drain coalesce — the in-flight tick re-checks the
//     queue at its tail and keeps going if more rows landed.
//
// Coroutine context:
//   The drainer owns its own [CoroutineScope] backed by
//   `SupervisorJob() + Dispatchers.IO`. Why a SupervisorJob: a failure in
//   one drain coroutine should NOT cancel sibling drains (e.g., a
//   future test harness that fires multiple kicks). Why IO: Ktor + Room
//   both want IO threads; a Main-dispatcher confinement would block
//   the UI on long requests.
//
// Status code handling — same as iOS:
//   - 2xx → delete the queue row.
//   - 401 → trust ApiClient's single-flight refresh, which retries the
//     underlying request. If the retried response is still 401, treat
//     as transient and re-queue.
//   - 404 on PATCH/DELETE → idempotent success-shape; remove the entry.
//   - 403 → mark `failed`; the next reconcile will sweep the local list
//     via the membership feed's revocation path.
//   - 409 on POST (id collision with tombstone) → mark `failed`;
//     pathological case the client's id-generator should prevent.
//   - 409 on PATCH → reconcile + retry-once. See [drainPatch].
//   - Other 4xx → mark `failed` with the server's body in `lastError`.
//   - 5xx + transport → re-queue with retryCount++.

@Suppress("TooManyFunctions")
public class Drainer(
    private val api: ApiClient,
    private val database: SyncDatabase,
    private val syncEngine: SyncEngine,
    private val monitor: NetworkMonitoring,
    /** Long-lived scope for tick coroutines. Tests inject a TestScope. */
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val queueDao = database.mutationQueueDao()
    private val listDao = database.listDao()
    private val itemDao = database.itemDao()

    /** Guards [isDraining]; held only while reading/writing the flag. */
    private val drainMutex = Mutex()
    private var isDraining: Boolean = false

    init {
        // Reset any rows left at `inFlight` from a prior crash/force-quit.
        // Without this sweep, the live drainer (which only picks up
        // `pending` rows) would never retry them.
        scope.launch {
            queueDao.resetStaleInFlight()
        }
    }

    /**
     * External entry point. Multiple kicks during an in-flight drain
     * coalesce — the in-flight tick re-checks the queue at its tail and
     * keeps going if more rows landed. The flag means callers don't
     * need their own "am I already draining?" coordination.
     */
    public fun kick() {
        if (!monitor.isOnline.value) {
            // Offline-aware bail: not an error, just a no-op. Next
            // online transition will kick again (the AppContainer wires
            // a `isOnline.collect { if (it) drainer.kick() }`).
            return
        }
        scope.launch {
            tick()
        }
    }

    /**
     * Internal so tests can drive it directly without going through
     * the kick → launch hop. Returns when the queue is empty, the
     * network drops, or a row requeues itself (transient failure).
     */
    @Suppress("LoopWithTooManyJumpStatements")
    public suspend fun tick() {
        // Compare-and-set the drain flag under the mutex so two
        // concurrent ticks (from racing kicks) collapse to one.
        val acquired = drainMutex.withLock {
            if (isDraining) {
                false
            } else {
                isDraining = true
                true
            }
        }
        if (!acquired) return

        try {
            while (monitor.isOnline.value) {
                val entry = queueDao.nextWithStatus(MutationStatus.Pending.key) ?: break
                queueDao.update(entry.copy(status = MutationStatus.InFlight.key))
                val transient = drain(entry)
                if (transient) {
                    // Per-tick stop on requeue avoids spinning. The next
                    // kick (foreground / online transition / next user
                    // action) gets us back to it.
                    break
                }
            }
        } finally {
            drainMutex.withLock { isDraining = false }
        }
    }

    /**
     * Drain one entry. Returns `true` if the entry ended up requeued
     * (transient failure — caller should stop the tick); `false` if
     * the entry reached a terminal state (removed or marked failed).
     */
    @Suppress("ReturnCount", "ComplexCondition")
    private suspend fun drain(entry: MutationQueueEntity): Boolean {
        val opType = MutationOpType.fromKey(entry.opType)
        if (opType == null) {
            markFailed(entry, "unknown opType: ${entry.opType}")
            return false
        }
        return try {
            when (opType) {
                MutationOpType.CreateList -> drainCreateList(entry)
                MutationOpType.RenameList -> drainRenameList(entry)
                MutationOpType.DeleteList -> drainDeleteList(entry)
                MutationOpType.CreateItem -> drainCreateItem(entry)
                MutationOpType.PatchItem -> drainPatchItem(entry)
                MutationOpType.DeleteItem -> drainDeleteItem(entry)
            }
        } catch (e: ApiError.RefreshFailed) {
            requeue(entry, "auth refresh failed")
            true
        } catch (e: ApiError.Transport) {
            requeue(entry, "transport: ${e.message}")
            true
        } catch (e: SerializationException) {
            markFailed(entry, "payload decode failed: ${e.message}")
            false
        } catch (e: IllegalStateException) {
            markFailed(entry, "drain failure: ${e.message}")
            false
        }
    }

    // region Per-opType handlers

    private suspend fun drainCreateList(entry: MutationQueueEntity): Boolean {
        val payload = decode<CreateListPayload>(entry.payload)
        val response = api.sendRaw(method = HttpMethod.Post, path = "/lists", body = payload)
        return when (response.status) {
            in SUCCESS_2XX -> {
                removeEntry(entry)
                false
            }
            // 409 here means an id collision with a tombstoned row —
            // pathological since clients shouldn't reuse ids.
            HTTP_CONFLICT -> {
                markFailed(entry, "id collides with a deleted list")
                false
            }
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    private suspend fun drainRenameList(entry: MutationQueueEntity): Boolean {
        val payload = decode<RenameListPayload>(entry.payload)
        val path = "/lists/${entry.targetId}"
        val response = api.sendRaw(
            method = HttpMethod.Patch,
            path = path,
            body = mapOf("name" to payload.name),
            extraHeaders = mapOf("If-Match" to formatInstant(payload.ifMatch)),
        )
        return when (response.status) {
            HTTP_OK -> {
                removeEntry(entry)
                false
            }
            HTTP_NOT_FOUND -> {
                // Server says the list is gone. The next reconcile
                // will sweep the local row via the `?since=`
                // tombstone feed; drop the queue entry now.
                removeEntry(entry)
                false
            }
            HTTP_CONFLICT -> retryListPatchAfterConflict(entry, response.body, path)
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    private suspend fun drainDeleteList(entry: MutationQueueEntity): Boolean {
        val response = api.sendRaw(
            method = HttpMethod.Delete,
            path = "/lists/${entry.targetId}",
        )
        return when (response.status) {
            HTTP_NO_CONTENT, HTTP_NOT_FOUND -> {
                // 404 on DELETE is success-shape (idempotent).
                removeEntry(entry)
                false
            }
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    private suspend fun drainCreateItem(entry: MutationQueueEntity): Boolean {
        val payload = decode<CreateItemPayload>(entry.payload)
        // The Mutator's payload doesn't carry the listId — we look it
        // up from the local item row. The local row was inserted in
        // the same transaction as the queue entry (slice C.2'
        // atomicity contract), so it must exist unless the user has
        // soft-deleted the item before the drainer ran.
        val localItem = itemDao.findById(entry.targetId)
        if (localItem == null) {
            markFailed(entry, "local item row missing for queued create")
            return false
        }
        val response = api.sendRaw(
            method = HttpMethod.Post,
            path = "/lists/${localItem.listId}/items",
            body = payload,
        )
        return when (response.status) {
            in SUCCESS_2XX -> {
                removeEntry(entry)
                false
            }
            HTTP_CONFLICT -> {
                markFailed(entry, "id collides with a deleted item")
                false
            }
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    private suspend fun drainPatchItem(entry: MutationQueueEntity): Boolean {
        // We don't decode into [PatchItemPayload] — the wire body is
        // already JSON in the queue row. Read the `ifMatch` field out
        // and forward the rest verbatim. Re-encoding here would force
        // us to round-trip a three-state JsonElement (the `checked`
        // field) which is exactly what we hand-encoded in the Mutator
        // to avoid in the first place.
        val raw = JsonCoders.Json.parseToJsonElement(entry.payload)
        val obj = raw as? kotlinx.serialization.json.JsonObject
            ?: error("patchItem payload is not an object")
        val ifMatchString = (obj["ifMatch"] as? JsonPrimitive)?.content
            ?: error("patchItem payload missing ifMatch")
        val ifMatch = Instant.parse(ifMatchString)
        // Strip ifMatch out of the body — it's a header on the wire.
        val bodyJson = kotlinx.serialization.json.JsonObject(
            obj.filterKeys { it != "ifMatch" },
        )
        val bodyString = JsonCoders.Json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            bodyJson,
        )

        val path = "/items/${entry.targetId}"
        val response = api.sendRaw(
            method = HttpMethod.Patch,
            path = path,
            body = bodyString,
            extraHeaders = mapOf(
                "If-Match" to formatInstant(ifMatch),
                "Content-Type" to "application/json",
            ),
        )
        return when (response.status) {
            HTTP_OK -> {
                removeEntry(entry)
                false
            }
            HTTP_NOT_FOUND -> {
                removeEntry(entry)
                false
            }
            HTTP_CONFLICT -> retryItemPatchAfterConflict(entry, response.body, path)
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    private suspend fun drainDeleteItem(entry: MutationQueueEntity): Boolean {
        val response = api.sendRaw(
            method = HttpMethod.Delete,
            path = "/items/${entry.targetId}",
        )
        return when (response.status) {
            HTTP_NO_CONTENT, HTTP_NOT_FOUND -> {
                removeEntry(entry)
                false
            }
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    // endregion

    // region 409 retry paths

    /**
     * Apply the 409 response's `latest` row through the SyncEngine's
     * LWW upsert (which merges server truth with our optimistic
     * edits), then re-read the local row (post-merge) and send the
     * merged state back. If the second send also 409s, mark `failed`
     * — repeated 409s mean an edit war and surfacing beats spinning
     * (PLAN.md L195).
     */
    private suspend fun retryListPatchAfterConflict(
        entry: MutationQueueEntity,
        body: String,
        path: String,
    ): Boolean {
        val conflict = try {
            JsonCoders.Json.decodeFromString<ConflictBodyDto<ListDto>>(body)
        } catch (e: SerializationException) {
            markFailed(entry, "409 body undecodable: ${e.message}")
            return false
        }
        syncEngine.upsertListLww(conflict.latest)

        val local = listDao.findActiveById(entry.targetId)
        if (local == null) {
            // Local row vanished between the 409 response and the
            // rebuild — likely the user deleted it. Drop the queue
            // entry; the delete will propagate via its own entry.
            removeEntry(entry)
            return false
        }
        val response = api.sendRaw(
            method = HttpMethod.Patch,
            path = path,
            body = mapOf("name" to local.name),
            extraHeaders = mapOf("If-Match" to formatInstant(local.updatedAt)),
        )
        return when (response.status) {
            HTTP_OK, HTTP_NOT_FOUND -> {
                removeEntry(entry)
                false
            }
            HTTP_CONFLICT -> {
                markFailed(entry, "concurrent edits, manual resolution needed")
                false
            }
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    private suspend fun retryItemPatchAfterConflict(
        entry: MutationQueueEntity,
        body: String,
        path: String,
    ): Boolean {
        val conflict = try {
            JsonCoders.Json.decodeFromString<ConflictBodyDto<ItemDto>>(body)
        } catch (e: SerializationException) {
            markFailed(entry, "409 body undecodable: ${e.message}")
            return false
        }
        syncEngine.upsertItemLww(conflict.latest)

        val local = itemDao.findActiveById(entry.targetId)
        if (local == null) {
            removeEntry(entry)
            return false
        }
        // Rebuild from the LWW-merged local row. We send all three
        // fields (text, position, checked) — simpler and correct, since
        // the values match local truth either way. `checked` collapses
        // to `null`-or-iso here (no three-state ambiguity once we're
        // talking about local truth, only the original Mutator call
        // had that ambiguity).
        val rebuilt = buildJsonObject {
            put("text", JsonPrimitive(local.text))
            put("position", JsonPrimitive(local.position))
            if (local.checkedAt != null) {
                put("checked", JsonPrimitive(formatInstant(local.checkedAt)))
            } else {
                put("checked", JsonNull)
            }
        }
        val rebuiltString = JsonCoders.Json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            rebuilt,
        )
        val response = api.sendRaw(
            method = HttpMethod.Patch,
            path = path,
            body = rebuiltString,
            extraHeaders = mapOf(
                "If-Match" to formatInstant(local.updatedAt),
                "Content-Type" to "application/json",
            ),
        )
        return when (response.status) {
            HTTP_OK, HTTP_NOT_FOUND -> {
                removeEntry(entry)
                false
            }
            HTTP_CONFLICT -> {
                markFailed(entry, "concurrent edits, manual resolution needed")
                false
            }
            else -> handleNonSuccess(entry, response.status, response.body)
        }
    }

    // endregion

    // region Status / queue helpers

    private suspend fun handleNonSuccess(
        entry: MutationQueueEntity,
        status: Int,
        body: String?,
    ): Boolean {
        return when (status) {
            HTTP_UNAUTHORIZED -> {
                // ApiClient's single-flight refresh path retried; if
                // we still see 401 here, refresh failed. Treat as
                // transient — the next kick after the user
                // re-authenticates retries.
                requeue(entry, "auth refresh failed")
                true
            }
            HTTP_FORBIDDEN -> {
                markFailed(entry, "membership lost (403)")
                false
            }
            in SERVER_5XX -> {
                requeue(entry, "server $status")
                true
            }
            else -> {
                val message = body?.takeIf { it.isNotBlank() } ?: "status $status"
                markFailed(entry, "permanent error ($status): $message")
                false
            }
        }
    }

    private suspend fun removeEntry(entry: MutationQueueEntity) {
        queueDao.deleteById(entry.id)
    }

    private suspend fun requeue(entry: MutationQueueEntity, reason: String) {
        queueDao.update(
            entry.copy(
                status = MutationStatus.Pending.key,
                retryCount = entry.retryCount + 1,
                lastError = reason,
            ),
        )
    }

    private suspend fun markFailed(entry: MutationQueueEntity, reason: String) {
        queueDao.update(
            entry.copy(status = MutationStatus.Failed.key, lastError = reason),
        )
    }

    // endregion

    // region Decoding

    private inline fun <reified T> decode(json: String): T =
        JsonCoders.Json.decodeFromString<T>(json)

    private fun formatInstant(value: Instant): String {
        val truncated = value.truncatedTo(ChronoUnit.MILLIS)
        return ISO8601_MILLIS_FORMATTER.format(truncated)
    }

    // endregion

    public companion object {
        private const val HTTP_OK = 200
        private const val HTTP_CREATED = 201
        private const val HTTP_NO_CONTENT = 204
        private const val HTTP_UNAUTHORIZED = 401
        private const val HTTP_FORBIDDEN = 403
        private const val HTTP_NOT_FOUND = 404
        private const val HTTP_CONFLICT = 409
        private const val HTTP_INTERNAL_SERVER_ERROR = 500
        private const val HTTP_NETWORK_AUTH_REQUIRED = 599
        private val SUCCESS_2XX = HTTP_OK..HTTP_CREATED
        private val SERVER_5XX = HTTP_INTERNAL_SERVER_ERROR..HTTP_NETWORK_AUTH_REQUIRED

        private val ISO8601_MILLIS_FORMATTER: DateTimeFormatter =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
                .withZone(java.time.ZoneOffset.UTC)
    }
}
