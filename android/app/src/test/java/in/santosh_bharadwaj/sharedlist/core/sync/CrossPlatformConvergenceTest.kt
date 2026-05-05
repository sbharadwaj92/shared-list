package `in`.santosh_bharadwaj.sharedlist.core.sync

import androidx.test.core.app.ApplicationProvider
import `in`.santosh_bharadwaj.sharedlist.core.auth.DefaultAuthService
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Cross-platform sync convergence tests — Phase 9. Mirrors iOS
 * [CrossPlatformConvergenceTests].
 *
 * Each test plays ONE role (act or observe) in ONE scenario. The shell
 * harness `scripts/cross-platform-sync.sh` orchestrates the pairing: it
 * invokes this suite once with role=A on Android (or iOS), then captures
 * the resulting list/item ids from stdout, then invokes the role=B
 * counterpart on the opposite platform. Running each role as its own
 * process exercises real cold-start behavior on both ends — token
 * storage, database init, network monitor wiring — every scenario.
 *
 * Why this shape (vs. one-test-runs-both-roles-in-one-process):
 *   - PLAN.md L386 calls for "two devices' sync engines provably
 *     converge." Two devices means two processes — a single in-process
 *     A+B run can't catch a scheduler difference between platforms or
 *     a wire-encoding asymmetry that only manifests after one platform
 *     decodes what the other encoded.
 *   - Same-process A+B would let us cheat with shared in-memory state.
 *     The split-process shape forces every scenario to ride the
 *     backend's HTTP API as the only source of shared truth, which is
 *     exactly what production use looks like.
 *   - The downside is shell-level coordination: the harness has to
 *     carry list ids forward between processes via env vars + stdout
 *     parsing. We accept that — same trade we made for Android ↔ Bun
 *     handoff in the existing [DrainerIntegrationTest].
 *
 * Same-user, two-device pattern:
 *   - PLAN.md L386's four scenarios don't require *different* users —
 *     they require two devices. We sign up one user at harness start
 *     and `login` from a separate ApiClient/TokenStore pair per role
 *     to get an independent session per device. Multi-user / sharing-
 *     flow testing belongs to Phase 15 where the invite/accept routes
 *     land.
 *
 * Env vars (all required; tests skip silently if any is missing):
 *   - BACKEND_URL                  — backend root, e.g. http://10.0.2.2:3000
 *   - CROSS_PLATFORM_USER_EMAIL    — user signed up by the harness
 *   - CROSS_PLATFORM_USER_PASSWORD — password for that user
 *   - CROSS_PLATFORM_ROLE          — "A" or "B"
 *   - CROSS_PLATFORM_LIST_ID       — present on observer steps to point at
 *                                    the list the actor created in a prior
 *                                    step. Empty on initial creation steps.
 *   - CROSS_PLATFORM_ITEM_ID       — analogous for item-level scenarios.
 *
 * stdout protocol:
 *   Each test prints "CROSS_PLATFORM_RESULT[<key>]=<value>" lines that
 *   the harness greps. Keys: LIST_ID, ITEM_ID, OBSERVED_NAME,
 *   OBSERVED_PRESENT, OBSERVED_DELETED, FINAL_NAME, RENAMED_TO. The format
 *   is parser-friendly and noise-tolerant.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
public class CrossPlatformConvergenceTest {

    private lateinit var database: SyncDatabase
    private val backendUrl: String? = System.getenv("BACKEND_URL")
    private val role: String? = System.getenv("CROSS_PLATFORM_ROLE")

    @Before
    public fun setUp() {
        // assumeNotNull marks the run as "skipped" rather than passed-or-
        // failed when env vars are missing. The harness invocation always
        // sets BACKEND_URL + CROSS_PLATFORM_ROLE; a plain
        // `./gradlew testDebugUnitTest` run never hits the test bodies.
        assumeNotNull(
            "BACKEND_URL not set — set it for cross-platform convergence tests",
            backendUrl,
        )
        assumeNotNull(
            "CROSS_PLATFORM_ROLE not set — should be 'A' or 'B'",
            role,
        )
        database = SyncDatabase.inMemory(ApplicationProvider.getApplicationContext())
    }

    @After
    public fun tearDown() {
        if (::database.isInitialized) database.close()
    }

    // region Setup helper (used by harness to seed scenarios B, C, D with
    // their own fresh list so they don't interfere with each other's state
    // on the backend)

    @Test
    public fun setup_seedFreshList(): Unit = runTest {
        // Special harness invocation: role can be "A" or "B" — whichever
        // platform the harness picked to do the seeding for the next
        // scenario. The seed step is not a sync verification; it only
        // ensures the next scenario starts from a known state.
        val ctx = makeEnvironment()
        val name = "seed-${ctx.runId}"
        val id = ctx.mutator.createList(name = name)
        ctx.drainer.tick()
        val queue = database.mutationQueueDao().all()
        assertTrue("expected queue empty after seed drain, got ${queue.size}", queue.isEmpty())
        printResult("LIST_ID", id)
        printResult("LIST_NAME", name)
    }

    // endregion

