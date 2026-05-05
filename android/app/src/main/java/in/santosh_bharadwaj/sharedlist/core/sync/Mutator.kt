package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.room.withTransaction
import `in`.santosh_bharadwaj.sharedlist.core.networking.JsonCoders
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// Mutator — slice C.2'.
//
// Single responsibility: every user action (create/rename/delete a list or
// item; check/uncheck) goes through here. Each call does TWO things in ONE
// Room transaction:
//
//   1. Apply the change to the local database (optimistic UI). Feature
//      ViewModels read from Room directly via DAO `Flow<>` queries (set
//      up Phase 13+) and see the change immediately; the user perceives
//      the action as instant.
//   2. Append a [MutationQueueEntity] row capturing the intent. The
//      drainer (slice C.3') reads these rows and translates them into
//      HTTP requests against the backend, removing each entry on success
//      or moving it to `failed` on a permanent error.
//
// The two-in-one-transaction matters: if the local apply succeeded but
// the queue append failed, we'd silently lose a write to the backend (the
// row would look correct locally, never reach the server, and a future
// device-fresh pull would erase it). [SyncDatabase.withTransaction] is the
// single commit point — either both rows land or neither does.
//
// What this slice DOES NOT do:
//   - Send anything over the network. The Mutator has no [ApiClient]
//     dependency by design — the drainer in slice C.3' owns all HTTP.
//   - 409 conflict resolution. The local row's `updatedAt` is pre-stamped
//     to `clock.now()` here; when the server response eventually arrives
//     via the `?since=` reconciler, the existing LWW guard in
//     [SyncEngine.upsertListLww] / [SyncEngine.upsertItemLww] compares
//     wire `updatedAt` to local and the newer wins. A 409 from PATCH
//     (server has newer state) is slice C.3''s problem.
//   - UI. Every Compose surface reading from Room filters
//     `WHERE deletedAt IS NULL` via the DAO helpers, so a soft-delete
//     here is invisible to the UI immediately. The list/items views
//     don't exist yet — that's Phase 13.
//
// Cascade on `deleteList`:
//   The backend's `DELETE /lists/:id` cascades soft-delete to items in
//   the same transaction (slice C.1). We mirror that locally so the UI
//   doesn't show "list gone" with phantom items lingering. Importantly,
//   we enqueue ONLY the list-delete — the server cascades on its side,
//   so enqueueing N+1 entries (list + each item) would cause N redundant
//   404s when the drainer runs. One queue entry, one HTTP request.
//
// Position picking on `createItem`:
//   New items get `position = (max(existing positions) ?? 0) + 1024`.
//   The 1024 gap leaves room to reorder by midpoint without immediate
//   collisions (PLAN.md L165 documents the integer-position vs
//   fractional-indexing trade-off). Concurrent creates from two devices
//   will race; LWW resolves the visible order on the next reconcile,
//   which is acceptable for v1.

