package `in`.santosh_bharadwaj.sharedlist.core.networking

import `in`.santosh_bharadwaj.sharedlist.core.auth.ApiErrorBody
import `in`.santosh_bharadwaj.sharedlist.core.auth.ApiErrorEnvelope
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthResponse
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthUser
import `in`.santosh_bharadwaj.sharedlist.core.auth.LoginBody
import `in`.santosh_bharadwaj.sharedlist.core.auth.TokenStore
import `in`.santosh_bharadwaj.sharedlist.core.storage.InMemorySecureStorage
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpResponseData
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * Mirrors iOS `APIClientTests`. Same five scenarios:
 *   1. Auth header is injected on auth-required calls.
 *   2. 401 → /auth/refresh → retry succeeds and rotates tokens in TokenStore.
 *   3. 5 concurrent 401s share ONE /auth/refresh (single-flight).
 *   4. Refresh failure clears the TokenStore.
 *   5. Server error envelope is decoded into ApiError.Server with code/message.
 *
 * We use Ktor's `MockEngine` rather than a hand-rolled `HTTPRequesting` fake
 * (the iOS approach) — it ships with Ktor itself, so it's the canonical seam
 * and the path that Ktor's own integration tests use.
 */
class ApiClientTest {
    private val sampleUser = AuthUser(id = "u1", email = "alice@example.com", displayName = "Alice")
    private val sampleErrorBody = json.encodeToString(
        ApiErrorEnvelope(error = ApiErrorBody(code = "http_exception", message = "expired", requestId = "test-rid")),
    )
    private val sampleAuthedUserBody = json.encodeToString(sampleUser)

    @Test
    fun injectsBearerHeaderOnAuthedCall() = runTest {
        val recorder = RequestRecorder()
        val engine = MockEngine { request ->
            recorder.record(request)
            respondJson(sampleAuthedUserBody)
        }
        val (api, _) = buildApi(engine, accessToken = "tkn-A", refreshToken = "tkn-R")

        val user: AuthUser = api.send(method = HttpMethod.Get, path = "/auth/me")
        assertEquals("u1", user.id)

        assertEquals(1, recorder.requests.size)
        assertEquals("Bearer tkn-A", recorder.requests[0].headers[HttpHeaders.Authorization])
    }

    @Test
    fun refreshesAndRetriesOn401() = runTest {
        val recorder = RequestRecorder()
        val refreshBody = json.encodeToString(
            AuthResponse(user = sampleUser, accessToken = "tkn-A2", refreshToken = "tkn-R2"),
        )
        val engine = MockEngine { request ->
            recorder.record(request)
            when {
                request.url.encodedPath == "/auth/refresh" -> respondJson(refreshBody)
                recorder.countFor("/auth/me") == 1 -> respondJsonError(401, sampleErrorBody)
                else -> respondJson(sampleAuthedUserBody)
            }
        }
        val (api, store) = buildApi(engine, accessToken = "tkn-A", refreshToken = "tkn-R")

        val user: AuthUser = api.send(method = HttpMethod.Get, path = "/auth/me")
        assertEquals("u1", user.id)

        assertEquals(3, recorder.requests.size)
        assertEquals("Bearer tkn-A", recorder.requests[0].headers[HttpHeaders.Authorization])
        // /auth/refresh sent without Authorization (refresh body carries the token).
        assertNull(recorder.requests[1].headers[HttpHeaders.Authorization])
        assertEquals("Bearer tkn-A2", recorder.requests[2].headers[HttpHeaders.Authorization])
        assertEquals("tkn-A2", store.current?.accessToken)
        assertEquals("tkn-R2", store.current?.refreshToken)
    }

