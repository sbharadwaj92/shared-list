package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import androidx.room.Upsert
import java.time.Instant

// DAOs — one per resource grouping, plus one for the mutation queue and one
// for cursors. Each DAO is a Kotlin `interface` annotated with @Dao; Room's
// KSP processor generates a concrete `*_Impl` class at compile time.
//
// Why @Upsert (vs explicit insert + update fallback):
//   The reconciler's "upsert" semantics — insert if missing, update if
//   present — map directly to SQLite's `INSERT ... ON CONFLICT(id) DO
//   UPDATE`. Room 2.6+ exposes this via the @Upsert annotation; the
//   generated SQL is the right shape on the first try.
//
// Why suspend (vs blocking):
//   Every DAO method on this app is called from a coroutine context —
//   ViewModels, the SyncEngine, the Drainer. Suspend functions auto-jump
//   to a Room-managed dispatcher (a custom IO-pool by default) and back
//   to the caller's dispatcher. Blocking calls would force every caller
//   to wrap in `withContext(Dispatchers.IO)` manually.
//
// LWW guard (read-then-write):
//   The sync engine's "newer updatedAt wins" merge is implemented as a
//   read-then-write transaction at the engine layer (see SyncEngine.kt),
//   not in the DAO. We keep DAOs dumb — pure CRUD primitives — so the
//   LWW logic lives in one place and remains easy to reason about. The
//   tradeoff is one extra round-trip per row to SELECT before UPSERT,
//   which is fine at this dataset size.

// region Lists

@Dao
public interface ListDao {
    @Query("SELECT * FROM lists WHERE id = :id LIMIT 1")
    public suspend fun findById(id: String): ListEntity?

    @Query("SELECT * FROM lists WHERE id = :id AND deletedAt IS NULL LIMIT 1")
    public suspend fun findActiveById(id: String): ListEntity?

    @Query("SELECT * FROM lists WHERE deletedAt IS NULL ORDER BY createdAt ASC")
    public suspend fun activeLists(): List<ListEntity>

    @Upsert
    public suspend fun upsert(entity: ListEntity)

    @Query("DELETE FROM lists WHERE id = :id")
    public suspend fun deleteById(id: String)
}

// endregion

// region Items

@Dao
public interface ItemDao {
    @Query("SELECT * FROM items WHERE id = :id LIMIT 1")
    public suspend fun findById(id: String): ItemEntity?

    @Query("SELECT * FROM items WHERE id = :id AND deletedAt IS NULL LIMIT 1")
    public suspend fun findActiveById(id: String): ItemEntity?

    @Query("SELECT * FROM items WHERE listId = :listId AND deletedAt IS NULL ORDER BY position ASC")
    public suspend fun activeItemsInList(listId: String): List<ItemEntity>

    @Query("SELECT MAX(position) FROM items WHERE listId = :listId AND deletedAt IS NULL")
    public suspend fun maxPositionInList(listId: String): Int?

    @Upsert
    public suspend fun upsert(entity: ItemEntity)

    @Query("DELETE FROM items WHERE id = :id")
    public suspend fun deleteById(id: String)

    /**
     * Used by the self-revocation sweep (see [SyncEngine.reconcileMembers])
     * — when our own membership for a list is tombstoned, every item in
     * that list must be cleared, regardless of its own deletedAt status.
     * Distinct from the per-item DELETE because the items in question
     * may not be tombstoned themselves.
     */
    @Query("DELETE FROM items WHERE listId = :listId")
    public suspend fun deleteAllInList(listId: String)
}

// endregion

// region Members

@Dao
public interface MemberDao {
    @Query("SELECT * FROM list_members WHERE listId = :listId AND userId = :userId LIMIT 1")
    public suspend fun findById(listId: String, userId: String): MemberEntity?

    @Query("SELECT * FROM list_members WHERE listId = :listId AND deletedAt IS NULL")
    public suspend fun activeMembersInList(listId: String): List<MemberEntity>

    @Upsert
    public suspend fun upsert(entity: MemberEntity)

    @Query("DELETE FROM list_members WHERE listId = :listId AND userId = :userId")
    public suspend fun deleteById(listId: String, userId: String)

    /** Self-revocation sweep — all members of a list, regardless of their own deletedAt. */
    @Query("DELETE FROM list_members WHERE listId = :listId")
    public suspend fun deleteAllInList(listId: String)
}

// endregion

// region Sync cursors

@Dao
public interface SyncCursorDao {
    @Query("SELECT * FROM sync_cursors WHERE resource = :resource LIMIT 1")
    public suspend fun find(resource: String): SyncCursorEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    public suspend fun upsert(entity: SyncCursorEntity)
}

// endregion

// region Mutation queue

@Dao
public interface MutationQueueDao {
    @Query(
        "SELECT * FROM mutation_queue " +
            "WHERE status = :status " +
            "ORDER BY createdAt ASC LIMIT 1",
    )
    public suspend fun nextWithStatus(status: String): MutationQueueEntity?

    @Query("SELECT * FROM mutation_queue WHERE id = :id LIMIT 1")
    public suspend fun findById(id: String): MutationQueueEntity?

    @Query("SELECT * FROM mutation_queue ORDER BY createdAt ASC")
    public suspend fun all(): List<MutationQueueEntity>

    @Insert
    public suspend fun insert(entity: MutationQueueEntity)

    @Update
    public suspend fun update(entity: MutationQueueEntity)

    @Query("DELETE FROM mutation_queue WHERE id = :id")
    public suspend fun deleteById(id: String)

    /**
     * On Drainer init, sweep stale `inFlight` rows (left over from a
     * crash or force-quit during a request) back to `pending`. Without
     * this, the live drainer (which only picks up `pending` rows) would
     * never retry them.
     */
    @Query(
        "UPDATE mutation_queue SET status = '" + "pending" + "' " +
            "WHERE status = '" + "inFlight" + "'",
    )
    public suspend fun resetStaleInFlight()
}

// endregion

// region User

@Dao
public interface UserDao {
    @Query("SELECT * FROM users WHERE id = :id LIMIT 1")
    public suspend fun findById(id: String): UserEntity?

    @Upsert
    public suspend fun upsert(entity: UserEntity)
}

// endregion

// region Cross-table transactional helpers
//
// Some operations need to touch multiple tables atomically — the
// Mutator's `deleteList` cascades a soft-delete to every active item in
// the list, and the SyncEngine's self-revocation sweep clears the list,
// its items, and every member row. Room's @Transaction annotation gives
// us the wrapping; we put these methods on a dedicated DAO that uses
// raw `@Query` SQL because the operations are pure UPDATE/DELETE
// statements (no cross-DAO Kotlin orchestration needed). For the
// self-revocation sweep we use the `withTransaction { }` extension at
// the SyncEngine layer instead — it's the Room idiom for orchestrating
// multiple DAO calls atomically.

@Dao
public interface SyncTxDao {
    /**
     * Stamp every active item in a list as deleted at `now`. Used by the
     * Mutator's `deleteList` to mirror the backend's cascade soft-delete.
     * The cascade enqueues ONE entry (the list-delete) — the server
     * cascades on its side, so enqueuing N item-deletes too would cause N
     * redundant 404s when the drainer runs.
     */
    @Query(
        "UPDATE items SET deletedAt = :now, updatedAt = :now " +
            "WHERE listId = :listId AND deletedAt IS NULL",
    )
    public suspend fun cascadeSoftDeleteItems(listId: String, now: Instant)
}

// endregion