    // region Scenario (a): A creates → B sees after ?since=

    @Test
    public fun scenarioA_creatorCreatesList(): Unit = runTest {
        assumeRole("A")
        val ctx = makeEnvironment()
        val name = "scenario-a-${ctx.runId}"
        val id = ctx.mutator.createList(name = name)
        ctx.drainer.tick()
        val queue = database.mutationQueueDao().all()
        assertTrue("expected queue empty after drain, got ${queue.size}", queue.isEmpty())
        printResult("LIST_ID", id)
        printResult("LIST_NAME", name)
    }

    @Test
    public fun scenarioA_observerSeesList(): Unit = runTest {
        assumeRole("B")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")

        ctx.syncEngine.reconcile()

        val observed = database.listDao().findById(listId)
        assertNotNull("expected list $listId after reconcile", observed)
        if (observed != null) {
            printResult("OBSERVED_NAME", observed.name)
            printResult("OBSERVED_PRESENT", "true")
        } else {
            printResult("OBSERVED_PRESENT", "false")
        }
    }

    // endregion

    // region Scenario (b): A offline-mutates → reconnects → B sees result

    @Test
    public fun scenarioB_creatorMutatesOfflineThenReconnects(): Unit = runTest {
        assumeRole("A")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")

        // Make the existing list visible locally so the rename has a
        // target. Without this initial reconcile the Mutator would no-op
        // (findActiveList returns nothing for an unknown id).
        ctx.syncEngine.reconcile()

        // Go offline. The Mutator enqueues the rename but the drainer
        // can't send anything yet.
        ctx.monitor.setOnline(false)
        val newName = "scenario-b-renamed-${ctx.runId}"
        ctx.mutator.renameList(id = listId, newName = newName)

        // Drainer kick is a no-op while offline — confirm the queue
        // still holds the rename.
        ctx.drainer.kick()
        val queueOffline = database.mutationQueueDao().all()
        assertEquals(
            "expected 1 queued mutation while offline",
            1,
            queueOffline.size,
        )

        // Reconnect; explicit tick so we don't race the kick.
        ctx.monitor.setOnline(true)
        ctx.drainer.tick()

        val queueDrained = database.mutationQueueDao().all()
        assertTrue(
            "expected queue empty after reconnect-drain, got ${queueDrained.size}",
            queueDrained.isEmpty(),
        )

        printResult("LIST_ID", listId)
        printResult("RENAMED_TO", newName)
    }

    @Test
    public fun scenarioB_observerSeesRename(): Unit = runTest {
        assumeRole("B")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")
        val expectedName = requireEnv("CROSS_PLATFORM_EXPECTED_NAME")

        ctx.syncEngine.reconcile()

        val observed = database.listDao().findById(listId)
        assertEquals(
            "expected list $listId to read as '$expectedName', got '${observed?.name}'",
            expectedName,
            observed?.name,
        )
        printResult("OBSERVED_NAME", observed?.name.orEmpty())
    }

    // endregion

    // region Scenario (c): concurrent edits resolve LWW consistently

    @Test
    public fun scenarioC_creatorEditsThenDrains(): Unit = runTest {
        assumeRole("A")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")

        ctx.syncEngine.reconcile()

        // The actor renames the list and immediately drains. The harness
        // invokes B with the same starting state (a separate process,
        // separate ApiClient, separate local store) which races against
        // this rename's serverside `updated_at`. Because both A and B
        // captured the same prior `updatedAt` (their respective initial
        // reconcile fetched the same row), they both send If-Match
        // against the SAME cursor — one will land 200, the other 409.
        // Whichever wins, both eventually-converge on the same name
        // after their post-409 reconcile + retry-once cycle.
        val nameFromA = "scenario-c-from-A-${ctx.runId}"
        ctx.mutator.renameList(id = listId, newName = nameFromA)
        ctx.drainer.tick()

        ctx.syncEngine.reconcile()
        val observed = database.listDao().findById(listId)
        printResult("LIST_ID", listId)
        printResult("FINAL_NAME", observed?.name.orEmpty())
    }

    @Test
    public fun scenarioC_observerEditsThenDrains(): Unit = runTest {
        assumeRole("B")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")

        ctx.syncEngine.reconcile()

        val nameFromB = "scenario-c-from-B-${ctx.runId}"
        ctx.mutator.renameList(id = listId, newName = nameFromB)
        ctx.drainer.tick()

        ctx.syncEngine.reconcile()
        val observed = database.listDao().findById(listId)
        printResult("LIST_ID", listId)
        printResult("FINAL_NAME", observed?.name.orEmpty())
    }

    // endregion

    // region Scenario (d): tombstones flow during 90-day window