    @Test
    fun concurrentRequestsShareOneRefresh() = runTest {
        val recorder = RequestRecorder()
        val refreshBody = json.encodeToString(
            AuthResponse(user = sampleUser, accessToken = "tkn-A2", refreshToken = "tkn-R2"),
        )
        val engine = MockEngine { request ->
            recorder.record(request)
            when {
                request.url.encodedPath == "/auth/refresh" -> respondJson(refreshBody)
                // First five /auth/me calls (the ORIGINAL ones, before any retry)
                // get a 401. We count "me" requests; the first 5 receive the
                // 401, the next 5 (retries after refresh) receive the success.
                recorder.countFor("/auth/me") <= CONCURRENT_REQUEST_COUNT -> respondJsonError(401, sampleErrorBody)
                else -> respondJson(sampleAuthedUserBody)
            }
        }
        val (api, _) = buildApi(engine, accessToken = "tkn-A", refreshToken = "tkn-R")

        // Fire N requests concurrently. The single-flight invariant is that
        // exactly ONE /auth/refresh hits the engine, regardless of N.
        coroutineScope {
            (1..CONCURRENT_REQUEST_COUNT)
                .map { async { api.send<AuthUser>(method = HttpMethod.Get, path = "/auth/me") } }
                .awaitAll()
        }

        val refreshCalls = recorder.requests.count { it.url.encodedPath == "/auth/refresh" }
        assertEquals("expected exactly one /auth/refresh call", 1, refreshCalls)
        // CONCURRENT_REQUEST_COUNT initial + 1 refresh + CONCURRENT_REQUEST_COUNT retries.
        assertEquals(2 * CONCURRENT_REQUEST_COUNT + 1, recorder.requests.size)
    }

    @Test
    fun refreshFailureClearsTokenStore() = runTest {
        val recorder = RequestRecorder()
        val engine = MockEngine { request ->
            recorder.record(request)
            // Both /auth/me (initial) and /auth/refresh return 401.
            respondJsonError(401, sampleErrorBody)
        }
        val (api, store) = buildApi(engine, accessToken = "tkn-A", refreshToken = "tkn-R")

        try {
            api.send<AuthUser>(method = HttpMethod.Get, path = "/auth/me")
            fail("expected ApiError")
        } catch (_: ApiError.RefreshFailed) {
            // expected
        } catch (e: Throwable) {
            fail("expected ApiError.RefreshFailed, got ${e::class.simpleName}: ${e.message}")
        }

        assertNull("tokenStore should be cleared after refresh failure", store.current)
    }

    @Test
    fun surfacesServerErrorEnvelope() = runTest {
        val recorder = RequestRecorder()
        val errBody = json.encodeToString(
            ApiErrorEnvelope(error = ApiErrorBody(code = "http_exception", message = "invalid credentials", requestId = "rid-1")),
        )
        val engine = MockEngine { request ->
            recorder.record(request)
            respondJsonError(401, errBody)
        }
        val (api, _) = buildApi(engine, accessToken = null, refreshToken = null)

        try {
            api.send<AuthResponse>(
                method = HttpMethod.Post,
                path = "/auth/login",
                body = LoginBody(email = "a@b.c", password = "wrongpassword!"),
                requiresAuth = false,
            )
            fail("expected ApiError.Server")
        } catch (e: ApiError.Server) {
            assertEquals(401, e.status)
            assertEquals("http_exception", e.code)
            assertEquals("invalid credentials", e.errorMessage)
        }
    }

    // --- helpers -----------------------------------------------------------

    private suspend fun buildApi(
        engine: MockEngine,
        accessToken: String?,
        refreshToken: String?,
    ): Pair<ApiClient, TokenStore> {
        val storage = InMemorySecureStorage()
        val store = TokenStore(storage)
        if (accessToken != null && refreshToken != null) {
            store.save(
                TokenStore.Tokens(accessToken = accessToken, refreshToken = refreshToken, user = sampleUser),
            )
        }
        val api = ApiClient(baseUrl = "https://example.test", tokenStore = store, engine = engine)
        return api to store
    }

    private fun MockRequestHandleScope.respondJson(body: String): HttpResponseData = respond(
        content = ByteReadChannel(body),
        status = HttpStatusCode.OK,
        headers = headersOf(HttpHeaders.ContentType, "application/json"),
    )

    private fun MockRequestHandleScope.respondJsonError(status: Int, body: String): HttpResponseData = respond(
        content = ByteReadChannel(body),
        status = HttpStatusCode.fromValue(status),
        headers = headersOf(HttpHeaders.ContentType, "application/json"),
    )

    /**
     * Records every request the engine sees, so tests can assert on call count,
     * order, and per-request headers.
     */
    private class RequestRecorder {
        val requests: MutableList<HttpRequestData> = mutableListOf()
        fun record(request: HttpRequestData) {
            synchronized(requests) { requests.add(request) }
        }
        fun countFor(path: String): Int = synchronized(requests) {
            requests.count { it.url.encodedPath == path }
        }
    }

    private companion object {
        // Mirrors iOS test: 5 concurrent /auth/me calls collapse to 1 refresh.
        const val CONCURRENT_REQUEST_COUNT = 5
        val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}