public class Mutator(
    private val database: SyncDatabase,
    /** Injected so tests can use a fixed clock for exact timestamp assertions. */
    private val clock: Clock = SystemClock(),
    /** Injected for the same reason — tests want deterministic ids. */
    private val uuidGenerator: UuidGenerator = SystemUuidGenerator(),
) {
    private val listDao = database.listDao()
    private val itemDao = database.itemDao()
    private val queueDao = database.mutationQueueDao()
    private val txDao = database.syncTxDao()

    /**
     * Slice C.3'-only: when set, every successful Mutator call kicks the
     * drainer so the local apply + server send happen as one perceived
     * action when online. Optional because some tests don't need a
     * drainer; the AppContainer wires it in production via [attachDrainer].
     */
    private var drainer: Drainer? = null

    /**
     * Two-phase wiring escape hatch: [Drainer] and [Mutator] need to know
     * about each other (drainer reads queue rows mutator wrote; mutator
     * kicks drainer after each save). The AppContainer constructs both
     * then installs the link via this method, breaking the construction-
     * order cycle. Held by reference (no need for a weak handle in
     * Kotlin land — both objects are AppContainer-owned and live
     * process-long).
     */
    public fun attachDrainer(drainer: Drainer) {
        this.drainer = drainer
    }

    // region Lists

    /**
     * Create a new list. Returns the new list's id so callers can
     * navigate straight into it without a second fetch. The user
     * automatically becomes the owner — the backend handles that on
     * its side via `insertListWithOwner`; the next reconcile fills in
     * the local owner-membership row.
     */
    public suspend fun createList(name: String): String {
        val id = uuidGenerator.newUuid()
        val now = nowMillis()

        database.withTransaction {
            // Local apply — pre-stamp `updatedAt` to `now` so the LWW
            // guard in [SyncEngine.upsertListLww] correctly resolves an
            // at-the-cursor server response without overwriting our
            // optimistic state.
            // `createdBy` is left empty — we don't have the user id
            // without an AuthService dep; the next reconcile overwrites
            // when the server's row comes back via `?since=`.
            listDao.upsert(
                ListEntity(
                    id = id,
                    name = name,
                    createdBy = "",
                    createdAt = now,
                    updatedAt = now,
                    deletedAt = null,
                ),
            )
            queueDao.insert(
                MutationQueueEntity(
                    id = uuidGenerator.newUuid(),
                    opType = MutationOpType.CreateList.key,
                    targetId = id,
                    payload = encode(CreateListPayload(id = id, name = name)),
                    createdAt = now,
                ),
            )
        }
        drainer?.kick()
        return id
    }

    /**
     * Rename an existing list. The local `updatedAt` bumps to `now` so
     * the next reconcile's LWW guard picks the right winner. The queue
     * entry captures the new name AND the local `updatedAt` so the
     * drainer can send it as the `If-Match` header (slice C.3' will
     * read this).
     */
    public suspend fun renameList(id: String, newName: String) {
        val now = nowMillis()

        database.withTransaction {
            // No-op rather than throw if the row's gone — same intent
            // as iOS's `findActiveList` lookup. Some other device may
            // have deleted the list between the rename tap and the
            // mutator call; the user shouldn't see a crash.
            val existing = listDao.findActiveById(id) ?: return@withTransaction
            // Capture the cursor BEFORE we mutate — the drainer needs
            // the pre-mutation `updatedAt` as the `If-Match` value
            // (matching what the server has on disk). Stamping `now`
            // and sending `now` would 409 immediately because the
            // server's row is older.
            val priorUpdatedAt = existing.updatedAt
            listDao.upsert(existing.copy(name = newName, updatedAt = now))
            queueDao.insert(
                MutationQueueEntity(
                    id = uuidGenerator.newUuid(),
                    opType = MutationOpType.RenameList.key,
                    targetId = id,
                    payload = encode(
                        RenameListPayload(name = newName, ifMatch = priorUpdatedAt),
                    ),
                    createdAt = now,
                ),
            )
        }
        drainer?.kick()
    }

    /**
     * Soft-delete a list AND cascade soft-delete to its items, mirroring
     * the backend's `DELETE /lists/:id` transaction. Enqueues ONLY the
     * list-delete; the server cascades on its side, so enqueueing item
     * deletes too would cause N redundant 404s when the drainer runs.
     */
    public suspend fun deleteList(id: String) {
        val now = nowMillis()

        database.withTransaction {
            val existing = listDao.findActiveById(id) ?: return@withTransaction
            listDao.upsert(existing.copy(deletedAt = now, updatedAt = now))

            // Cascade — same `now` instant on every affected item so a
            // future user inspecting the trash sees a coherent
            // "deleted at this moment" timeline.
            txDao.cascadeSoftDeleteItems(listId = id, now = now)

            queueDao.insert(
                MutationQueueEntity(
                    id = uuidGenerator.newUuid(),
                    opType = MutationOpType.DeleteList.key,
                    targetId = id,
                    payload = encode(DeleteListPayload),
                    createdAt = now,
                ),
            )
        }
        drainer?.kick()
    }

    // endregion

    // region Items

    /**
     * Add an item to a list. Returns the new item's id. `position` is
     * auto-picked at `(max existing position) + 1024` so manual reorders
     * have room to fit between by midpoint (PLAN.md L165).
     */
    public suspend fun createItem(listId: String, text: String): String {
        val id = uuidGenerator.newUuid()
        val now = nowMillis()

        database.withTransaction {
            // Auto-position: max + 1024. If the list is empty, start
            // at 1024 (rather than 0) so the FIRST manual reorder can
            // pick a midpoint that's still a positive integer.
            val nextPosition = (itemDao.maxPositionInList(listId) ?: 0) + 1024
            itemDao.upsert(
                ItemEntity(
                    id = id,
                    listId = listId,
                    text = text,
                    position = nextPosition,
                    createdBy = "",
                    createdAt = now,
                    updatedAt = now,
                ),
            )
            // Note we DON'T persist `listId` in the payload — the
            // drainer reads it from the local item row when building
            // the POST URL (`/lists/:listId/items`). The local row
            // is guaranteed to exist because we just inserted it in
            // the same transaction.
            queueDao.insert(
                MutationQueueEntity(
                    id = uuidGenerator.newUuid(),
                    opType = MutationOpType.CreateItem.key,
                    targetId = id,
                    payload = encode(
                        CreateItemPayload(id = id, text = text, position = nextPosition),
                    ),
                    createdAt = now,
                ),
            )
        }
        drainer?.kick()
        return id
    }

    /**
     * Patch an item — any subset of `text`, `position`, `checkedAt`. The
     * three-state [CheckedAtChange] for `checkedAt` lets the call site
     * distinguish "leave alone" / "explicitly clear" / "set to
     * timestamp" cleanly without a `Optional<Optional<Instant>>` shape.
     */
    public suspend fun patchItem(
        id: String,
        text: String? = null,
        position: Int? = null,
        checkedAt: CheckedAtChange = CheckedAtChange.LeaveAlone,
    ) {
        // Empty patches are caller bugs — surface immediately rather
        // than silently no-op or hit the backend with a 400. Mirrors the
        // backend's empty-body 400 on PATCH /items/:id.
        if (text == null && position == null && checkedAt == CheckedAtChange.LeaveAlone) {
            throw MutatorError.EmptyPatch
        }
        val now = nowMillis()

        database.withTransaction {
            val existing = itemDao.findActiveById(id) ?: return@withTransaction
            val priorUpdatedAt = existing.updatedAt
            val newCheckedAt: Instant? = when (checkedAt) {
                is CheckedAtChange.LeaveAlone -> existing.checkedAt
                is CheckedAtChange.Checked -> checkedAt.at
                is CheckedAtChange.Unchecked -> null
            }
            itemDao.upsert(
                existing.copy(
                    text = text ?: existing.text,
                    position = position ?: existing.position,
                    checkedAt = newCheckedAt,
                    updatedAt = now,
                ),
            )
            queueDao.insert(
                MutationQueueEntity(
                    id = uuidGenerator.newUuid(),
                    opType = MutationOpType.PatchItem.key,
                    targetId = id,
                    payload = encodePatchItem(
                        text = text,
                        position = position,
                        checked = checkedAt,
                        ifMatch = priorUpdatedAt,
                    ),
                    createdAt = now,
                ),
            )
        }
        drainer?.kick()
    }

    public suspend fun deleteItem(id: String) {
        val now = nowMillis()

        database.withTransaction {
            val existing = itemDao.findActiveById(id) ?: return@withTransaction
            itemDao.upsert(existing.copy(deletedAt = now, updatedAt = now))
            queueDao.insert(
                MutationQueueEntity(
                    id = uuidGenerator.newUuid(),
                    opType = MutationOpType.DeleteItem.key,
                    targetId = id,
                    payload = encode(DeleteItemPayload),
                    createdAt = now,
                ),
            )
        }
        drainer?.kick()
    }

    // endregion

    private fun nowMillis(): Instant =
        clock.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS)

    private inline fun <reified T> encode(value: T): String =
        JsonCoders.Json.encodeToString(value)

    /**
     * Hand-encode the patch-item payload because the `checked` field is
     * three-state — JSON object with the key absent (leave alone), key
     * present and `null` (explicit clear), or key present with an
     * Instant value. kotlinx.serialization can model this with
     * `JsonElement` directly; doing it once here keeps the wire shape
     * intent explicit and matches the iOS [PatchItemPayload].
     */
    private fun encodePatchItem(
        text: String?,
        position: Int?,
        checked: CheckedAtChange,
        ifMatch: Instant,
    ): String {
        val obj: JsonObject = buildJsonObject {
            if (text != null) put("text", JsonPrimitive(text))
            if (position != null) put("position", JsonPrimitive(position))
            when (checked) {
                CheckedAtChange.LeaveAlone -> Unit
                CheckedAtChange.Unchecked -> put("checked", JsonNull)
                is CheckedAtChange.Checked -> {
                    val instantJson: JsonElement = JsonCoders.Json.encodeToJsonElement(
                        InstantWrapper.serializer(),
                        InstantWrapper(checked.at),
                    )
                    // InstantWrapper is just `{ "value": "<iso>" }`; pull
                    // the value out so we land it as a top-level
                    // `"checked": "<iso>"` key.
                    val valueElement = (instantJson as JsonObject)["value"]!!
                    put("checked", valueElement)
                }
            }
            val ifMatchJson: JsonElement = JsonCoders.Json.encodeToJsonElement(
                InstantWrapper.serializer(),
                InstantWrapper(ifMatch),
            )
            put("ifMatch", (ifMatchJson as JsonObject)["value"]!!)
        }
        return JsonCoders.Json.encodeToString(JsonObject.serializer(), obj)
    }

    /**
     * A tiny helper struct used only by [encodePatchItem] to route an
     * [Instant] through the millis-precision serializer when building
     * the three-state JSON object element-by-element.
     *
     * Why we need it: kotlinx.serialization's `encodeToJsonElement`
     * dispatches by serializer at the top level, but pulling a single
     * `Instant` value out without a wrapper would require constructing
     * a serializer instance at runtime — uglier than this 3-line
     * detour.
     */
    @Serializable
    private data class InstantWrapper(
        @Serializable(with = `in`.santosh_bharadwaj.sharedlist.core.networking.InstantIso8601MillisSerializer::class)
        val value: Instant,
    )
}

