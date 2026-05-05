package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.time.Instant

// Room @Entity types — the local cache the sync engine writes to.
//
// Mirror of iOS `Models.swift`:
//   - One @Entity per resource (UserModel, ListModel, ItemModel, MemberModel).
//   - Plus SyncCursor (per-resource high-water mark) and MutationQueueEntry
//     (slice C.2's durable queue of pending writes).
//
// Why Room (vs SQLDelight, Realm, hand-rolled SQLite):
//   PLAN.md L208 picks Room. It's the SwiftData analogue: typed @Entity
//   classes, KSP-generated DAO implementations, transactional writes via
//   @Transaction-annotated DAO methods. Same model as iOS ("everything that
//   touches the cache lives behind one container, save() commits a batch").
//
// Identity:
//   - Lists / items / mutation queue rows use UUID v7 strings as the
//     primary key. We store the raw String (not a UUID type) because Java's
//     `java.util.UUID` is v4-biased and constructing v7 from it round-trips
//     awkwardly. The backend's `ON CONFLICT (id) DO NOTHING` only cares about
//     uniqueness, not version bits — same KNOWN_DEBT note as iOS.
//   - `list_members` has a composite (listId, userId) primary key. Room's
//     `primaryKeys = [...]` annotation supports composite uniques natively
//     (unlike SwiftData), so we use it directly rather than synthesizing a
//     pipe-joined string. Cleaner than the iOS workaround.
//
// Tombstone semantics:
//   `deletedAt: Instant?` (nullable). Non-null means the row is a tombstone;
//   reads from feature code go through DAO helpers that filter `WHERE
//   deletedAt IS NULL`. The sync reconciler is the only consumer that reads
//   tombstoned rows.
//
// Time type:
//   `java.time.Instant` end-to-end. Room doesn't natively support `Instant`
//   so we register a `TypeConverter` (see `SyncTypeConverters.kt`) that maps
//   Instant ↔ epoch-millis Long. Storing as Long makes range queries cheap
//   ("WHERE updatedAt > :since") because SQLite indexes integer columns
//   trivially; ISO-8601 string storage would force lexicographic
//   comparisons which work but mask intent.

// region User

/**
 * Users table — sparse by design. The `/sync` feed does NOT surface user
 * rows (PLAN.md scope: members are referenced by FK; the user record is
 * owned by auth). For Phase 8 we only persist the *current signed-in
 * user's* row, hydrated from `/auth/me`. Other users' display names get
 * joined into UI from `list_members.userId` lookups; that's Phase 13+.
 */
@Entity(tableName = "users")
public data class UserEntity(
    @PrimaryKey
    @ColumnInfo(name = "id") public val id: String,
    @ColumnInfo(name = "email") public val email: String,
    @ColumnInfo(name = "displayName") public val displayName: String,
    @ColumnInfo(name = "updatedAt") public val updatedAt: Instant,
)

// endregion

// region List

@Entity(
    tableName = "lists",
    indices = [Index(value = ["updatedAt"])],
)
public data class ListEntity(
    @PrimaryKey
    @ColumnInfo(name = "id") public val id: String,
    @ColumnInfo(name = "name") public val name: String,
    @ColumnInfo(name = "createdBy") public val createdBy: String,
    @ColumnInfo(name = "createdAt") public val createdAt: Instant,
    @ColumnInfo(name = "updatedAt") public val updatedAt: Instant,
    /**
     * Non-null = tombstone signal. Reads from feature code filter on
     * `deletedAt IS NULL`; the sync reconciler is the only consumer
     * that reads tombstoned rows.
     */
    @ColumnInfo(name = "deletedAt") public val deletedAt: Instant? = null,
)

// endregion

// region Item

@Entity(
    tableName = "items",
    indices = [
        Index(value = ["listId"]),
        Index(value = ["updatedAt"]),
    ],
)
public data class ItemEntity(
    @PrimaryKey
    @ColumnInfo(name = "id") public val id: String,
    @ColumnInfo(name = "listId") public val listId: String,
    @ColumnInfo(name = "text") public val text: String,
    /**
     * Wire shape from the backend: nullable timestamp (when checked, or
     * null). The "is this item checked?" boolean question is
     * `checkedAt != null`. Preserving the timestamp lets a future "checked
     * at 4:32pm" UI render without a schema migration.
     */
    @ColumnInfo(name = "checkedAt") public val checkedAt: Instant? = null,
    @ColumnInfo(name = "position") public val position: Int,
    @ColumnInfo(name = "createdBy") public val createdBy: String,
    @ColumnInfo(name = "createdAt") public val createdAt: Instant,
    @ColumnInfo(name = "updatedAt") public val updatedAt: Instant,
    @ColumnInfo(name = "deletedAt") public val deletedAt: Instant? = null,
)

// endregion

// region Member

/**
 * `list_members` row. Composite primary key (listId, userId) — Room's
 * `primaryKeys` annotation supports this directly, unlike SwiftData (where
 * the iOS port had to synthesize a pipe-joined string). Cleaner here.
 */
@Entity(
    tableName = "list_members",
    primaryKeys = ["listId", "userId"],
    indices = [Index(value = ["updatedAt"])],
)
public data class MemberEntity(
    @ColumnInfo(name = "listId") public val listId: String,
    @ColumnInfo(name = "userId") public val userId: String,
    @ColumnInfo(name = "role") public val role: String,
    @ColumnInfo(name = "createdAt") public val createdAt: Instant,
    @ColumnInfo(name = "updatedAt") public val updatedAt: Instant,
    @ColumnInfo(name = "deletedAt") public val deletedAt: Instant? = null,
)

// endregion

// region Sync cursors

