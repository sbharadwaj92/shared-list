package `in`.santosh_bharadwaj.sharedlist.core.sync

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/**
 * The on-device cache. Mirrors iOS's `ModelContainer` — a single object
 * that owns every DAO and lives for the AppContainer's lifetime.
 *
 * Schema version is bumped whenever an `@Entity` shape changes.
 * Migrations are deferred until we actually have data we care about
 * across schema versions; for Phase 8 the only deployment is "wipe and
 * recreate" via [Room.databaseBuilder].`fallbackToDestructiveMigration`.
 * That's safe here because the local data is purely a cache — the
 * authoritative copy lives on the backend, and a destructive migration
 * just triggers a fresh full reconcile.
 *
 * Why a single database (vs one per resource):
 *   - Cross-resource transactions need to land in one SQLite file.
 *     The Mutator's `deleteList` cascades soft-delete to items; the
 *     SyncEngine's self-revocation sweep deletes a list, its items,
 *     and members atomically. Splitting into multiple databases would
 *     mean we couldn't wrap those in a single `withTransaction { }`.
 *   - The mutation queue and the resource it mutates need to commit
 *     in one transaction (slice C.2's atomicity contract).
 *
 * Public so [AppContainer] can construct + own it. Open-class isn't
 * required (Room generates `RoomDatabase_Impl` from the abstract
 * declaration) but the abstract DAO accessors below need to compile
 * against the abstract base.
 */
@Database(
    entities = [
        UserEntity::class,
        ListEntity::class,
        ItemEntity::class,
        MemberEntity::class,
        SyncCursorEntity::class,
        MutationQueueEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
@TypeConverters(SyncTypeConverters::class)
public abstract class SyncDatabase : RoomDatabase() {
    public abstract fun listDao(): ListDao
    public abstract fun itemDao(): ItemDao
    public abstract fun memberDao(): MemberDao
    public abstract fun userDao(): UserDao
    public abstract fun syncCursorDao(): SyncCursorDao
    public abstract fun mutationQueueDao(): MutationQueueDao
    public abstract fun syncTxDao(): SyncTxDao

    public companion object {
        /**
         * Production database file name. Lives in the app's private
         * storage directory; survives reinstalls only if the user opted
         * into Android's auto-backup (which we don't enable for v1 — the
         * cache is recreated from the backend on a fresh install).
         */
        public const val DATABASE_NAME: String = "shared_list_sync.db"

        /** Build the production database. Called once from [AppContainer]. */
        public fun create(context: Context): SyncDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                SyncDatabase::class.java,
                DATABASE_NAME,
            )
                .fallbackToDestructiveMigration()
                .build()

        /**
         * Test/preview seam — in-memory database that's destroyed when
         * the process exits. Used by JUnit tests so they don't need
         * Robolectric to run, and by `@Preview` composables so the
         * preview runner doesn't write to the device's real database.
         *
         * `allowMainThreadQueries()` is on because tests call DAOs from
         * the JUnit thread directly; production code is suspend-only
         * and never blocks the main thread.
         */
        public fun inMemory(context: Context): SyncDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, SyncDatabase::class.java)
                .allowMainThreadQueries()
                .build()
    }
}