// region Payload types
//
// One @Serializable type per opType. The drainer (slice C.3') decodes
// the queue's JSON `payload` into the right type via the opType string
// and then maps to an HTTP request.
//
// We keep payload types separate from `SyncDtos.kt` even though they
// share field names with [ListDto] / [ItemDto]. The wire DTO is what
// the server SENDS; the payload is what the client SENDS. They diverge
// over time (e.g. PATCH bodies don't include createdAt/createdBy/etc)
// and coupling them would force noise into the read DTOs.

@Serializable
public data class CreateListPayload(
    public val id: String,
    public val name: String,
)

@Serializable
public data class RenameListPayload(
    public val name: String,
    /**
     * Drainer hands this to the server as the `If-Match` header. The
     * server compares against its current `updated_at` and 409s on
     * mismatch (slice C.1 contract).
     */
    @Serializable(with = `in`.santosh_bharadwaj.sharedlist.core.networking.InstantIso8601MillisSerializer::class)
    public val ifMatch: Instant,
)

@Serializable
public object DeleteListPayload

@Serializable
public data class CreateItemPayload(
    public val id: String,
    public val text: String,
    public val position: Int,
)

@Serializable
public object DeleteItemPayload

// endregion

// region Three-state checked-at change

/**
 * Three-state representation of "what the caller wants to do with the
 * `checkedAt` column" — the wire JSON has three valid shapes (key
 * absent / key present and null / key present with timestamp) and the
 * call site needs the same three-way distinction.
 *
 * Mirrors iOS [CheckedAtChange]; the wire-encoding logic lives in
 * [Mutator.encodePatchItem].
 */
