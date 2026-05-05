package `in`.santosh_bharadwaj.sharedlist.app

import android.content.Context
import androidx.compose.runtime.compositionLocalOf
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthService
import `in`.santosh_bharadwaj.sharedlist.core.auth.DefaultAuthService
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import `in`.santosh_bharadwaj.sharedlist.core.storage.EncryptedSharedPreferencesStorage
import `in`.santosh_bharadwaj.sharedlist.core.storage.SecureStorage

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
public class AppContainer private constructor(
    public val secureStorage: SecureStorage,
    public val tokenStore: TokenStore,
    public val api: ApiClient,
    public val auth: AuthService,
) {
    /** Hydrate any persisted session at process start. Idempotent — running it
     *  twice is a no-op. */
    public suspend fun bootstrap() {
        tokenStore.loadFromStorage()
    }

    public companion object {
        /** Default backend URL — see class kdoc for rationale. */
        public const val DEFAULT_BASE_URL: String = "https://Santoshs-MacBook-Pro-48.local"

        /** Construct the production container. Called once from [SharedListApplication.onCreate]. */
        public fun create(context: Context, baseUrl: String = DEFAULT_BASE_URL): AppContainer {
            val storage = EncryptedSharedPreferencesStorage(context.applicationContext)
            val tokenStore = TokenStore(storage)
            val api = ApiClient(baseUrl = baseUrl, tokenStore = tokenStore)
            val auth = DefaultAuthService(api = api, tokenStore = tokenStore)
            return AppContainer(storage, tokenStore, api, auth)
        }

        /**
         * Test/preview seam — build a container with hand-supplied collaborators.
         * Used in `@Preview` composables (real EncryptedSharedPreferences requires
         * a Context that the preview runner doesn't always provide cleanly) and
         * in unit tests that want a real ApiClient wired to a mock Ktor engine.
         */
        public fun forTesting(
            secureStorage: SecureStorage,
            tokenStore: TokenStore,
            api: ApiClient,
            auth: AuthService,
        ): AppContainer = AppContainer(secureStorage, tokenStore, api, auth)
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
