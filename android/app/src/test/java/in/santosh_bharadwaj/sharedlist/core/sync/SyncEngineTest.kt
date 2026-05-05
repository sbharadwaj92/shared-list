package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.test.core.app.ApplicationProvider
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthUser
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.networking.JsonCoders
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tests for the slice B' read-side reconciler. Mirrors iOS
 * `SyncEngineTests`. Same scenarios:
 *   1. Lists → items → members feed order, with cursors persisted.
 *   2. List/item tombstones remove local rows.
 *   3. Self-revocation member tombstone sweeps list + items + other
 *      members.
 *   4. Other-member tombstone removes only that member row.
 *   5. Cursor round-trip on second pull (the second `?since=` request
 *      includes the previous run's serverTime).
 *   6. Offline reconcile is a silent no-op.
 *   7. Unauthenticated reconcile throws.
 *   8. LWW upsert keeps newer local row when wire row is older.
 *
 * Robolectric is needed to give Room's database builder a real Android
 * Context. The actual database is in-memory and dies with the test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncEngineTest {

    private lateinit var database: SyncDatabase
    private val networkMonitor = FakeNetworkMonitor(initial = true)
    private val sampleUser = AuthUser(
        id = "user-self",
        email = "alice@example.com",
        displayName = "Alice",
    )

    @Before
    fun setUp() {
        database = SyncDatabase.inMemory(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun reconcileAppliesAllThreeFeedsAndPersistsCursors() = runTest {
        val (engine, recorder) = engineWith(
            listsBody = listsBody(
                serverTime = "2026-05-05T12:00:01.000Z",
                rows = listOf(
                    listDto(id = "list-1", name = "Groceries", updatedAt = "2026-05-05T12:00:00.500Z"),
                ),
            ),
            itemsBody = itemsBody(
                serverTime = "2026-05-05T12:00:02.000Z",
                rows = listOf(
                    itemDto(
                        id = "item-1",
                        listId = "list-1",
                        text = "Milk",
                        updatedAt = "2026-05-05T12:00:01.500Z",
                    ),
                ),
            ),
            membersBody = membersBody(
                serverTime = "2026-05-05T12:00:03.000Z",
                rows = listOf(
                    memberDto(
                        listId = "list-1",
                        userId = sampleUser.id,
                        role = "owner",
                        updatedAt = "2026-05-05T12:00:02.500Z",
                    ),
                ),
            ),
        )

        engine.reconcile()

        // Feed order matches docs: lists → items → members.
        assertEquals(3, recorder.requests.size)
        assertEquals("/sync/lists", recorder.requests[0].path)
        assertEquals("/sync/items", recorder.requests[1].path)
        assertEquals("/sync/list_members", recorder.requests[2].path)

        // Local rows landed.
        assertEquals(1, database.listDao().activeLists().size)
        assertEquals(1, database.itemDao().activeItemsInList("list-1").size)
        assertEquals(1, database.memberDao().activeMembersInList("list-1").size)

        // Cursors persisted (one per resource, matching each feed's serverTime).
        val cursors = database.syncCursorDao()
        assertEquals(
            Instant.parse("2026-05-05T12:00:01.000Z"),
            cursors.find(SyncResource.Lists.key)?.serverTime,
        )
        assertEquals(
            Instant.parse("2026-05-05T12:00:02.000Z"),
            cursors.find(SyncResource.Items.key)?.serverTime,
        )
        assertEquals(
            Instant.parse("2026-05-05T12:00:03.000Z"),
            cursors.find(SyncResource.ListMembers.key)?.serverTime,
        )
    }

    @Test
    fun listAndItemTombstonesDeleteLocalRows() = runTest {
        // Pre-seed local rows that the wire feeds will tombstone.
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Groceries",
                    createdBy = "user-self",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
            database.itemDao().upsert(
                ItemEntity(
                    id = "item-1",
                    listId = "list-1",
                    text = "Milk",
                    position = 1024,
                    createdBy = "user-self",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
        }

        val (engine, _) = engineWith(
            listsBody = listsBody(
                serverTime = "2026-05-05T12:00:01.000Z",
                rows = listOf(
                    listDto(
                        id = "list-1",
                        name = "Groceries",
                        updatedAt = "2026-05-05T12:00:00.500Z",
                        deletedAt = "2026-05-05T12:00:00.500Z",
                    ),
                ),
            ),
            itemsBody = itemsBody(
                serverTime = "2026-05-05T12:00:02.000Z",
                rows = listOf(
                    itemDto(
                        id = "item-1",
                        listId = "list-1",
                        text = "Milk",
                        updatedAt = "2026-05-05T12:00:01.500Z",
                        deletedAt = "2026-05-05T12:00:01.500Z",
                    ),
                ),
            ),
            membersBody = membersBody(
                serverTime = "2026-05-05T12:00:03.000Z",
                rows = emptyList(),
            ),
        )

        engine.reconcile()

        assertNull(database.listDao().findById("list-1"))
        assertNull(database.itemDao().findById("item-1"))
    }

    @Test
    fun selfRevocationSweepsListItemsAndAllMembers() = runTest {
        // Seed a list with two items and three member rows (self + two others).
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Shared",
                    createdBy = "user-other",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
            for (n in 1..2) {
                database.itemDao().upsert(
                    ItemEntity(
                        id = "item-$n",
                        listId = "list-1",
                        text = "Item $n",
                        position = n * 1024,
                        createdBy = "user-other",
                        createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                        updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    ),
                )
            }
            for (uid in listOf(sampleUser.id, "user-other-a", "user-other-b")) {
                database.memberDao().upsert(
                    MemberEntity(
                        listId = "list-1",
                        userId = uid,
                        role = if (uid == sampleUser.id) "editor" else "owner",
                        createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                        updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    ),
                )
            }
        }

        val (engine, _) = engineWith(
            listsBody = emptyListsBody("2026-05-05T12:00:01.000Z"),
            itemsBody = emptyItemsBody("2026-05-05T12:00:02.000Z"),
            membersBody = membersBody(
                serverTime = "2026-05-05T12:00:03.000Z",
                rows = listOf(
                    memberDto(
                        listId = "list-1",
                        userId = sampleUser.id,
                        role = "editor",
                        updatedAt = "2026-05-05T12:00:02.500Z",
                        deletedAt = "2026-05-05T12:00:02.500Z",
                    ),
                ),
            ),
        )

        engine.reconcile()

        assertNull(database.listDao().findById("list-1"))
        assertEquals(0, database.itemDao().activeItemsInList("list-1").size)
        // All members of that list gone, including those we never saw a
        // tombstone for — that's the point of the sweep.
        assertEquals(0, database.memberDao().activeMembersInList("list-1").size)
    }

    @Test
    fun otherMemberTombstoneOnlyDeletesThatMember() = runTest {
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Shared",
                    createdBy = "user-self",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
            for (uid in listOf(sampleUser.id, "user-other")) {
                database.memberDao().upsert(
                    MemberEntity(
                        listId = "list-1",
                        userId = uid,
                        role = "owner",
                        createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                        updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    ),
                )
            }
        }

        val (engine, _) = engineWith(
            listsBody = emptyListsBody("2026-05-05T12:00:01.000Z"),
            itemsBody = emptyItemsBody("2026-05-05T12:00:02.000Z"),
            membersBody = membersBody(
                serverTime = "2026-05-05T12:00:03.000Z",
                rows = listOf(
                    memberDto(
                        listId = "list-1",
                        userId = "user-other",
                        role = "owner",
                        updatedAt = "2026-05-05T12:00:02.500Z",
                        deletedAt = "2026-05-05T12:00:02.500Z",
                    ),
                ),
            ),
        )

        engine.reconcile()

        // List and self-membership intact, only the other member's row gone.
        assertNotNull(database.listDao().findById("list-1"))
        assertNotNull(database.memberDao().findById("list-1", sampleUser.id))
        assertNull(database.memberDao().findById("list-1", "user-other"))
    }

    @Test
    fun secondPullEchoesPreviousServerTimeAsSince() = runTest {
        val firstServerTime = "2026-05-05T12:00:01.000Z"
        val (engine, recorder) = engineWith(
            listsBody = listsBody(serverTime = firstServerTime, rows = emptyList()),
            itemsBody = emptyItemsBody("2026-05-05T12:00:02.000Z"),
            membersBody = emptyMembersBody("2026-05-05T12:00:03.000Z"),
        )
        engine.reconcile()

        // Second reconcile — same engine, same recorder, same mock that
        // returns its scripted bodies in the same per-path order. The
        // second sweep of /sync/lists must include the cursor.
        engine.reconcile()

        val secondListsRequest = recorder.requests
            .filter { it.path == "/sync/lists" }
            .last()
        assertTrue(
            "expected `since=` echo on second pull, got ${secondListsRequest.fullPath}",
            secondListsRequest.fullPath.contains("since=2026-05-05T12%3A00%3A01.000Z") ||
                secondListsRequest.fullPath.contains("since=2026-05-05T12:00:01.000Z"),
        )
    }

    @Test
    fun offlineReconcileIsNoOp() = runTest {
        networkMonitor.setOnline(false)
        val (engine, recorder) = engineWith(
            listsBody = emptyListsBody("2026-05-05T12:00:01.000Z"),
            itemsBody = emptyItemsBody("2026-05-05T12:00:02.000Z"),
            membersBody = emptyMembersBody("2026-05-05T12:00:03.000Z"),
        )

        engine.reconcile()

        assertEquals(0, recorder.requests.size)
    }

    @Test(expected = SyncEngineError.NotAuthenticated::class)
    fun unauthenticatedReconcileThrows() = runTest {
        val (engine, _) = engineWith(
            listsBody = emptyListsBody("2026-05-05T12:00:01.000Z"),
            itemsBody = emptyItemsBody("2026-05-05T12:00:02.000Z"),
            membersBody = emptyMembersBody("2026-05-05T12:00:03.000Z"),
            authedUserId = null,
        )
        engine.reconcile()
    }

    @Test
    fun lwwGuardKeepsNewerLocalWhenWireRowIsOlder() = runTest {
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Locally edited (newer)",
                    createdBy = "user-self",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T13:00:00.500Z"),
                ),
            )
        }

        val (engine, _) = engineWith(
            listsBody = listsBody(
                serverTime = "2026-05-05T12:00:01.000Z",
                rows = listOf(
                    listDto(
                        id = "list-1",
                        name = "Server name (older)",
                        updatedAt = "2026-05-05T12:00:00.500Z",
                    ),
                ),
            ),
            itemsBody = emptyItemsBody("2026-05-05T12:00:02.000Z"),
            membersBody = emptyMembersBody("2026-05-05T12:00:03.000Z"),
        )

        engine.reconcile()

        val row = database.listDao().findById("list-1")
        assertEquals("Locally edited (newer)", row?.name)
    }

    // region Test fixtures

    /**
     * Build the SyncEngine wired to a [MockEngine] that responds to each
     * of the three sync paths with the provided body. The engine is
     * stateful: requests beyond the first to a path return that same
     * body (sufficient for the cursor-echo test which makes two passes).
     *
     * Returns the engine plus a [RequestRecorder] so tests can assert
     * which paths were hit and in what order.
     */
    @Suppress("LongParameterList")
    private fun engineWith(
        listsBody: String,
        itemsBody: String,
        membersBody: String,
        authedUserId: String? = sampleUser.id,
    ): Pair<SyncEngine, RequestRecorder> {
        val recorder = RequestRecorder()
        val mock = MockEngine { request ->
            recorder.record(request.url.encodedPath, request.url.toString())
            when (request.url.encodedPath) {
                "/sync/lists" -> respond(
                    content = ByteReadChannel(listsBody),
                    status = HttpStatusCode.OK,
                    headers = headersOf("Content-Type", "application/json"),
                )
                "/sync/items" -> respond(
                    content = ByteReadChannel(itemsBody),
                    status = HttpStatusCode.OK,
                    headers = headersOf("Content-Type", "application/json"),
                )
                "/sync/list_members" -> respond(
                    content = ByteReadChannel(membersBody),
                    status = HttpStatusCode.OK,
                    headers = headersOf("Content-Type", "application/json"),
                )
                else -> error("unexpected path ${request.url.encodedPath}")
            }
        }
        val tokenStore = TokenStore(InMemorySecureStorage())
        if (authedUserId != null) {
            runBlocking {
                tokenStore.save(
                    TokenStore.Tokens(
                        accessToken = "tkn-A",
                        refreshToken = "tkn-R",
                        user = sampleUser.copy(id = authedUserId),
                    ),
                )
            }
        }
        val api = ApiClient(baseUrl = "https://test.invalid", tokenStore = tokenStore, engine = mock)
        val engine = SyncEngine(
            api = api,
            database = database,
            monitor = networkMonitor,
            currentUserId = { authedUserId },
        )
        return engine to recorder
    }

    private val testJson: Json = JsonCoders.Json

    private fun listsBody(serverTime: String, rows: List<ListDto>): String =
        testJson.encodeToString(
            SyncResponseDto(serverTime = Instant.parse(serverTime), rows = rows),
        )

    private fun itemsBody(serverTime: String, rows: List<ItemDto>): String =
        testJson.encodeToString(
            SyncResponseDto(serverTime = Instant.parse(serverTime), rows = rows),
        )

    private fun membersBody(serverTime: String, rows: List<ListMemberDto>): String =
        testJson.encodeToString(
            SyncResponseDto(serverTime = Instant.parse(serverTime), rows = rows),
        )

    private fun emptyListsBody(serverTime: String): String =
        listsBody(serverTime, emptyList())

    private fun emptyItemsBody(serverTime: String): String =
        itemsBody(serverTime, emptyList())

    private fun emptyMembersBody(serverTime: String): String =
        membersBody(serverTime, emptyList())

    @Suppress("LongParameterList")
    private fun listDto(
        id: String,
        name: String,
        createdBy: String = "user-self",
        createdAt: String = "2026-05-05T11:00:00.000Z",
        updatedAt: String,
        deletedAt: String? = null,
    ) = ListDto(
        id = id,
        name = name,
        createdBy = createdBy,
        createdAt = Instant.parse(createdAt),
        updatedAt = Instant.parse(updatedAt),
        deletedAt = deletedAt?.let(Instant::parse),
    )

    @Suppress("LongParameterList")
    private fun itemDto(
        id: String,
        listId: String,
        text: String,
        position: Int = 1024,
        createdBy: String = "user-self",
        createdAt: String = "2026-05-05T11:00:00.000Z",
        updatedAt: String,
        deletedAt: String? = null,
    ) = ItemDto(
        id = id,
        listId = listId,
        text = text,
        position = position,
        createdBy = createdBy,
        createdAt = Instant.parse(createdAt),
        updatedAt = Instant.parse(updatedAt),
        deletedAt = deletedAt?.let(Instant::parse),
    )

    @Suppress("LongParameterList")
    private fun memberDto(
        listId: String,
        userId: String,
        role: String,
        createdAt: String = "2026-05-05T11:00:00.000Z",
        updatedAt: String,
        deletedAt: String? = null,
    ) = ListMemberDto(
        listId = listId,
        userId = userId,
        role = role,
        createdAt = Instant.parse(createdAt),
        updatedAt = Instant.parse(updatedAt),
        deletedAt = deletedAt?.let(Instant::parse),
    )

    private class RequestRecorder {
        data class Recorded(val path: String, val fullPath: String)
        val requests = mutableListOf<Recorded>()
        fun record(path: String, fullPath: String) {
            requests += Recorded(path, fullPath)
        }
    }

    // endregion
}
