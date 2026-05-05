package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.test.core.app.ApplicationProvider
import `in`.santosh_bharadwaj.sharedlist.core.networking.JsonCoders
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Mirrors iOS `MutatorTests`. Same scenarios, plus an extra one for
 * the Kotlin-specific three-state JSON encoding of `checked`:
 *
 *   1. createList writes both the local row and the queue entry in one
 *      transaction (count == 1 of each, both share same `now`).
 *   2. renameList captures the PRIOR `updatedAt` as `ifMatch` so the
 *      drainer's first attempt matches what the server has on disk.
 *   3. deleteList cascades local soft-delete to items but enqueues
 *      ONLY the list-delete entry.
 *   4. createItem auto-positions at max + 1024.
 *   5. patchItem with `LeaveAlone` for `checked` omits the key from
 *      the JSON payload (so the server reads "leave column unchanged").
 *   6. patchItem with `Unchecked` emits literal `null` for `checked`.
 *   7. patchItem with `Checked(at)` emits an iso8601 string.
 *   8. Empty patch throws.
 *   9. Mutator on a missing target is a no-op (no crash).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MutatorTest {

    private lateinit var database: SyncDatabase
    private lateinit var mutator: Mutator
    private val fixedNow = Instant.parse("2026-05-05T12:00:00.500Z")
    private val clock = FixedClock(fixedNow)
    private val uuids = SequenceUuidGenerator()

    @Before
    fun setUp() {
        database = SyncDatabase.inMemory(ApplicationProvider.getApplicationContext())
        mutator = Mutator(database = database, clock = clock, uuidGenerator = uuids)
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun createListPersistsLocalRowAndQueueEntryAtomically() = runTest {
        val id = mutator.createList(name = "Groceries")

        // Local row.
        val row = database.listDao().findById(id)
        assertNotNull(row)
        assertEquals("Groceries", row?.name)
        assertEquals(fixedNow, row?.updatedAt)
        assertEquals(fixedNow, row?.createdAt)

        // Queue entry — same id as the local row.
        val queue = database.mutationQueueDao().all()
        assertEquals(1, queue.size)
        val entry = queue[0]
        assertEquals(MutationOpType.CreateList.key, entry.opType)
        assertEquals(id, entry.targetId)
        assertEquals(fixedNow, entry.createdAt)

        // Payload round-trips back to a CreateListPayload with the same id.
        val payload = JsonCoders.Json.decodeFromString<CreateListPayload>(entry.payload)
        assertEquals(id, payload.id)
        assertEquals("Groceries", payload.name)
    }

    @Test
    fun renameListCapturesPriorUpdatedAtAsIfMatch() = runTest {
        // Seed a list with an older updatedAt so we can verify the
        // captured `ifMatch` matches that, NOT `now`.
        val priorUpdatedAt = Instant.parse("2026-05-05T11:00:00.000Z")
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Old name",
                    createdBy = "",
                    createdAt = priorUpdatedAt,
                    updatedAt = priorUpdatedAt,
                ),
            )
        }

        mutator.renameList(id = "list-1", newName = "New name")

        val row = database.listDao().findById("list-1")
        assertEquals("New name", row?.name)
        assertEquals(fixedNow, row?.updatedAt)

        val entry = database.mutationQueueDao().all().single()
        val payload = JsonCoders.Json.decodeFromString<RenameListPayload>(entry.payload)
        assertEquals(priorUpdatedAt, payload.ifMatch)
        assertEquals("New name", payload.name)
    }

    @Test
    fun deleteListCascadesLocallyButEnqueuesOnlyListEntry() = runTest {
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Shared",
                    createdBy = "",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
            for (n in 1..3) {
                database.itemDao().upsert(
                    ItemEntity(
                        id = "item-$n",
                        listId = "list-1",
                        text = "Item $n",
                        position = n * 1024,
                        createdBy = "",
                        createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                        updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    ),
                )
            }
        }

        mutator.deleteList(id = "list-1")

        // List soft-deleted locally.
        assertNull(database.listDao().findActiveById("list-1"))
        val tomb = database.listDao().findById("list-1")
        assertNotNull(tomb?.deletedAt)
        assertEquals(fixedNow, tomb?.deletedAt)

        // Items also soft-deleted locally (cascade).
        assertEquals(0, database.itemDao().activeItemsInList("list-1").size)

        // But ONE queue entry — for the list, not per-item.
        val queue = database.mutationQueueDao().all()
        assertEquals(1, queue.size)
        assertEquals(MutationOpType.DeleteList.key, queue[0].opType)
    }

    @Test
    fun createItemAutoPositionsAtMaxPlus1024() = runTest {
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Groceries",
                    createdBy = "",
                    createdAt = fixedNow,
                    updatedAt = fixedNow,
                ),
            )
            database.itemDao().upsert(
                ItemEntity(
                    id = "item-existing",
                    listId = "list-1",
                    text = "Bread",
                    position = 2048,
                    createdBy = "",
                    createdAt = fixedNow,
                    updatedAt = fixedNow,
                ),
            )
        }

        val newId = mutator.createItem(listId = "list-1", text = "Milk")

        val row = database.itemDao().findById(newId)
        assertEquals(3072, row?.position)
    }

    @Test
    fun createItemOnEmptyListStartsAt1024() = runTest {
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Groceries",
                    createdBy = "",
                    createdAt = fixedNow,
                    updatedAt = fixedNow,
                ),
            )
        }

        val newId = mutator.createItem(listId = "list-1", text = "Milk")
        assertEquals(1024, database.itemDao().findById(newId)?.position)
    }

    @Test
    fun patchItemLeaveAloneOmitsCheckedKey() = runTest {
        seedItem()
        mutator.patchItem(id = "item-1", text = "Updated")

        val payload = readQueuePayloadAsJson()
        assertEquals(JsonPrimitive("Updated"), payload["text"])
        assertFalse("checked must be absent for LeaveAlone", payload.containsKey("checked"))
    }

    @Test
    fun patchItemUncheckedEmitsLiteralNull() = runTest {
        seedItem(checkedAt = Instant.parse("2026-05-05T11:30:00.000Z"))
        mutator.patchItem(id = "item-1", checkedAt = CheckedAtChange.Unchecked)

        val payload = readQueuePayloadAsJson()
        assertEquals(JsonNull, payload["checked"])
        // Local row reflects the unchecked state.
        assertNull(database.itemDao().findById("item-1")?.checkedAt)
    }

    @Test
    fun patchItemCheckedEmitsIsoString() = runTest {
        seedItem()
        val at = Instant.parse("2026-05-05T12:30:00.123Z")
        mutator.patchItem(id = "item-1", checkedAt = CheckedAtChange.Checked(at))

        val payload = readQueuePayloadAsJson()
        assertEquals(JsonPrimitive("2026-05-05T12:30:00.123Z"), payload["checked"])
        assertEquals(at, database.itemDao().findById("item-1")?.checkedAt)
    }

    @Test
    fun emptyPatchThrows() = runTest {
        seedItem()
        assertThrows(MutatorError.EmptyPatch::class.java) {
            runBlocking { mutator.patchItem(id = "item-1") }
        }
    }

    @Test
    fun mutatorNoOpsOnMissingTarget() = runTest {
        // Should NOT crash; the next reconcile syncs the remote truth.
        mutator.renameList(id = "missing", newName = "x")
        mutator.deleteItem(id = "missing")

        // Queue should be empty — no entries enqueued for missing rows.
        assertTrue(database.mutationQueueDao().all().isEmpty())
    }

    // region Test fixtures

    private suspend fun seedItem(checkedAt: Instant? = null) {
        database.itemDao().upsert(
            ItemEntity(
                id = "item-1",
                listId = "list-1",
                text = "Bread",
                checkedAt = checkedAt,
                position = 1024,
                createdBy = "",
                createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
            ),
        )
    }

    private suspend fun readQueuePayloadAsJson(): JsonObject {
        val entry = database.mutationQueueDao().all().single()
        val element = JsonCoders.Json.parseToJsonElement(entry.payload)
        return element as JsonObject
    }

    // endregion
}

// region Test doubles

class FixedClock(private val instant: Instant) : Clock {
    override fun now(): Instant = instant
}

class SequenceUuidGenerator : UuidGenerator {
    private var counter = 0
    override fun newUuid(): String = "uuid-${++counter}"
}

// endregion
