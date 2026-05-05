import Foundation

// APIClient — single point of network access for the iOS app.
//
// Responsibilities, in order of importance:
//   1. Send Codable bodies, decode Codable responses, surface typed errors.
//   2. Inject `Authorization: Bearer <accessToken>` from TokenStore.
//   3. On a 401, refresh the access token AT MOST ONCE PER REQUEST and retry,
//      with multiple concurrent in-flight requests sharing one refresh.
//
// Concept #3 is the "single-flight refresh" pattern. Why it matters:
//
//   - Suppose ten requests fire from ten ViewModels at app foreground.
//   - The access token has expired since last use.
//   - All ten get a 401.
//   - Without single-flight, all ten would call /auth/refresh in parallel.
//     The backend's refresh endpoint rotates the refresh token (new one issued,
//     old one marked used). The first request swaps the token, but the other
//     nine race using the same OLD refresh token. The backend's reuse
//     detection then revokes ALL refresh tokens for the user — instant logout.
//   - With single-flight: the first 401 starts a single refresh `Task`; every
//     other concurrent 401 awaits that same Task; when it completes, all
//     callers retry their original request with the new access token.
//
// The implementation here uses an actor (`RefreshCoordinator`) to protect the
// "is a refresh in flight" state. An actor serializes its own methods, so two
// concurrent calls to `refreshIfNeeded()` will see each other; the first
// starts the Task and stores it, the second sees the stored Task and awaits
// the same value. Once the Task completes, the coordinator nils out the
// reference so the next 401 can trigger a fresh refresh.
//
// Note: we deliberately do NOT proactively check token expiry before each
// request. There are two reasons:
//   1. The access token's `exp` is on the server; we'd have to re-derive it
//      from the JWT or cache the issued time, both of which add code without
//      changing the user-visible behavior.
//   2. Reactive (refresh on 401) handles the correct cases (clock skew, server
//      clock drift, sleep/wake jitter) for free.
//
// What we WILL want eventually but not this phase:
//   - Request cancellation propagation (cancelling the calling Task should
//     cancel the URLSessionTask). URLSession cooperates with structured
//     cancellation already; we just need to make sure we don't shield it.
//   - Retry-after handling on 429 (rate-limited paths). Not needed for v1.

public enum APIError: Error, Sendable, Equatable {
    case notAuthenticated
    case server(status: Int, code: String, message: String, requestId: String)
    case decoding(String)
    case transport(message: String)
    case refreshFailed
}

// Protocol so tests can inject a fake. We only model the surface area we
// actually use; URLSession itself conforms to this with no extra glue.
public protocol HTTPRequesting: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPRequesting {}

public final class APIClient: Sendable {
    public let baseURL: URL
    private let session: any HTTPRequesting
    private let tokenStore: TokenStore
    private let refresher: RefreshCoordinator
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    /// JSON decoder configured to match the backend's wire format
    /// (ISO8601 timestamps). Exposed so callers that go through the raw
    /// path (`sendRaw`) decode response bodies with the same settings as
    /// `send`. Not for general use — most call sites should use `send`
    /// or `sendNoContent`.
    public var responseDecoder: JSONDecoder { decoder }

    public init(baseURL: URL, session: any HTTPRequesting = URLSession.shared, tokenStore: TokenStore) {
        self.baseURL = baseURL
        self.session = session
        self.tokenStore = tokenStore
        self.refresher = RefreshCoordinator()
        // Use the shared millisecond-precision ISO8601 strategy. We
        // can't use `JSONDecoder.DateDecodingStrategy.iso8601` directly
        // because it wraps an ISO8601DateFormatter with the default
        // `formatOptions = .withInternetDateTime` — that's
        // second-precision only and silently drops fractional seconds
        // both on encode and decode. The backend's `?since=` cursor +
        // every `updated_at` value is millisecond-precision (Postgres
        // `date_trunc('milliseconds', now())`), so the round-trip
        // through Foundation's default would corrupt cursors and
        // chained If-Match values. See `JSONCoders.swift` for the
        // shared formatter.
        self.decoder = JSONCoders.makeDecoder()
        self.encoder = JSONCoders.makeEncoder()
    }

    // Public entry point. The generic `Body: Encodable` covers both nil-body
    // (GET) and JSON-body (POST/PATCH) requests; passing `EmptyBody()` for GETs
    // keeps the call sites readable. `Response: Decodable` covers responses;
    // `EmptyResponse` for 204 endpoints.
    //
    // `requiresAuth` controls whether we add the bearer token. Login/signup
    // are unauth; everything else is auth. Refresh has a special path inside
    // `RefreshCoordinator` because it must NOT itself trigger another refresh.
    public func send<Body: Encodable & Sendable, Response: Decodable & Sendable>(
        method: String,
        path: String,
        body: Body? = nil,
        requiresAuth: Bool = true,
        responseType: Response.Type = Response.self
    ) async throws -> Response {
        let request = try await buildRequest(method: method, path: path, body: body, requiresAuth: requiresAuth)
        let (data, response) = try await performWithRefresh(request: request, requiresAuth: requiresAuth)
        return try decode(data: data, response: response)
    }

