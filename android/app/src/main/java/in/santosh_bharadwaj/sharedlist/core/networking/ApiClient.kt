package `in`.santosh_bharadwaj.sharedlist.core.networking

import `in`.santosh_bharadwaj.sharedlist.core.auth.ApiErrorEnvelope
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthResponse
import `in`.santosh_bharadwaj.sharedlist.core.auth.RefreshBody
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.headers
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.takeFrom
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Typed errors surfaced to callers. Mirrors iOS [APIError].
 */
public sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    public object NotAuthenticated : ApiError("not authenticated") {
        @Suppress("unused")
        private fun readResolve(): Any = NotAuthenticated
    }
    public data class Server(
        val status: Int,
        val code: String,
        val errorMessage: String,
        val requestId: String,
    ) : ApiError("[$status] $errorMessage")
    public data class Decoding(val detail: String) : ApiError("decoding failed: $detail")
    public data class Transport(val detail: String) : ApiError("transport: $detail")
    public object RefreshFailed : ApiError("refresh failed") {
        @Suppress("unused")
        private fun readResolve(): Any = RefreshFailed
    }
}

/**
 * Single point of network access for the Android app. Mirrors iOS APIClient.
 *
 * Responsibilities, in order of importance:
 *   1. Send Serializable bodies, decode Serializable responses, surface typed
 *      errors via [ApiError].
 *   2. Inject `Authorization: Bearer <accessToken>` from [TokenStore].
 *   3. On a 401, refresh the access token AT MOST ONCE PER REQUEST and retry,
 *      with multiple concurrent in-flight requests sharing one refresh.
 *
 * Concept #3 is the **single-flight refresh** pattern — the most important
 * piece of this file. Why it matters:
 *
 *   - Suppose ten ViewModels each fire a request at app foreground.
 *   - The access token has expired since last use.
 *   - All ten get a 401.
 *   - Without single-flight, all ten would call /auth/refresh in parallel.
 *     The backend's refresh endpoint rotates the refresh token (new one
 *     issued, old one marked used). The first request swaps the token, but
 *     the other nine race using the same OLD refresh token. The backend's
 *     reuse detection then revokes ALL of the user's refresh tokens — instant
 *     surprise logout.
 *   - With single-flight: the first 401 starts a single refresh `Deferred`;
 *     every subsequent 401 within the in-flight window awaits the same
 *     `Deferred` and retries with the new access token.
 *
 * Implementation: a `Mutex` plus a single `CompletableDeferred<Boolean>`
 * stored as `inFlight`. The Mutex protects the `inFlight` reference itself,
 * not the work — the actual `/auth/refresh` HTTP call happens OUTSIDE the
 * Mutex so subsequent 401s can read the same `inFlight` and `await()` it.
 *
 * Kotlin notes (vs iOS):
 *   - iOS uses an `actor` to serialize access. Kotlin actors-as-mailboxes are
 *     marked obsolete; the idiomatic primitive is `Mutex.withLock { }`. The
 *     guarantee is the same (one coroutine holds the lock at a time).
 *   - `CompletableDeferred<Boolean>` is the Kotlin analog of Swift's
 *     `Task<Bool, Error>` — both are "the single result of the work" handles
 *     that multiple awaiters can subscribe to.
 *
 * What we deliberately do NOT do:
 *   - Proactively check token expiry before each request. We could decode
 *     the JWT's `exp` claim, but reactive (refresh on 401) handles clock skew,
 *     server clock drift, sleep/wake jitter for free. The cost is one extra
 *     round trip per token rotation — fine.
 */