public sealed class CheckedAtChange {
    public object LeaveAlone : CheckedAtChange()
    public data class Checked(val at: Instant) : CheckedAtChange()
    public object Unchecked : CheckedAtChange()
}

// endregion

// region Errors

public sealed class MutatorError(message: String) : Exception(message) {
    /** Mirrors the backend's 400 on an empty PATCH body. */
    public object EmptyPatch : MutatorError("empty patch") {
        @Suppress("unused")
        private fun readResolve(): Any = EmptyPatch
    }
}

// endregion

// region Time + UUID seams (test-injectable)

public interface Clock {
    public fun now(): Instant
}

public class SystemClock : Clock {
    override fun now(): Instant = Instant.now()
}

public interface UuidGenerator {
    public fun newUuid(): String
}

public class SystemUuidGenerator : UuidGenerator {
    override fun newUuid(): String =
        // PLAN.md L47 prefers UUID v7 for Postgres index locality. The
        // JDK's `UUID.randomUUID()` is v4. Backend's `INSERT ... ON
        // CONFLICT (id) DO NOTHING` only cares that the id is unique —
        // it doesn't validate the version bits — so v4 here satisfies
        // the idempotency contract. Index locality on the server's
        // `lists.id` / `items.id` PK is a measurable-but-small loss for
        // a 3-user app; we accept it for v1 and treat upgrading to a
        // real v7 generator as a Phase-19 polish (mirrors iOS).
        UUID.randomUUID().toString()
}

// endregion