    // Send variant that returns no body (204). Decoding `Void` is awkward in
    // Swift, so we model it as a separate entry point rather than torturing
    // generics. The data is read but ignored.
    public func sendNoContent<Body: Encodable & Sendable>(
        method: String,
        path: String,
        body: Body? = nil,
        requiresAuth: Bool = true
    ) async throws {
        let request = try await buildRequest(method: method, path: path, body: body, requiresAuth: requiresAuth)
        let (data, response) = try await performWithRefresh(request: request, requiresAuth: requiresAuth)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "non-HTTP response")
        }
        if !(200..<300).contains(http.statusCode) {
            throw Self.decodeErrorEnvelope(data: data, status: http.statusCode)
        }
    }

    /// Raw send variant: returns `(data, status, headers)` without
    /// throwing on non-2xx. The Drainer (slice C.3) needs this because
    /// 409 is a valid path-and-data response (the body carries
    /// `latest: …DTO` for the merge), not an error to surface up. The
    /// 401 single-flight-refresh + extra-header injection (`If-Match`)
    /// is shared with `send`/`sendNoContent`, only the response handling
    /// differs — caller switches on status itself.
    public func sendRaw<Body: Encodable & Sendable>(
        method: String,
        path: String,
        body: Body? = nil,
        extraHeaders: [String: String] = [:],
        requiresAuth: Bool = true
    ) async throws -> (data: Data, status: Int) {
        var request = try await buildRequest(
            method: method,
            path: path,
            body: body,
            requiresAuth: requiresAuth
        )
        for (k, v) in extraHeaders {
            request.setValue(v, forHTTPHeaderField: k)
        }
        let (data, response) = try await performWithRefresh(request: request, requiresAuth: requiresAuth)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "non-HTTP response")
        }
        return (data, http.statusCode)
    }

    // MARK: - Internals

    private func buildRequest<Body: Encodable & Sendable>(
        method: String,
        path: String,
        body: Body?,
        requiresAuth: Bool
    ) async throws -> URLRequest {
        // Treat the path as a relative path; URL(string:relativeTo:) handles
        // the join. Paths must start with "/" for predictable behavior.
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.transport(message: "invalid url for path: \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body, !(body is EmptyBody) {
            request.httpBody = try encoder.encode(body)
        }
        if requiresAuth {
            guard let token = await currentAccessToken() else {
                throw APIError.notAuthenticated
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    @MainActor
    private func currentAccessTokenOnMain() -> String? {
        tokenStore.current?.accessToken
    }

    @MainActor
    private func currentRefreshTokenOnMain() -> String? {
        tokenStore.current?.refreshToken
    }

    private func currentAccessToken() async -> String? {
        await currentAccessTokenOnMain()
    }

    private func currentRefreshToken() async -> String? {
        await currentRefreshTokenOnMain()
    }

    private func performWithRefresh(
        request: URLRequest,
        requiresAuth: Bool
    ) async throws -> (Data, URLResponse) {
        // Capture the access token used for this request so we can later
        // detect "another coroutine rotated the token between my request
        // build and my 401 response" without triggering a redundant
        // refresh. This is the canonical compare-and-retry pattern (OkHttp
        // Authenticator on Android does the same shape).
        //
        // The Android port surfaced this race under JUnit's deterministic
        // scheduler: a leader coroutine could complete refresh + retry
        // entirely before a follower coroutine finished its initial 401.
        // The follower's 401 was caused by stale-of-pre-rotation token,
        // not by genuinely invalid credentials — so it should retry
        // without refreshing again. Matching the iOS code to that pattern
        // hardens it against any future scheduler behavior, not just
        // today's URLSession latency masking.
        let accessTokenAtSend = requiresAuth ? request.value(forHTTPHeaderField: "Authorization") : nil
        let (data, response) = try await sendOnce(request: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "non-HTTP response")
        }

        if http.statusCode == 401 && requiresAuth {
            let currentBearer = await currentAccessToken().map { "Bearer \($0)" }
            let tokenChangedByAnotherCaller = accessTokenAtSend != nil
                && currentBearer != nil
                && currentBearer != accessTokenAtSend

            if !tokenChangedByAnotherCaller {
                // Token at send time matches current token → genuinely
                // stale, coordinate a refresh. Single-flight collapses
                // concurrent callers in the SAME burst onto one refresh.
                let refreshed = try await runRefresh()
                if !refreshed {
                    throw APIError.refreshFailed
                }
            }

            // Rebuild the request with whatever token is current now —
            // either rotated by us, or already rotated by another caller.
            var retried = request
            if let token = await currentAccessToken() {
                retried.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            return try await sendOnce(request: retried)
        }
        return (data, response)
    }

    private func sendOnce(request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(message: error.localizedDescription)
        } catch {
            throw APIError.transport(message: error.localizedDescription)
        }
    }

    // Run the refresh (single-flight). Returns true if refresh succeeded and
    // tokens were rotated; false if there was no refresh token to use.
    // RefreshCoordinator collapses concurrent calls into one shared Task.
    private func runRefresh() async throws -> Bool {
        guard let refreshToken = await currentRefreshToken() else {
            return false
        }
        return try await refresher.run { [self] in
            do {
                let response: AuthResponse = try await self.send(
                    method: "POST",
                    path: "/auth/refresh",
                    body: RefreshBody(refreshToken: refreshToken),
                    requiresAuth: false
                )
                // Hop to MainActor to update TokenStore. We must wait for this
                // to complete before returning so the retried request can read
                // the new access token.
                try await MainActor.run {
                    try self.tokenStore.applyRefresh(
                        accessToken: response.accessToken,
                        refreshToken: response.refreshToken
                    )
                }
                // Persist the rotated tokens to Keychain. Failure here doesn't
                // block the retry — worst case is a relaunch finds the old
                // tokens and triggers another refresh, which is fine.
                try? await self.tokenStore.persistRotated(
                    accessToken: response.accessToken,
                    refreshToken: response.refreshToken
                )
                return true
            } catch {
                // Refresh-token failure (401, network, decode). Clear so UI
                // flips to logged-out and the user re-authenticates.
                await self.tokenStore.clear()
                return false
            }
        }
    }

    private func decode<T: Decodable>(data: Data, response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.decodeErrorEnvelope(data: data, status: http.statusCode)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }

    private static func decodeErrorEnvelope(data: Data, status: Int) -> APIError {
        let decoder = JSONDecoder()
        if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
            return APIError.server(
                status: status,
                code: envelope.error.code,
                message: envelope.error.message,
                requestId: envelope.error.requestId
            )
        }
        // Backend should always send the envelope, but if a misconfigured
        // proxy returns plain text we still want a structured error.
        let body = String(data: data, encoding: .utf8) ?? "<no body>"
        return APIError.server(status: status, code: "unknown", message: body, requestId: "")
    }
}

