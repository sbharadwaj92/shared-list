package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.test.core.app.ApplicationProvider
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthUser
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
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
 * Mirrors iOS `SyncFuzzTests`. Same four hostile scenarios — slice D'
 * fences in the Phase 7 wire-protocol contract on the Android port:
 *
 *   1. Rapid create-delete-create — exercises queue ordering AND the
 *      cascade-during-pending-creates interaction. A tombstoned list
 *      with a pending create-item entry would be a nasty end-state.
 *   2. Simultaneous local edits drain in chained-If-Match order. Pins
 *      the "Mutator pre-stamps updatedAt at call time + drainer sends
 *      each in createdAt order" contract. Forces 1ms gaps via an
 *      [AdvancingClock] to model two distinct user actions arriving
 *      at distinct millisecond ticks (a fast machine could collapse
 *      otherwise).
 *   3. Edit-on-deleted (server-side delete while local edit pending) —
 *      drainer should treat 404 on PATCH as success-shape, not crash,
 *      not keep retrying.
 *   4. List deleted while items have pending mutations — the most
 *      load-bearing tombstone scenario. Pins the optimistic case where
 *      the item PATCH lands BEFORE the list DELETE; the harder case
 *      (item PATCH races against an already-deleted server list) is
 *      covered by scenario 3.
 *
 * All scenarios drive the system through the public Mutator → Drainer
 * surface against a scripted MockEngine. The MockEngine is the mock
 * seam, not the SyncEngine — the wire contract is already pinned by
 * the backend's slice-C.1 integration tests, and the env-gated
 * [DrainerIntegrationTest] runs against the real server.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncFuzzTest {

    private lateinit var database: SyncDatabase

    @Before
    fun setUp() {
        database = SyncDatabase.inMemory(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() {
        database.close()
    }

    // region 1. Rapid create-delete-create

    @Test
    fun rapidCreateDeleteCreateConverges() = runTest {
        val ctx = environment(
            scope = this,
            responder = scriptedResponder(
                paths = listOf(
                    // Three creates (POST /lists) then three deletes
                    // (DELETE /lists/<id>) — the drainer dispatches in
                    // queue createdAt order, which is exactly that
                    // interleave: c1 → d1 → c2 → d2 → c3 → d3.
                    "/lists" to OK_LIST,
                    "*delete*" to NO_CONTENT,
                    "/lists" to OK_LIST,
                    "*delete*" to NO_CONTENT,
                    "/lists" to OK_LIST,
                    "*delete*" to NO_CONTENT,
                ),
            ),
        )

        val createdIds = mutableListOf<String>()
        for (cycle in 0 until 3) {
            val id = ctx.mutator.createList(name = "cycle-$cycle")
            createdIds += id
            ctx.mutator.deleteList(id = id)
        }
        assertEquals(6, database.mutationQueueDao().all().size)

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
        // Each list is locally tombstoned (the local cascade ran before
        // any HTTP fired; we just verify it didn't get unwound).
        for (id in createdIds) {
            val row = database.listDao().findById(id)
            assertNotNull("list $id should exist (tombstoned)", row)
            assertNotNull("list $id should be tombstoned", row?.deletedAt)
        }
    }

    // endregion

    // region 2. Simultaneous local edits drain in chained-If-Match order

    @Test
    fun simultaneousLocalEditsDrainInOrder() = runTest {
        val capturedIfMatch = mutableListOf<String>()
        val clock = AdvancingClock(start = Instant.parse("2026-05-05T12:00:00.000Z"))
        val ctx = environment(
            scope = this,
            clock = clock,
            responder = { request ->
                capturedIfMatch += request.headers["If-Match"].orEmpty()
                respondJson(OK_LIST)
            },
        )

        // Seed a list at the clock's current value. The first rename's
        // ifMatch will be this value (because we advance BEFORE call 1).
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "L1",
                    name = "v0",
                    createdBy = "u",
                    createdAt = clock.now(),
                    updatedAt = clock.now(),
                ),
            )
        }

        // Three rapid renames with explicit 1ms advances BEFORE each
        // call. The advance has to come before call N because each
        // call's `ifMatch` is the row's pre-call updatedAt — if we
        // don't advance first, call N+1 reads the same updatedAt that
        // call N's local apply just wrote, and the chained If-Match
        // values collapse.
        clock.advance(millis = 1)
        ctx.mutator.renameList(id = "L1", newName = "v1")
        clock.advance(millis = 1)
        ctx.mutator.renameList(id = "L1", newName = "v2")
        clock.advance(millis = 1)
        ctx.mutator.renameList(id = "L1", newName = "v3")

        assertEquals(3, database.mutationQueueDao().all().size)

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
        assertEquals(3, capturedIfMatch.size)
        // Strictly-increasing If-Match chain — the load-bearing LWW
        // invariant. Without monotonic If-Match values, the second
        // PATCH would 409 even though we sent it from a single
        // device's serialized queue.
        for (i in 1 until capturedIfMatch.size) {
            assertTrue(
                "If-Match should advance: prev=${capturedIfMatch[i - 1]}, curr=${capturedIfMatch[i]}",
                capturedIfMatch[i] > capturedIfMatch[i - 1],
            )
        }
        assertEquals("v3", database.listDao().findById("L1")?.name)
    }

    // endregion

    // region 3. Edit-on-server-deleted

    @Test
    fun editOnServerDeletedRowDrainsCleanly() = runTest {
        val ctx = environment(
            scope = this,
            responder = { _ ->
                // Server says the row is gone — the drainer should
                // treat 404 on PATCH as success-shape (idempotent),
                // remove the queue entry, and let the next reconcile
                // sweep the local row via the tombstone feed.
                respond(
                    content = ByteReadChannel(""),
                    status = HttpStatusCode.NotFound,
                    headers = headersOf("Content-Type", "application/json"),
                )
            },
        )

        val priorUpdated = Instant.parse("2026-05-05T11:00:00.000Z")
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "L1",
                    name = "before",
                    createdBy = "u",
                    createdAt = priorUpdated,
                    updatedAt = priorUpdated,
                ),
            )
        }
        ctx.mutator.renameList(id = "L1", newName = "after")

        ctx.drainer.tick()

        assertTrue(database.mutationQueueDao().all().isEmpty())
        // Local row stays — the drainer doesn't sweep on 404; the next
        // /sync/lists pull will. Test the contract, not extra cleanup.
        assertNotNull(database.listDao().findById("L1"))
    }

    // endregion

    // region 4. List deleted while items have pending mutations

    @Test
    fun listDeletedWhileItemsHavePendingMutationsConverges() = runTest {
        val capturedPaths = mutableListOf<String>()
        val ctx = environment(
            scope = this,
            responder = { request ->
                capturedPaths += request.url.encodedPath
                when {
                    request.url.encodedPath.startsWith("/items/") ->
                        respondJson(OK_ITEM)
                    request.url.encodedPath.startsWith("/lists/") ->
                        respond(
                            content = ByteReadChannel(""),
                            status = HttpStatusCode.NoContent,
                            headers = headersOf("Content-Type", "application/json"),
                        )
                    else -> error("unexpected path: ${request.url.encodedPath}")
                }
            },
        )

        val priorUpdated = Instant.parse("2026-05-05T11:00:00.000Z")
        runBlocking {
            database.listDao().upsert(
                ListEntity(
                    id = "L1",
                    name = "shopping",
                    createdBy = "u",
                    createdAt = priorUpdated,
                    updatedAt = priorUpdated,
                ),
            )
            database.itemDao().upsert(
                ItemEntity(
                    id = "I1",
                    listId = "L1",
                    text = "milk",
                    position = 1024,
                    createdBy = "u",
                    createdAt = priorUpdated,
                    updatedAt = priorUpdated,
                ),
            )
        }

        // (2) Patch the item, (3) delete the parent list. Local
        // cascade tombstones the item.
        ctx.mutator.patchItem(id = "I1", text = "almond milk")
        ctx.mutator.deleteList(id = "L1")

        // Local state immediately after step 3: list tombstoned, item
        // tombstoned (cascade), 2 queue entries (item PATCH + list
        // DELETE).
        assertNotNull(database.listDao().findById("L1")?.deletedAt)
        assertNotNull(database.itemDao().findById("I1")?.deletedAt)
        assertEquals(2, database.mutationQueueDao().all().size)

        ctx.drainer.tick()

        // Convergence: queue empty, local rows still tombstoned, paths
        // hit in createdAt order (PATCH /items/I1 then DELETE /lists/L1).
        assertTrue(database.mutationQueueDao().all().isEmpty())
        assertNotNull(database.listDao().findById("L1")?.deletedAt)
        assertNotNull(database.itemDao().findById("I1")?.deletedAt)
        assertEquals(2, capturedPaths.size)
        assertEquals("/items/I1", capturedPaths[0])
        assertEquals("/lists/L1", capturedPaths[1])
    }

    // endregion

    // region Test fixtures

    private data class FuzzEnv(
        val mutator: Mutator,
        val drainer: Drainer,
    )

    @Suppress("LongParameterList")
    private fun environment(
        scope: TestScope,
        clock: Clock = SystemClock(),
        responder: io.ktor.client.engine.mock.MockRequestHandleScope.(
            io.ktor.client.request.HttpRequestData,
        ) -> io.ktor.client.request.HttpResponseData,
    ): FuzzEnv {
        val mock = MockEngine { request -> responder(request) }
        val tokenStore = TokenStore(InMemorySecureStorage())
        runBlocking {
            tokenStore.save(
                TokenStore.Tokens(
                    accessToken = "tkn-A",
                    refreshToken = "tkn-R",
                    user = AuthUser(id = "user-1", email = "test@example.com", displayName = "Test"),
                ),
            )
        }
        val api = ApiClient(baseUrl = "https://test.invalid", tokenStore = tokenStore, engine = mock)
        val monitor = FakeNetworkMonitor(initial = true)
        val syncEngine = SyncEngine(
            api = api,
            database = database,
            monitor = monitor,
            currentUserId = { tokenStore.current?.user?.id },
        )
        val mutator = Mutator(database = database, clock = clock)
        val drainer = Drainer(
            api = api,
            database = database,
            syncEngine = syncEngine,
            monitor = monitor,
            scope = scope,
        )
        // Note we deliberately do NOT call `mutator.attachDrainer` here.
        // Why: under `runTest` + a `TestScope`, every `kick()` queues
        // a coroutine in the same scope; suspension points inside
        // mutator calls (the Room DAO awaits) can yield to those kick
        // coroutines and they drain queue entries before the test
        // assertions see the full pre-drain queue. Tests in this file
        // build the queue with all six (or two, or three) entries
        // first, THEN call `drainer.tick()` explicitly. Production
        // code wires both ends via [Mutator.attachDrainer]; the
        // [DrainerTest] suite covers that path.
        return FuzzEnv(mutator, drainer)
    }

    /**
     * Build a responder from a sequence of (path, body) pairs. Each
     * incoming request consumes the next entry; the entry's path is a
     * sanity check (`*delete*` matches any path starting with `/lists/`
     * + an id; otherwise exact match). Tests use this when they care
     * about the order of responses but not which physical paths were
     * hit (those are pinned by other assertions).
     */
    private fun scriptedResponder(
        paths: List<Pair<String, String>>,
    ): io.ktor.client.engine.mock.MockRequestHandleScope.(
        io.ktor.client.request.HttpRequestData,
    ) -> io.ktor.client.request.HttpResponseData {
        val queue = ArrayDeque(paths)
        return scope@{ request ->
            val (expected, body) = queue.removeFirst()
            // Validate the path roughly matches the script's expectation.
            val matches = when {
                expected == "*delete*" -> request.url.encodedPath.startsWith("/lists/") &&
                    request.method.value == "DELETE"
                else -> request.url.encodedPath == expected
            }
            check(matches) {
                "scripted responder: expected $expected, got " +
                    "${request.method.value} ${request.url.encodedPath}"
            }
            if (expected == "*delete*") {
                respond(
                    content = ByteReadChannel(""),
                    status = HttpStatusCode.NoContent,
                    headers = headersOf("Content-Type", "application/json"),
                )
            } else {
                respond(
                    content = ByteReadChannel(body),
                    status = HttpStatusCode.OK,
                    headers = headersOf("Content-Type", "application/json"),
                )
            }
        }
    }

    private fun io.ktor.client.engine.mock.MockRequestHandleScope.respondJson(
        body: String,
    ): io.ktor.client.request.HttpResponseData = respond(
        content = ByteReadChannel(body),
        status = HttpStatusCode.OK,
        headers = headersOf("Content-Type", "application/json"),
    )

    // endregion

    /**
     * Test clock with explicit `advance(millis:)` so timestamp-sensitive
     * fuzz scenarios can model "two distinct user actions arrived at
     * distinct millisecond ticks" without relying on `Instant.now()`'s
     * wall-clock granularity (which can collapse rapid Mutator calls
     * into the same instant on a fast machine).
     */
    private class AdvancingClock(start: Instant) : Clock {
        private var current: Instant = start
        override fun now(): Instant = current
        fun advance(millis: Long) {
            current = current.plusMillis(millis)
        }
    }

    private companion object {
        const val OK_LIST = """{"id":"X","name":"X","createdBy":"u","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}"""
        const val OK_ITEM = """{"id":"I1","listId":"L1","text":"almond milk","checked":null,"position":1024,"createdBy":"u","createdAt":"2026-05-05T11:00:00.000Z","updatedAt":"2026-05-05T12:00:00.500Z","deletedAt":null}"""
        const val NO_CONTENT = ""
    }
}
