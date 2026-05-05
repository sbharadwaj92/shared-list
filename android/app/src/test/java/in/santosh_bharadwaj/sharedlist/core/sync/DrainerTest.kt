package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.test.core.app.ApplicationProvider
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthUser
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Mirrors iOS `DrainerTests`. Covers:
 *   1. Successful POST /lists removes the queue entry.
 *   2. Successful PATCH /lists/:id removes the entry; uses `If-Match` header.
 *   3. 409 on PATCH applies the server's `latest`, retries with merged
 *      state, removes on second 200.
 *   4. Repeated 409 (after reconcile) marks the entry `failed`.
 *   5. 404 on PATCH /lists/:id removes the entry (server tombstoned).
 *   6. 5xx requeues with retryCount++.
 *   7. Network/transport failure requeues.
 *   8. 403 marks failed.
 *   9. Stale `inFlight` rows reset to `pending` on Drainer init.
 *  10. PATCH /items/:id 409 path applies item LWW, rebuilds wire body
 *      from local truth, retries.
 *  11. createItem looks up listId from the local row and POSTs to
 *      `/lists/<listId>/items`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DrainerTest {

    private lateinit var database: SyncDatabase
    private val sampleUser = AuthUser(id = "u1", email = "alice@example.com", displayName = "Alice")

    @Before
    fun setUp() {
        database = SyncDatabase.inMemory(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun successfulCreateListRemovesQueueEntry() = runTest {
        val ctx = drainerWith { request ->
            assertEquals("/lists", request.url.encodedPath)
            assertEquals("POST", request.method.value)
            respondJson("""{"id":"list-1","name":"Groceries","createdBy":"u1","createdAt":"2026-05-05T12:00:00.500Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}""")
        }
        // Seed local state + queue entry.
        seedQueue(
            entry = MutationQueueEntity(
                id = "q1",
                opType = MutationOpType.CreateList.key,
                targetId = "list-1",
                payload = """{"id":"list-1","name":"Groceries"}""",
                createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
            ),
        )

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
    }

    @Test
    fun successfulRenameListSendsIfMatchHeader() = runTest {
        val capturedHeaders = mutableMapOf<String, String>()
        val ctx = drainerWith { request ->
            request.headers.entries().forEach { e -> capturedHeaders[e.key] = e.value.first() }
            respondJson("""{"id":"list-1","name":"New","createdBy":"u1","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}""")
        }
        seedListAndQueue(
            ifMatch = Instant.parse("2026-05-05T11:00:00.000Z"),
            opType = MutationOpType.RenameList,
            payload = """{"name":"New","ifMatch":"2026-05-05T11:00:00.000Z"}""",
        )

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
        assertEquals("2026-05-05T11:00:00.000Z", capturedHeaders["If-Match"])
    }

    @Test
    fun conflictRenameAppliesLatestAndRetries() = runTest {
        var firstCall = true
        val ifMatchValues = mutableListOf<String>()
        val ctx = drainerWith { request ->
            ifMatchValues += request.headers["If-Match"].orEmpty()
            if (firstCall) {
                firstCall = false
                // 409 with the server's `latest` — newer than what
                // the client sent, but the merged local row should
                // win on round 2 because we just bumped `updatedAt`
                // through the LWW upsert.
                respondJson(
                    status = HttpStatusCode.Conflict,
                    body = """{"error":{"code":"conflict","message":"version mismatch","requestId":"r"},"latest":{"id":"list-1","name":"Server name","createdBy":"u1","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T11:30:00.000Z","deletedAt":null}}""",
                )
            } else {
                respondJson("""{"id":"list-1","name":"Server name","createdBy":"u1","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}""")
            }
        }
        // Seed local list with a stale updatedAt so the LWW upsert
        // overwrites it with the server's row on the 409 path.
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "list-1",
                    name = "Local name",
                    createdBy = "u1",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
            database.mutationQueueDao().insert(
                MutationQueueEntity(
                    id = "q1",
                    opType = MutationOpType.RenameList.key,
                    targetId = "list-1",
                    payload = """{"name":"Renamed","ifMatch":"2026-05-05T11:00:00.000Z"}""",
                    createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
                ),
            )
        }

        ctx.drainer.tick()

        // First attempt sent the original ifMatch, second attempt
        // sent the LWW-merged updatedAt (which is the server's `latest`
        // value because that was newer).
        assertEquals(2, ifMatchValues.size)
        assertEquals("2026-05-05T11:00:00.000Z", ifMatchValues[0])
        assertEquals("2026-05-05T11:30:00.000Z", ifMatchValues[1])
        assertTrue(database.mutationQueueDao().all().isEmpty())
        // Local row is now the merged state (server name, server updatedAt).
        val merged = database.listDao().findById("list-1")
        assertEquals("Server name", merged?.name)
    }

    @Test
    fun repeatedConflictMarksFailed() = runTest {
        val ctx = drainerWith { _ ->
            respondJson(
                status = HttpStatusCode.Conflict,
                body = """{"error":{"code":"conflict","message":"version","requestId":"r"},"latest":{"id":"list-1","name":"Server","createdBy":"u1","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T11:30:00.000Z","deletedAt":null}}""",
            )
        }
        seedListAndQueue(
            ifMatch = Instant.parse("2026-05-05T11:00:00.000Z"),
            opType = MutationOpType.RenameList,
            payload = """{"name":"x","ifMatch":"2026-05-05T11:00:00.000Z"}""",
        )

        ctx.drainer.tick()

        val entries = database.mutationQueueDao().all()
        assertEquals(1, entries.size)
        assertEquals(MutationStatus.Failed.key, entries[0].status)
        assertNotNull(entries[0].lastError)
    }

    @Test
    fun notFoundOnPatchRemovesEntry() = runTest {
        val ctx = drainerWith { _ ->
            respondError(HttpStatusCode.NotFound)
        }
        seedListAndQueue(
            ifMatch = Instant.parse("2026-05-05T11:00:00.000Z"),
            opType = MutationOpType.RenameList,
            payload = """{"name":"x","ifMatch":"2026-05-05T11:00:00.000Z"}""",
        )

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
    }

    @Test
    fun fiveHundredRequeuesWithRetryCount() = runTest {
        val ctx = drainerWith { _ ->
            respondError(HttpStatusCode.InternalServerError)
        }
        seedQueue(
            entry = MutationQueueEntity(
                id = "q1",
                opType = MutationOpType.CreateList.key,
                targetId = "list-1",
                payload = """{"id":"list-1","name":"Groceries"}""",
                createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
            ),
        )

        ctx.drainer.tick()

        val entries = database.mutationQueueDao().all()
        assertEquals(1, entries.size)
        assertEquals(MutationStatus.Pending.key, entries[0].status)
        assertEquals(1, entries[0].retryCount)
    }

    @Test
    fun transportFailureRequeues() = runTest {
        val ctx = drainerWith { _ ->
            error("synthetic IOException")
        }
        seedQueue(
            entry = MutationQueueEntity(
                id = "q1",
                opType = MutationOpType.CreateList.key,
                targetId = "list-1",
                payload = """{"id":"list-1","name":"Groceries"}""",
                createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
            ),
        )

        ctx.drainer.tick()

        val entries = database.mutationQueueDao().all()
        assertEquals(1, entries.size)
        assertEquals(MutationStatus.Pending.key, entries[0].status)
        assertEquals(1, entries[0].retryCount)
    }

    @Test
    fun forbiddenMarksFailed() = runTest {
        val ctx = drainerWith { _ ->
            respondError(HttpStatusCode.Forbidden)
        }
        seedListAndQueue(
            ifMatch = Instant.parse("2026-05-05T11:00:00.000Z"),
            opType = MutationOpType.RenameList,
            payload = """{"name":"x","ifMatch":"2026-05-05T11:00:00.000Z"}""",
        )

        ctx.drainer.tick()

        val entries = database.mutationQueueDao().all()
        assertEquals(1, entries.size)
        assertEquals(MutationStatus.Failed.key, entries[0].status)
    }

    @Test
    fun staleInFlightRowsResetOnInit() = runTest {
        // Simulate a row that was left at `inFlight` by a crash mid-request.
        runBlocking {
            database.mutationQueueDao().insert(
                MutationQueueEntity(
                    id = "q-stale",
                    opType = MutationOpType.CreateList.key,
                    targetId = "list-1",
                    payload = """{"id":"list-1","name":"X"}""",
                    createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
                    status = MutationStatus.InFlight.key,
                ),
            )
        }
        // Build the drainer — its init block should reset stale rows
        // back to `pending`.
        val ctx = drainerWith { _ ->
            respondJson("""{"id":"list-1","name":"X","createdBy":"u1","createdAt":"2026-05-05T12:00:00.500Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}""")
        }
        // Yield once to let the `init { scope.launch { resetStaleInFlight } }`
        // coroutine run.
        ctx.scope.testScheduler.advanceUntilIdle()

        val resetEntry = database.mutationQueueDao().findById("q-stale")
        assertEquals(MutationStatus.Pending.key, resetEntry?.status)
    }

    @Test
    fun itemPatchConflictRebuildsFromLocalTruth() = runTest {
        var firstCall = true
        val secondBodies = mutableListOf<String>()
        val ctx = drainerWith { request ->
            if (firstCall) {
                firstCall = false
                respondJson(
                    status = HttpStatusCode.Conflict,
                    body = """{"error":{"code":"conflict","message":"v","requestId":"r"},"latest":{"id":"item-1","listId":"list-1","text":"Server","checked":null,"position":2048,"createdBy":"u1","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T11:30:00.000Z","deletedAt":null}}""",
                )
            } else {
                // Capture the rebuilt body so the assertion can verify
                // it carries server-merged truth. For our patch path
                // the body is a `TextContent` (string body + JSON
                // content type); extract via the OutgoingContent helper.
                secondBodies += outgoingContentText(request.body)
                respondJson("""{"id":"item-1","listId":"list-1","text":"Server","checked":null,"position":2048,"createdBy":"u1","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}""")
            }
        }
        runBlocking {
            database.itemDao().upsert(
                ItemEntity(
                    id = "item-1",
                    listId = "list-1",
                    text = "Local",
                    position = 1024,
                    createdBy = "u1",
                    createdAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                    updatedAt = Instant.parse("2026-05-05T11:00:00.000Z"),
                ),
            )
            database.mutationQueueDao().insert(
                MutationQueueEntity(
                    id = "q1",
                    opType = MutationOpType.PatchItem.key,
                    targetId = "item-1",
                    payload = """{"text":"Local","ifMatch":"2026-05-05T11:00:00.000Z"}""",
                    createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
                ),
            )
        }

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
        // Second body uses the server-merged values (text="Server",
        // position=2048, checked=null) — that's what "rebuild from
        // local truth post-LWW" gives us, since the merge installed
        // the server's row as the local row.
        assertEquals(1, secondBodies.size)
        val secondBody = secondBodies.single()
        assertTrue("expected `text:Server` in rebuilt body, got $secondBody", secondBody.contains("\"text\":\"Server\""))
        assertTrue("expected position 2048 in rebuilt body, got $secondBody", secondBody.contains("\"position\":2048"))
    }

    @Test
    fun createItemLooksUpListIdFromLocalRow() = runTest {
        val capturedPaths = mutableListOf<String>()
        val ctx = drainerWith { request ->
            capturedPaths += request.url.encodedPath
            respondJson("""{"id":"item-1","listId":"list-1","text":"Milk","checked":null,"position":1024,"createdBy":"u1","createdAt":"2026-05-05T12:00:00.500Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}""")
        }
        runBlocking {
            database.itemDao().upsert(
                ItemEntity(
                    id = "item-1",
                    listId = "list-1",
                    text = "Milk",
                    position = 1024,
                    createdBy = "",
                    createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
                    updatedAt = Instant.parse("2026-05-05T12:00:00.500Z"),
                ),
            )
            database.mutationQueueDao().insert(
                MutationQueueEntity(
                    id = "q1",
                    opType = MutationOpType.CreateItem.key,
                    targetId = "item-1",
                    payload = """{"id":"item-1","text":"Milk","position":1024}""",
                    createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
                ),
            )
        }

        ctx.drainer.tick()

        // Path uses the listId from the local item row.
        assertEquals(listOf("/lists/list-1/items"), capturedPaths)
        assertTrue(database.mutationQueueDao().all().isEmpty())
    }

    // region Test fixtures

    private data class DrainerCtx(
        val drainer: Drainer,
        val scope: TestScope,
    )

    /**
     * Build the drainer + dependencies with a script that responds to
     * each HTTP request via the supplied lambda. Uses a [TestScope] so
     * tick/init coroutines run synchronously under
     * `advanceUntilIdle()`.
     */
    private fun TestScope.drainerWith(
        responder: io.ktor.client.engine.mock.MockRequestHandleScope.(
            io.ktor.client.request.HttpRequestData,
        ) -> io.ktor.client.request.HttpResponseData,
    ): DrainerCtx {
        val mock = MockEngine { request -> responder(request) }
        val tokenStore = TokenStore(InMemorySecureStorage())
        runBlocking {
            tokenStore.save(
                TokenStore.Tokens(
                    accessToken = "tkn-A",
                    refreshToken = "tkn-R",
                    user = sampleUser,
                ),
            )
        }
        val api = ApiClient(baseUrl = "https://test.invalid", tokenStore = tokenStore, engine = mock)
        val monitor = FakeNetworkMonitor(initial = true)
        val syncEngine = SyncEngine(
            api = api,
            database = database,
            monitor = monitor,
            currentUserId = { sampleUser.id },
        )
        val drainer = Drainer(
            api = api,
            database = database,
            syncEngine = syncEngine,
            monitor = monitor,
            scope = this,
        )
        return DrainerCtx(drainer, this)
    }

    private suspend fun seedQueue(entry: MutationQueueEntity) {
        database.mutationQueueDao().insert(entry)
    }

    private suspend fun seedListAndQueue(
        ifMatch: Instant,
        opType: MutationOpType,
        payload: String,
    ) {
        database.listDao().upsert(
            ListEntity(
                id = "list-1",
                name = "Local",
                createdBy = "u1",
                createdAt = ifMatch,
                updatedAt = ifMatch,
            ),
        )
        database.mutationQueueDao().insert(
            MutationQueueEntity(
                id = "q1",
                opType = opType.key,
                targetId = "list-1",
                payload = payload,
                createdAt = Instant.parse("2026-05-05T12:00:00.500Z"),
            ),
        )
    }

    private fun io.ktor.client.engine.mock.MockRequestHandleScope.respondJson(
        body: String,
        status: HttpStatusCode = HttpStatusCode.OK,
    ): io.ktor.client.request.HttpResponseData = respond(
        content = ByteReadChannel(body),
        status = status,
        headers = headersOf("Content-Type", "application/json"),
    )

    /**
     * Extract the body bytes from a [io.ktor.http.content.OutgoingContent].
     * The drainer sends string bodies (already JSON-encoded by hand) for
     * the patch path; Ktor wraps those in [io.ktor.http.content.TextContent].
     */
    private fun outgoingContentText(content: io.ktor.http.content.OutgoingContent): String =
        when (content) {
            is io.ktor.http.content.TextContent -> content.text
            is io.ktor.http.content.ByteArrayContent -> content.bytes().decodeToString()
            else -> error("unhandled OutgoingContent type: ${content::class}")
        }

    // endregion
}