// Empty body / response sentinels. Calls that take no body pass `EmptyBody()`;
// calls that return no body use the `sendNoContent` overload. We avoid
// `Void` in the generic position because Void isn't Decodable.
public struct EmptyBody: Codable, Sendable, Equatable {
    public init() {}
}

public struct EmptyResponse: Codable, Sendable, Equatable {
    public init() {}
}

// Actor that ensures exactly one /auth/refresh is in flight at a time.
//
// Why an actor and not a lock? Two reasons:
//   - The work being protected is async (an HTTP call). NSLock or DispatchSemaphore
//     would deadlock if the held thread suspends. Actors are designed for this:
//     they serialize message handling but allow suspension inside the work.
//   - Sendable check: the in-flight Task is itself Sendable, so storing it on
//     an actor and handing references to other tasks is type-safe by construction.
//
// We DO clear `inFlight` after completion. Earlier we kept the completed
// Task around in an attempt to make late-arriving followers (those that
// reached `run(_:)` after the leader had already finished) join the cached
// result instead of starting a fresh refresh. But a completed Task with
// result `true` returned to such a follower means the follower then
// retries with the rotated access token — which is exactly what
// performWithRefresh now does directly via the compare-and-retry guard
// above the call to `runRefresh()`. The guard means `runRefresh()` is
// only invoked when the access token is genuinely stale (no other caller
// has rotated yet), so the in-flight Task is the right thing to share
// among genuinely concurrent callers, and clearing it on completion lets
// a future stale-token burst start fresh — correct.
private actor RefreshCoordinator {
    private var inFlight: Task<Bool, any Error>?

    func run(_ work: @Sendable @escaping () async throws -> Bool) async throws -> Bool {
        if let existing = inFlight {
            // A refresh is currently running. Awaiting the same Task means
            // we get the same Bool / thrown error for free.
            return try await existing.value
        }
        let task = Task<Bool, any Error> {
            try await work()
        }
        inFlight = task
        defer {
            // Clear the reference AFTER the task finishes so the next
            // genuinely-stale 401 burst can start a fresh refresh. Safe
            // because performWithRefresh's compare-and-retry guard means
            // a "follower whose 401 was caused by another caller's
            // rotation" never reaches us in the first place.
            inFlight = nil
        }
        return try await task.value
    }
}

