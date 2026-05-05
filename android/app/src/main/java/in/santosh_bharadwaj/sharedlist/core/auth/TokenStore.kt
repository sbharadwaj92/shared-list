package `in`.santosh_bharadwaj.sharedlist.core.auth

import `in`.santosh_bharadwaj.sharedlist.core.storage.SecureStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Single owner of the access + refresh token pair, mirroring iOS `TokenStore`.
 *
 * Two concerns rolled into one type, intentionally:
 *   1. Persistence — read/write the pair to SecureStorage, survive process death.
 *   2. Observation — expose the current pair as `StateFlow<Tokens?>` so screens
 *      can react to login/logout without an extra event bus. Logging out =
 *      "set tokens to null"; the RootScreen's switch on `tokens == null` does
 *      the rest.
 *
 * Why `StateFlow` rather than `LiveData` or a callback?
 *   - It's the modern Kotlin-coroutines-native primitive (vs LiveData which
 *     lives in androidx.lifecycle and is observed via Java patterns).
 *   - It composes cleanly with `collectAsStateWithLifecycle()` in Compose —
 *     one line, automatic resubscription on lifecycle, no leaks.
 *   - `MutableStateFlow.update { }` (used below) gives us atomic
 *     compare-and-set semantics on the contained value, which matters when
 *     two coroutines could race to mutate the token pair (e.g. concurrent
 *     refresh attempts in the brief window before single-flight serializes
 *     them).
 *
 * Threading: `StateFlow` is itself thread-safe (it uses CAS internally). The
 * SecureStorage I/O is wrapped in a Mutex so two simultaneous writes can't
 * interleave key-by-key — partial writes are the worst kind of corruption
 * because they survive process death and look "logged in" until something
 * tries to use the broken pair.
 */
public class TokenStore(
    private val storage: SecureStorage,
) {
    public data class Tokens(
        public val accessToken: String,
        public val refreshToken: String,
        public val user: AuthUser,
    )

    private val _state = MutableStateFlow<Tokens?>(null)

    /** Observable token state. `null` = signed out; non-null = signed in. */
    public val state: StateFlow<Tokens?> = _state.asStateFlow()

    /** Synchronous read for places that just need the current value (e.g. ApiClient header injection). */
    public val current: Tokens? get() = _state.value

    /** Serializes write paths through SecureStorage — see class-level note. */
    private val ioMutex = Mutex()

    private object Key {
        const val ACCESS_TOKEN = "auth.accessToken"
        const val REFRESH_TOKEN = "auth.refreshToken"
        const val USER_ID = "auth.user.id"
        const val USER_EMAIL = "auth.user.email"
        const val USER_DISPLAY_NAME = "auth.user.displayName"
    }

    /**
     * Hydrate the in-memory state from secure storage. Called once at process
     * start from `AppContainer.bootstrap()`. A failed read (corrupted entry,
     * partial write from a crashed previous run, KeyStore reset) is treated
     * as "no tokens" — safe default; user can re-login.
     */
    public suspend fun loadFromStorage() {
        ioMutex.withLock {
            try {
                val access = storage.get(Key.ACCESS_TOKEN)
                val refresh = storage.get(Key.REFRESH_TOKEN)
                val userId = storage.get(Key.USER_ID)
                val email = storage.get(Key.USER_EMAIL)
                val displayName = storage.get(Key.USER_DISPLAY_NAME)

                if (access != null && refresh != null && userId != null && email != null && displayName != null) {
                    _state.value = Tokens(
                        accessToken = access,
                        refreshToken = refresh,
                        user = AuthUser(id = userId, email = email, displayName = displayName),
                    )
                } else {
                    _state.value = null
                }
            } catch (t: Throwable) {
                // EncryptedSharedPreferences can throw if the master key is
                // corrupted. Treat as logged-out.
                _state.value = null
            }
        }
    }

    /** Persist a fresh token pair after signup / login. In-memory state is
     *  updated FIRST so any UI binding sees the new identity immediately. */
    public suspend fun save(tokens: Tokens) {
        _state.value = tokens
        ioMutex.withLock {
            storage.set(Key.ACCESS_TOKEN, tokens.accessToken)
            storage.set(Key.REFRESH_TOKEN, tokens.refreshToken)
            storage.set(Key.USER_ID, tokens.user.id)
            storage.set(Key.USER_EMAIL, tokens.user.email)
            storage.set(Key.USER_DISPLAY_NAME, tokens.user.displayName)
        }
    }

    /**
     * After a refresh response, only access + refresh change; the user
     * identity is identical. Avoids rewriting unchanged keys. Throws if
     * called while logged out — that's a programmer error, not a runtime
     * condition.
     */
    public suspend fun updateTokens(accessToken: String, refreshToken: String) {
        val user = current?.user ?: throw TokenStoreException.NotLoggedIn
        val updated = Tokens(accessToken = accessToken, refreshToken = refreshToken, user = user)
        _state.value = updated
        ioMutex.withLock {
            storage.set(Key.ACCESS_TOKEN, accessToken)
            storage.set(Key.REFRESH_TOKEN, refreshToken)
        }
    }

    /**
     * Apply a rotated pair to the in-memory state immediately, without
     * waiting for the storage write. Used by ApiClient on the refresh path:
     * the retried request needs the new access token in memory ASAP, while
     * the storage write can happen in the background. Failure to persist is
     * non-fatal — worst case a relaunch reads the old tokens and triggers
     * another refresh, which is fine (idempotent).
     */
    public fun applyRefresh(accessToken: String, refreshToken: String) {
        _state.update { tokens ->
            val user = tokens?.user ?: throw TokenStoreException.NotLoggedIn
            Tokens(accessToken = accessToken, refreshToken = refreshToken, user = user)
        }
    }

    /** Persist the rotated pair after [applyRefresh]. Failure-tolerant. */
    public suspend fun persistRotated(accessToken: String, refreshToken: String) {
        ioMutex.withLock {
            try {
                storage.set(Key.ACCESS_TOKEN, accessToken)
                storage.set(Key.REFRESH_TOKEN, refreshToken)
            } catch (t: Throwable) {
                // Intentionally swallowed — see kdoc on applyRefresh.
            }
        }
    }

    /**
     * Clear all tokens. Best-effort delete of every key — logout must succeed
     * from the user's perspective even if a storage row was somehow missing.
     */
    public suspend fun clear() {
        _state.value = null
        ioMutex.withLock {
            runCatching { storage.delete(Key.ACCESS_TOKEN) }
            runCatching { storage.delete(Key.REFRESH_TOKEN) }
            runCatching { storage.delete(Key.USER_ID) }
            runCatching { storage.delete(Key.USER_EMAIL) }
            runCatching { storage.delete(Key.USER_DISPLAY_NAME) }
        }
    }
}

public sealed class TokenStoreException(message: String) : Exception(message) {
    public object NotLoggedIn : TokenStoreException("token rotation requested while logged out") {
        // readResolve is called reflectively by Java serialization to ensure
        // the singleton stays a singleton across deserialization. Detekt
        // flags this as unused because it's never called from Kotlin code.
        @Suppress("unused")
        private fun readResolve(): Any = NotLoggedIn
    }
}
