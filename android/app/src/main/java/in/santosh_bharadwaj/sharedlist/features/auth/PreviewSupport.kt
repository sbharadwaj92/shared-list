package `in`.santosh_bharadwaj.sharedlist.features.auth

import android.content.Context
import `in`.santosh_bharadwaj.sharedlist.app.AppContainer
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthService
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthUser
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import `in`.santosh_bharadwaj.sharedlist.core.sync.Drainer
import `in`.santosh_bharadwaj.sharedlist.core.sync.FakeNetworkMonitor
import `in`.santosh_bharadwaj.sharedlist.core.sync.Mutator
import `in`.santosh_bharadwaj.sharedlist.core.sync.SyncDatabase
import `in`.santosh_bharadwaj.sharedlist.core.sync.SyncEngine
import kotlinx.coroutines.runBlocking

/**
 * Helpers used only by `@Preview` composables. Mirrors iOS PreviewSupport.
 *
 * We construct an AppContainer with [InMemorySecureStorage] (real
 * EncryptedSharedPreferences requires a Context that the Compose preview
 * runner doesn't always supply cleanly) and a stub [AuthService] that doesn't
 * hit the network. Previews that just need to render UI in different states
 * (logged in / logged out) use these without standing up the live backend.
 *
 * In production code a previews-only file like this would be `src/debug/`-only
 * to avoid shipping the stubs in release. For now the cost is a few unused
 * KB; we'll move this if the binary size ever matters.
 */
internal object PreviewSupport {

    fun loggedOutContainer(context: Context): AppContainer {
        val storage = InMemorySecureStorage()
        val tokenStore = TokenStore(storage)
        // ApiClient needs SOME engine, but StubAuthService never invokes it
        // in preview rendering. The default OkHttp engine is fine; it doesn't
        // open a real socket until a request actually fires.
        val api = ApiClient(baseUrl = AppContainer.DEFAULT_BASE_URL, tokenStore = tokenStore)
        val auth = StubAuthService(tokenStore = tokenStore, behavior = StubAuthService.Behavior.AlwaysLoggedOut)
        return assemble(context, storage, tokenStore, api, auth)
    }

    fun loggedInContainer(context: Context): AppContainer {
        val storage = InMemorySecureStorage()
        val tokenStore = TokenStore(storage)
        val api = ApiClient(baseUrl = AppContainer.DEFAULT_BASE_URL, tokenStore = tokenStore)
        val auth = StubAuthService(tokenStore = tokenStore, behavior = StubAuthService.Behavior.AlwaysLoggedIn)
        // Seed a session so the preview comes up with state. runBlocking is
        // used here because preview execution is synchronous and short-lived;
        // in production code we'd never block a coroutine context like this.
        runBlocking {
            tokenStore.save(
                TokenStore.Tokens(
                    accessToken = "preview-access",
                    refreshToken = "preview-refresh",
                    user = AuthUser(id = "preview-user", email = "alice@example.com", displayName = "Alice"),
                ),
            )
        }
        return assemble(context, storage, tokenStore, api, auth)
    }

    /**
     * Build the in-memory sync stack for previews. We use a real
     * [SyncDatabase] in memory + a [FakeNetworkMonitor] so the sync
     * engine and drainer can construct without exploding, but no
     * actual network calls fire because the StubAuthService never
     * routes through them in preview rendering.
     */
    private fun assemble(
        context: Context,
        storage: InMemorySecureStorage,
        tokenStore: TokenStore,
        api: ApiClient,
        auth: AuthService,
    ): AppContainer {
        val database = SyncDatabase.inMemory(context)
        val monitor = FakeNetworkMonitor(initial = false)
        val syncEngine = SyncEngine(
            api = api,
            database = database,
            monitor = monitor,
            currentUserId = { tokenStore.current?.user?.id },
        )
        val mutator = Mutator(database = database)
        val drainer = Drainer(api = api, database = database, syncEngine = syncEngine, monitor = monitor)
        mutator.attachDrainer(drainer)
        return AppContainer.forTesting(
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
}

internal class StubAuthService(
    private val tokenStore: TokenStore,
    private val behavior: Behavior,
) : AuthService {
    enum class Behavior { AlwaysLoggedOut, AlwaysLoggedIn }

    override suspend fun signup(email: String, password: String, displayName: String): AuthUser {
        val user = AuthUser(id = "stub-id", email = email, displayName = displayName)
        if (behavior == Behavior.AlwaysLoggedIn) {
            tokenStore.save(
                TokenStore.Tokens(
                    accessToken = "stub-access",
                    refreshToken = "stub-refresh",
                    user = user,
                ),
            )
        }
        return user
    }

    override suspend fun login(email: String, password: String): AuthUser {
        val user = AuthUser(id = "stub-id", email = email, displayName = "Stub User")
        if (behavior == Behavior.AlwaysLoggedIn) {
            tokenStore.save(
                TokenStore.Tokens(
                    accessToken = "stub-access",
                    refreshToken = "stub-refresh",
                    user = user,
                ),
            )
        }
        return user
    }

    override suspend fun logout() {
        tokenStore.clear()
    }

    override fun currentUser(): AuthUser? = tokenStore.current?.user
}
