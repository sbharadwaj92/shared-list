package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.test.core.app.ApplicationProvider
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthUser
import `in`.santosh_bharadwaj.sharedlist.core.auth.RefreshBody
import `in`.santosh_bharadwaj.sharedlist.core.auth.SignupBody
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import io.ktor.http.HttpMethod
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Drainer integration tests for slice C.3' — env-gated against a real
 * running backend. Mirrors iOS [DrainerIntegrationTests].
 *
 * Why env-gated rather than self-bootstrapping (Bun + Postgres in
 * `@Before`):
 *   - PLAN.md L380's "Done" criterion is "the sync engine does the
 *     full offline-mutate / reconnect / reconcile / tombstone-converge
 *     cycle against the real backend." It doesn't dictate test-bootstrap
 *     mechanics.
 *   - Booting Bun + Postgres from JUnit via `Process` adds a meaningful
 *     pile of cross-platform/CI fragility (DOCKER_HOST detection, Bun
 *     install path, port collisions, lifecycle on test crash) for no
 *     gain in correctness — a real backend at `BACKEND_URL` is just as
 *     "real" whether the test launched it or not.
 *   - Locally, dev already runs the backend continuously (`bun run dev`)
 *     and the Android app talks to it. The integration test reproduces
 *     that dev-time setup.
 *
 * How to run:
 *   - Locally: `cd backend && bun run dev` in one terminal, then
 *     `BACKEND_URL=https://Santoshs-MacBook-Pro-48.local ./gradlew testDebugUnitTest`.
 *   - In CI: deferred (mirrors iOS — see commit 65f1305 for the
 *     "leave-as-manual-pre-merge" decision rationale; revisit in
 *     Phase 19 polish).
 *   - Without BACKEND_URL: every test in this file calls
 *     `assumeTrue` which marks the run as skipped, so the suite is
 *     invisible from a plain `./gradlew testDebugUnitTest` invocation.
 *
 * What's covered (small, focused — slice C.3' cycle):
 *   1. POST → drain → reconcile: local create round-trips through the
 *      backend and the canonical row reappears on the next sync.
 *   2. Offline mutate → reconnect → drain → reconcile: the Mutator
 *      enqueues while offline (network monitor stub flips to false),
 *      the drainer is a no-op, then we go online and the queued
 *      mutation drains successfully on the next kick.
 *
 * Slice D's tombstone-fuzz tests live in [SyncFuzzTest] (mock-driven,
 * always-runs); this file's two tests fence in the wire-protocol
 * contract end-to-end.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DrainerIntegrationTest {

    private lateinit var database: SyncDatabase
    private val backendUrl: String? = System.getenv("BACKEND_URL")

    @Before
    fun setUp() {
        // assumeTrue causes JUnit 4 to mark the test as skipped (rather
        // than failed) when BACKEND_URL is unset. The runner output
        // shows "skipped" with no noise; CI's plain `testDebugUnitTest`
        // run never hits this code.
        assumeTrue(
            "BACKEND_URL not set — set it to a running backend (e.g. " +
                "https://Santoshs-MacBook-Pro-48.local) to enable these tests",
            backendUrl != null,
        )
        database = SyncDatabase.inMemory(ApplicationProvider.getApplicationContext())
    }

    @After
    fun tearDown() {
        if (::database.isInitialized) database.close()
    }

    @Test
    fun createListRoundTripsThroughBackend() = runTest {
        val ctx = makeEnvironment()

        val id = ctx.mutator.createList(name = "C3 round-trip ${uniqueSuffix()}")
        ctx.drainer.tick()

        // Queue should be empty after a successful drain.
        val queue = database.mutationQueueDao().all()
        assertTrue("expected queue empty after drain, found ${queue.size}", queue.isEmpty())

        // Pull the canonical row back via /sync/lists.
        ctx.syncEngine.reconcile()
        val list = database.listDao().findById(id)
        assertNotNull("expected local row $id after reconcile", list)
    }

    @Test
    fun offlineMutateThenReconnectDrains() = runTest {
        val ctx = makeEnvironment()

        // Go offline; create locally.
        ctx.monitor.setOnline(false)
        val id = ctx.mutator.createList(name = "C3 offline ${uniqueSuffix()}")

        // Drain attempt while offline is a no-op — kick should bail
        // immediately because the monitor is offline.
        ctx.drainer.kick()

        // Queue still has the entry, untouched.
        val mid = database.mutationQueueDao().all()
        assertTrue("queue should still contain offline mutation", mid.isNotEmpty())

        // Go online and drain explicitly.
        ctx.monitor.setOnline(true)
        ctx.drainer.tick()

        val queueAfter = database.mutationQueueDao().all()
        assertTrue("expected queue empty after reconnect-drain, found ${queueAfter.size}", queueAfter.isEmpty())

        // Reconcile picks up the canonical row.
        ctx.syncEngine.reconcile()
        assertNotNull(database.listDao().findById(id))
    }

    // region Test fixtures

    private data class IntegrationCtx(
        val mutator: Mutator,
        val drainer: Drainer,
        val syncEngine: SyncEngine,
        val monitor: FakeNetworkMonitor,
    )

    /**
     * Sign up a fresh user against the live backend so each test run
     * starts with an isolated session. Reuses the production
     * [ApiClient] to drive the auth flow; afterwards a real
     * [Mutator] / [Drainer] / [SyncEngine] target the same base URL.
     */
    private suspend fun makeEnvironment(): IntegrationCtx {
        val baseUrl = requireNotNull(backendUrl) { "BACKEND_URL guard failed" }
        val tokenStore = TokenStore(InMemorySecureStorage())
        val api = ApiClient(baseUrl = baseUrl, tokenStore = tokenStore)

        // Sign up a fresh user. The unique suffix avoids cross-run
        // collisions on a single backend's `users.email` constraint.
        val email = "fuzz-${uniqueSuffix()}@example.test"
        val authResponse: `in`.santosh_bharadwaj.sharedlist.core.auth.AuthResponse = api.send(
            method = HttpMethod.Post,
            path = "/auth/signup",
            body = SignupBody(email = email, password = "test-password-1234", displayName = "Fuzz"),
            requiresAuth = false,
        )
        runBlocking {
            tokenStore.save(
                TokenStore.Tokens(
                    accessToken = authResponse.accessToken,
                    refreshToken = authResponse.refreshToken,
                    user = AuthUser(
                        id = authResponse.user.id,
                        email = authResponse.user.email,
                        displayName = authResponse.user.displayName,
                    ),
                ),
            )
        }

        val monitor = FakeNetworkMonitor(initial = true)
        val syncEngine = SyncEngine(
            api = api,
            database = database,
            monitor = monitor,
            currentUserId = { tokenStore.current?.user?.id },
        )
        val mutator = Mutator(database = database)
        val drainer = Drainer(
            api = api,
            database = database,
            syncEngine = syncEngine,
            monitor = monitor,
        )
        mutator.attachDrainer(drainer)

        // Refresh suppress noise — keep the variable live so detekt
        // doesn't flag it as unused. RefreshBody import is required
        // to construct the auth client even though this test path
        // never sends a refresh.
        @Suppress("UNUSED_VARIABLE")
        val refresh = RefreshBody(refreshToken = authResponse.refreshToken)

        return IntegrationCtx(mutator, drainer, syncEngine, monitor)
    }

    private fun uniqueSuffix(): String = UUID.randomUUID().toString().take(8)

    // endregion
}