/**
 * One row per resource type, holding the high-water `serverTime` cursor
 * the next reconcile passes back to the backend as `?since=`.
 *
 * Why store cursors in the same Room database (rather than DataStore):
 *   1. They're part of the same data set as the rows they describe —
 *      backing them up / wiping them happens together. DataStore gets
 *      cleared independently which would create a "we have local rows
 *      but no cursor" state that re-streams everything at best,
 *      conflicts at worst.
 *   2. Co-locating cursors with model data lets us reset the entire
 *      cache (e.g., on logout) by deleting the database file.
 */
@Entity(tableName = "sync_cursors")
public data class SyncCursorEntity(
    @PrimaryKey
    @ColumnInfo(name = "resource") public val resource: String,
    @ColumnInfo(name = "serverTime") public val serverTime: Instant,
)

/**
 * Stable string keys for cursor rows. We pin the wire-style names rather
 * than relying on `enum.name` (Kotlin reflection-stable but fragile under
 * obfuscation) or `ordinal` (renumbers under enum reordering).
 */
public enum class SyncResource(public val key: String) {
    Lists("lists"),
    Items("items"),
    ListMembers("list_members"),
}

// endregion

// region Mutation queue (slice C.2)

/**
 * Durable record of a pending write, written by the [Mutator] alongside
 * the optimistic local row in ONE Room transaction. The [Drainer]
 * (slice C.3) reads these rows, sends the corresponding HTTP request,
 * and removes each entry on success or moves it to "failed" on a
 * permanent error.
 *
 * Why durable in Room (rather than in-memory or DataStore):
 *   - The user expects offline writes to survive an app force-quit. A
 *     row in the same persistent store as the data it mutates is the
 *     only way to guarantee that — DataStore gets cleared independently
 *     of the Room migrations, and an in-memory queue evaporates on
 *     relaunch.
 *   - Co-locating queue + data in one database lets the Mutator do the
 *     local apply and the queue append in the same SQLite transaction.
 *     If either fails the whole transaction rolls back, so we never
 *     leave a local-applied-but-not-queued state (which would silently
 *     lose writes to the backend).
 *
 * Why fields are stringly-typed (`opType`, `payload`, `status`):
 *   - Room supports type converters for enums, but the surface is rough
 *     when paired with `@Query` parameter binding (you have to register
 *     each enum at the Database level). The string + typed-helper
 *     pattern matches what we use for [SyncResource], and keeps the
 *     converter list in [SyncTypeConverters] short.
 *   - The `payload` JSON String is the simplest persistent shape that
 *     can carry the per-opType body (CreateListPayload vs PatchItemPayload
 *     etc). The drainer decodes back to a typed payload before sending.
 */
@Entity(
    tableName = "mutation_queue",
    indices = [
        Index(value = ["status"]),
        Index(value = ["createdAt"]),
    ],
)
public data class MutationQueueEntity(
    /**
     * Each queue row has its own UUID — distinct from the [targetId] of
     * the resource it mutates. Two queue rows for the same target
     * (e.g. a quick double-tap on "check item") are valid; the drainer
     * processes them in [createdAt] order.
     */
    @PrimaryKey
    @ColumnInfo(name = "id") public val id: String,
    /** One of [MutationOpType.key]. Persisted as String for the same reason cursor resource is. */
    @ColumnInfo(name = "opType") public val opType: String,
    /**
     * The id of the resource being mutated. For create operations this
     * equals the new resource's id (which is also the body's `id` field
     * for backend idempotency). For patch/delete this is the existing
     * resource id.
     */
    @ColumnInfo(name = "targetId") public val targetId: String,
    /**
     * JSON-encoded payload — one of the `*Payload` `@Serializable` types
     * defined in `Mutator.kt`. The drainer decodes this back into the
     * right payload type via [opType] discrimination.
     */
    @ColumnInfo(name = "payload") public val payload: String,
    @ColumnInfo(name = "createdAt") public val createdAt: Instant,
    /**
     * One of [MutationStatus.key]. New rows are `"pending"`; the drainer
     * (slice C.3) flips through `"inFlight"` and may end at `"failed"`
     * if a non-409 error blocks progress.
     */
    @ColumnInfo(name = "status") public val status: String = MutationStatus.Pending.key,
    /**
     * 0 on insert. The drainer increments on retryable failures; a hard
     * ceiling is checked by [Drainer] so the UI can surface "give up"
     * rather than spinning forever.
     */
    @ColumnInfo(name = "retryCount") public val retryCount: Int = 0,
    /** Last error message shown to UI when [status] == "failed". `null` on insert. */
    @ColumnInfo(name = "lastError") public val lastError: String? = null,
)

/**
 * Stable string keys for the queue's `opType` column. Mirrors the six
 * backend write endpoints (slice C.1). The drainer (slice C.3) switches
 * on this to pick the request method + path + payload type.
 */
public enum class MutationOpType(public val key: String) {
    CreateList("createList"),
    RenameList("renameList"),
    DeleteList("deleteList"),
    CreateItem("createItem"),
    PatchItem("patchItem"),
    DeleteItem("deleteItem"),
    ;

    public companion object {
        public fun fromKey(raw: String): MutationOpType? = entries.firstOrNull { it.key == raw }
    }
}

/** Lifecycle states for a queue row. */
public enum class MutationStatus(public val key: String) {
    /** In the queue, not yet attempted (or retry-eligible after backoff). */
    Pending("pending"),

    /** The drainer has picked it up and is mid-request. */
    InFlight("inFlight"),

    /** Permanent error (non-409, or 409 reconciliation failed). */
    Failed("failed"),
    ;

    public companion object {
        public fun fromKey(raw: String): MutationStatus? = entries.firstOrNull { it.key == raw }
    }
}

// endregion