    @Test
    public fun scenarioD_creatorAddsThenDeletesItem(): Unit = runTest {
        assumeRole("A")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")

        ctx.syncEngine.reconcile()

        // Two-step act: create an item (so B has something to observe
        // disappear), then delete it. Drain after each so the server
        // serializes the operations into the items feed in a known
        // order. The deletion's tombstone is what scenario (d) verifies
        // — that B's `?since=` pull surfaces the tombstoned item and
        // the read-side reconciler removes B's local row.
        val itemId = ctx.mutator.createItem(listId = listId, text = "scenario-d item")
        ctx.drainer.tick()

        ctx.mutator.deleteItem(id = itemId)
        ctx.drainer.tick()

        val queueAfter = database.mutationQueueDao().all()
        assertTrue("expected queue empty after both drains", queueAfter.isEmpty())

        printResult("ITEM_ID", itemId)
    }

    @Test
    public fun scenarioD_observerSeesTombstone(): Unit = runTest {
        assumeRole("B")
        val ctx = makeEnvironment()
        val listId = requireEnv("CROSS_PLATFORM_LIST_ID")
        val itemId = requireEnv("CROSS_PLATFORM_ITEM_ID")

        ctx.syncEngine.reconcile()

        // The deletion happened on A's side — the ItemDao should not
        // surface an active row after our reconcile. The read-side
        // reconciler's deletion path runs because the wire DTO's
        // `deletedAt` is non-nil (tombstone), and our local store gets
        // a matching `deletedAt` written.
        val item = database.itemDao().findById(itemId)
        // Either the row is gone (Room CASCADE on parent list, but
        // we're not deleting the list) or it's present with deletedAt
        // set. The reconciler writes deletedAt rather than DELETE-ing
        // the row, so we expect "present, tombstoned."
        assertNotNull("expected tombstoned local row for $itemId, got null", item)
        if (item != null) {
            assertNotNull("expected deletedAt on tombstoned row $itemId", item.deletedAt)
        }

        // Also assert the parent list is still around — only the item
        // was deleted, not the list.
        val list = database.listDao().findById(listId)
        assertNotNull("expected parent list to still exist after item delete", list)
        assertNull("expected parent list to be active (not tombstoned)", list?.deletedAt)

        printResult(
            "OBSERVED_DELETED",
            if (item?.deletedAt != null) "true" else "false",
        )
    }

    // endregion

    // region Test fixtures

    private data class ConvergenceCtx(
        val mutator: Mutator,
        val drainer: Drainer,
        val syncEngine: SyncEngine,
        val monitor: FakeNetworkMonitor,
        val runId: String,
    )

    /**
     * Sign in to the existing user the harness signed up at start. Two
     * devices = two processes = two ApiClient/TokenStore pairs sharing
     * the same backend user. Same-user pattern explained in the file
     * header.
     */
    private suspend fun makeEnvironment(): ConvergenceCtx {
        val baseUrl = requireNotNull(backendUrl) { "BACKEND_URL guard failed" }
        val email = requireEnv("CROSS_PLATFORM_USER_EMAIL")
        val password = requireEnv("CROSS_PLATFORM_USER_PASSWORD")

        val tokenStore = TokenStore(InMemorySecureStorage())
        val api = ApiClient(baseUrl = baseUrl, tokenStore = tokenStore)
        val auth = DefaultAuthService(api = api, tokenStore = tokenStore)

        // Log in. The generous login limit (PLAN.md L81: 30/min/IP) keeps
        // the 8-process Phase 9 run comfortably under the bucket. The
        // signup itself happens once at harness-start, not here. The
        // return value is discarded — the TokenStore gets populated as
        // a side-effect of `login` via the AuthService implementation.
        auth.login(email = email, password = password)

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
        // Deliberately NOT calling `mutator.attachDrainer(drainer)` —
        // mirrors [DrainerIntegrationTest] and [SyncFuzzTest]. Mutator's
        // auto-kick launches into Drainer's own Dispatchers.IO scope,
        // which races with our explicit `tick()` from `runTest`'s
        // TestScope; production wires both ends, the unit-scoped
        // [DrainerTest] suite exercises that path. Cross-platform tests
        // call `tick()` explicitly so they observe a deterministic
        // post-drain state.
        runBlocking {
            // Defer to the same-thread runBlocking only to keep the
            // suspend-fun signature symmetric with the iOS counterpart.
            // The actual login above has already populated tokenStore.
        }

        return ConvergenceCtx(
            mutator = mutator,
            drainer = drainer,
            syncEngine = syncEngine,
            monitor = monitor,
            runId = "$role-${android.os.Process.myPid()}",
        )
    }

    private fun assumeRole(expected: String) {
        assumeTrue(
            "this test runs only when CROSS_PLATFORM_ROLE=$expected (got $role)",
            role == expected,
        )
    }

    private fun requireEnv(name: String): String {
        val value = System.getenv(name)
        require(!value.isNullOrEmpty()) {
            "missing required env var $name"
        }
        return value
    }

    /**
     * Print a structured RESULT line the shell harness greps for. Keep
     * the format simple: harness uses
     * `grep -oE "CROSS_PLATFORM_RESULT\[KEY\]=.*"` then strips the prefix.
     * Goes through the JVM stdout (println), which Gradle surfaces by
     * default for unit tests.
     */
    private fun printResult(key: String, value: String) {
        println("CROSS_PLATFORM_RESULT[$key]=$value")
    }

    // endregion
}