public class ApiClient(
    private val baseUrl: String,
    private val tokenStore: TokenStore,
    engine: HttpClientEngine = OkHttp.create(),
    /** Long-lived scope for the persisted-rotation work after a refresh. */
    private val ioScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {

    @PublishedApi
    internal val json: Json = Json {
        ignoreUnknownKeys = true
        // The backend ships ISO-8601 timestamps for fields we'll meet in
        // Phase 7 (`updated_at` etc). Configuring lenient handling now means
        // adding sync DTOs later doesn't require touching the global parser.
        explicitNulls = false
    }

    private val client: HttpClient = HttpClient(engine) {
        install(ContentNegotiation) {
            json(json)
        }
        // No default Authorization header — we inject per-request via
        // `withAuth(...)`, because some calls (signup, login, refresh) MUST
        // NOT carry one. A blanket header would short-circuit refresh logic.
        expectSuccess = false
    }

    /** Mutex that guards [inFlight]; held only while reading/writing the reference. */
    private val refreshLock = Mutex()

    /**
     * The current in-flight refresh, or `null` if none. Multiple coroutines
     * that hit a 401 in the same instant collapse onto this single Deferred.
     */
    private var inFlight: CompletableDeferred<Boolean>? = null

    /**
     * Send a request and decode the response.
     *
     * Generic `T` is the response type (any `@Serializable` data class). The
     * KSerializer is supplied implicitly via reified type parameters — Kotlin
     * doesn't have Swift's free Codable conformance, so callers go through
     * the inline reified wrapper [send] / [sendNoContent] below.
     */
    public suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        body: Any? = null,
        requiresAuth: Boolean = true,
    ): T {
        val response = perform(method, path, body, requiresAuth)
        return try {
            response.body()
        } catch (t: SerializationException) {
            throw ApiError.Decoding(t.message ?: "serialization failed")
        }
    }

    /**
     * 204 / no-content variant — body is read and discarded. Used for the
     * logout endpoint and any future endpoints that don't return a payload.
     */
    public suspend fun sendNoContent(
        method: HttpMethod,
        path: String,
        body: Any? = null,
        requiresAuth: Boolean = true,
    ) {
        perform(method, path, body, requiresAuth)
    }

    /**
     * `@PublishedApi internal` because the inline `send<T>()` above must call
     * it (inline functions can only call same-or-higher-visibility members).
     * Performs a single request with the 401 → refresh → retry policy.
     */
    @PublishedApi
    internal suspend fun perform(
        method: HttpMethod,
        path: String,
        body: Any?,
        requiresAuth: Boolean,
    ): HttpResponse {
        val initial = sendOnce(method, path, body, requiresAuth)
        if (initial.status == HttpStatusCode.Unauthorized && requiresAuth) {
            val refreshed = runRefresh()
            if (!refreshed) throw ApiError.RefreshFailed
            // Retry once with the rotated access token.
            val retried = sendOnce(method, path, body, requiresAuth)
            return validate(retried)
        }
        return validate(initial)
    }

    private suspend fun sendOnce(
        method: HttpMethod,
        path: String,
        body: Any?,
        requiresAuth: Boolean,
    ): HttpResponse {
        return try {
            client.request {
                this.method = method
                url { takeFrom(Url(baseUrl + path)) }
                contentType(ContentType.Application.Json)
                if (requiresAuth) {
                    val token = tokenStore.current?.accessToken ?: throw ApiError.NotAuthenticated
                    headers { append(HttpHeaders.Authorization, "Bearer $token") }
                }
                if (body != null) {
                    setBody(body)
                }
            }
        } catch (e: ApiError) {
            throw e
        } catch (t: Throwable) {
            // Wrap network / DNS / timeout failures in the typed Transport
            // error so callers don't have to import Ktor types to handle them.
            throw ApiError.Transport(t.message ?: t::class.simpleName ?: "transport failure")
        }
    }

    private suspend fun validate(response: HttpResponse): HttpResponse {
        if (response.status.value in SUCCESS_STATUS_RANGE) return response
        // Non-2xx — try to decode the standard envelope. If parsing fails,
        // surface the raw body so a misconfigured proxy doesn't silently turn
        // into "unknown error".
        val raw = try { response.bodyAsText() } catch (_: Throwable) { "" }
        val envelope = try {
            json.decodeFromString<ApiErrorEnvelope>(raw)
        } catch (_: SerializationException) {
            null
        }
        throw if (envelope != null) {
            ApiError.Server(
                status = response.status.value,
                code = envelope.error.code,
                errorMessage = envelope.error.message,
                requestId = envelope.error.requestId,
            )
        } else {
            ApiError.Server(
                status = response.status.value,
                code = "unknown",
                errorMessage = raw.ifBlank { "<no body>" },
                requestId = "",
            )
        }
    }

    /**
     * Coordinated refresh — the heart of the single-flight pattern. Returns
     * `true` if the refresh succeeded and tokens were rotated, `false` if
     * there was no refresh token to use.
     *
     * Two-phase locking:
     *   1. Acquire [refreshLock] briefly to read-or-set [inFlight]. If a
     *      not-yet-completed refresh is in flight, return its Deferred
     *      immediately. If no Deferred exists or the existing one already
     *      completed (stale — it represents a previous burst's result),
     *      replace it with a fresh one and become the leader.
     *   2. Release the lock, do the actual HTTP call OUTSIDE the lock.
     *      Otherwise concurrent 401s would queue on the lock instead of
     *      sharing the same in-flight result.
     *
     * Why we don't null `inFlight` in a `finally` after the work completes:
     * if a leader runs the refresh inline (e.g. under a test scheduler or
     * a fast loopback) before a follower coroutine has even reached this
     * function, the follower would see `inFlight == null` and start a SECOND
     * refresh — defeating the single-flight invariant. By keeping the
     * completed Deferred in place and replacing it only when a new 401 burst
     * arrives, late-arriving followers from the same burst still join. A
     * brand new 401 (after the rotation succeeded but a separate code path
     * still has a stale token, very rare) sees the completed Deferred,
     * recognizes it as stale, and starts a fresh refresh — correct.
     */
    private suspend fun runRefresh(): Boolean {
        val refreshToken = tokenStore.current?.refreshToken ?: return false

        val (deferred, isLeader) = refreshLock.withLock {
            val existing = inFlight
            if (existing != null && !existing.isCompleted) {
                existing to false
            } else {
                val fresh = CompletableDeferred<Boolean>()
                inFlight = fresh
                fresh to true
            }
        }

        if (!isLeader) {
            return deferred.await()
        }

        // We're the leader — actually do the refresh.
        val result = try {
            val response: AuthResponse = send(
                method = HttpMethod.Post,
                path = "/auth/refresh",
                body = RefreshBody(refreshToken = refreshToken),
                requiresAuth = false,
            )
            tokenStore.applyRefresh(response.accessToken, response.refreshToken)
            // Persist outside the critical path — a slow disk write shouldn't
            // delay the retried request.
            ioScope.launch {
                tokenStore.persistRotated(response.accessToken, response.refreshToken)
            }
            true
        } catch (t: Throwable) {
            // Refresh failed (401, transport, decode). Clear so UI flips to
            // logged-out and the user re-authenticates.
            try { tokenStore.clear() } catch (_: Throwable) { /* ignore */ }
            false
        }
        // Complete the Deferred so any follower coroutines awaiting it wake
        // up with the same Boolean. We deliberately do NOT null `inFlight`
        // here — see kdoc rationale above.
        deferred.complete(result)
        return result
    }

    private companion object {
        // Standard "successful response" range. Inlined as a named constant
        // because magic-number literals (200..299) in network code rot fast.
        val SUCCESS_STATUS_RANGE = 200..299
    }
}
