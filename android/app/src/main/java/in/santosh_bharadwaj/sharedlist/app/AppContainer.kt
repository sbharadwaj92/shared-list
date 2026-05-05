package `in`.santosh_bharadwaj.sharedlist.app

import android.content.Context
import androidx.compose.runtime.compositionLocalOf
import `in`.santosh_bharadwaj.sharedlist.BuildConfig
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthService
import `in`.santosh_bharadwaj.sharedlist.core.auth.DefaultAuthService
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.EncryptedSharedPreferencesStorage
import `in`.santosh_bharadwaj.sharedlist.core.storage.SecureStorage
import `in`.santosh_bharadwaj.sharedlist.core.sync.Drainer
import `in`.santosh_bharadwaj.sharedlist.core.sync.Mutator
import `in`.santosh_bharadwaj.sharedlist.core.sync.NetworkMonitor
import `in`.santosh_bharadwaj.sharedlist.core.sync.NetworkMonitoring
import `in`.santosh_bharadwaj.sharedlist.core.sync.SyncDatabase
import `in`.santosh_bharadwaj.sharedlist.core.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Manual DI container. PLAN.md mandates this approach (vs Hilt / Koin / kotlin-inject):
 *
 *   1. Constructors take dependencies they need, no global lookup, no magic.
 *      Anyone reading a type's signature sees what it touches.
 *   2. Lifecycle is explicit — the container is constructed once at process
 *      start (in [SharedListApplication.onCreate]) and every singleton lives
 *      for the process lifetime.
 *   3. No reflection, no runtime registration — Kotlin's type system enforces
 *      that every dependency is wired before the program runs.
 *
 * Threaded through the Compose tree via [LocalAppContainer] (a
 * [androidx.compose.runtime.CompositionLocal]). Mirror of iOS
 * `Environment(\.appContainer)`.
 *
 * Backend hostname is hardcoded — local backend on the user's Mac at its mDNS
 * hostname (PLAN.md L130). PLAN.md is clear that off-LAN access is out of
 * scope, so this single URL is sufficient.
 *
 * **Android Emulator note**: The Android Emulator routes traffic through a
 * NAT and may not resolve `.local` mDNS names (no native Bonjour). If
 * connectivity fails on the emulator only, the workaround documented in
 * `android/README.md` is to fall back to the host loopback alias `10.0.2.2`.
 * On the physical S24 Ultra connected to the same Wi-Fi, the `.local` name
 * resolves natively and matches the Caddy mkcert SAN, so we keep it as the
 * default.
 */
@Suppress("LongParameterList")
public class AppContainer private constructor(
    public val secureStorage: SecureStorage,
    public val tokenStore: TokenStore,
    public val api: ApiClient,
    public val auth: AuthService,
    public val syncDatabase: SyncDatabase,
    public val networkMonitor: NetworkMonitoring,
    public val syncEngine: SyncEngine,
    public val mutator: Mutator,
    public val drainer: Drainer,
    /** Long-lived background scope for `bootstrap()` work that should
     *  outlive the launching composable. */
    private val containerScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    /**
     * Hydrate any persisted session at process start, kick off network
     * monitoring, and trigger an initial reconcile if a session is
     * already loaded. Idempotent — running it twice is a no-op for the
     * token store and only re-emits the current online state for the
     * monitor.
     */
    public suspend fun bootstrap() {
        tokenStore.loadFromStorage()
        // Begin observing connectivity changes. Cheap to call multiple
        // times — the underlying NetworkCallback registration is
        // idempotent inside [NetworkMonitor].
        (networkMonitor as? NetworkMonitor)?.start()
        // Kick the drainer when we transition to online — covers the
        // "user was offline at app launch, came online a moment later"
        // case without polling.
        containerScope.launch {
            networkMonitor.isOnline.collect { online ->
                if (online) drainer.kick()
            }
        }
        // If a session is loaded, trigger an initial reconcile so the
        // local cache is fresh by the time the UI renders. Failures
        // are swallowed to a debug log — the next foreground or kick
        // gets us another chance.
        if (tokenStore.current != null) {
            containerScope.launch {
                runCatching { syncEngine.reconcile() }
            }
        }
    }

    public companion object {
        /**
         * Default backend URL — sourced from `BuildConfig.BACKEND_BASE_URL`,
         * which the Gradle build wires per-build-type:
         *   - Debug builds: `https://10.0.2.2` so the Android Emulator (whose
         *     NAT can't resolve `.local` mDNS) can reach Caddy on the host
         *     via the well-known emulator alias for 127.0.0.1.
         *   - Release builds: `https://Santoshs-MacBook-Pro-48.local` (the
         *     mDNS name physical devices on the same Wi-Fi resolve natively).
         * Both URLs are covered by the same mkcert SAN (regenerated in
         * Phase 6) so the same root CA trusts either one.
         */
        public val DEFAULT_BASE_URL: String = BuildConfig.BACKEND_BASE_URL

        /** Construct the production container. Called once from [SharedListApplication.onCreate]. */
        public fun create(context: Context, baseUrl: String = DEFAULT_BASE_URL): AppContainer {
            val storage = EncryptedSharedPreferencesStorage(context.applicationContext)
            val tokenStore = TokenStore(storage)
            val api = ApiClient(baseUrl = baseUrl, tokenStore = tokenStore)
            val auth = DefaultAuthService(api = api, tokenStore = tokenStore)
            val database = SyncDatabase.create(context.applicationContext)
            val monitor = NetworkMonitor(context.applicationContext)
            // SyncEngine reads the current user id lazily so it stays
            // consistent with the token store's session lifecycle.
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
            // Two-phase wiring — the Mutator's `kick()` after each save
            // depends on the Drainer being present, but both are
            // singletons constructed in this companion. See iOS
            // `Mutator.attachDrainer` for matching rationale.
            mutator.attachDrainer(drainer)
            return AppContainer(
                secureStorage = storage,
                tokenStore = tokenStore,
                api = api,
                auth = auth,
                syncDatabase = database,
                networkMonitor = monitor,
                syncEngine = syncEngine,
                mutator = mutator,
                drainer = drainer,
            )
        }

        /**
         * Test/preview seam — build a container with hand-supplied collaborators.
         * Used in `@Preview` composables (real EncryptedSharedPreferences requires
         * a Context that the preview runner doesn't always provide cleanly) and
         * in unit tests that want a real ApiClient wired to a mock Ktor engine.
         */
        @Suppress("LongParameterList")
        public fun forTesting(
            secureStorage: SecureStorage,
            tokenStore: TokenStore,
            api: ApiClient,
            auth: AuthService,
            syncDatabase: SyncDatabase,
            networkMonitor: NetworkMonitoring,
            syncEngine: SyncEngine,
            mutator: Mutator,
            drainer: Drainer,
        ): AppContainer = AppContainer(
            secureStorage = secureStorage,
            tokenStore = tokenStore,
            api = api,
            auth = auth,
            syncDatabase = syncDatabase,
            networkMonitor = networkMonitor,
            syncEngine = syncEngine,
            mutator = mutator,
            drainer = drainer,
        )
    }
}

/**
 * Compose [androidx.compose.runtime.CompositionLocal] for the app container.
 * Exposed as nullable so the default value can be `null` — analogous to iOS
 * keying on `Optional<AppContainer>` in EnvironmentValues. Composables that
 * need the container call `LocalAppContainer.current` and reach for `?` or
 * the unwrap helper below.
 */
public val LocalAppContainer: androidx.compose.runtime.ProvidableCompositionLocal<AppContainer?> =
    compositionLocalOf { null }
