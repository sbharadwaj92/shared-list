import Foundation
import Testing
@testable import SharedList

// APIClient tests focus on the bits that require careful design:
//   1. Auth header injection on auth-required calls.
//   2. 401 → refresh → retry on a single request.
//   3. Single-flight refresh: ten concurrent 401s trigger ONE /auth/refresh.
//   4. Refresh failure clears TokenStore.
//
// We don't bother testing happy-path JSON encoding/decoding in depth — that's
// Foundation's responsibility and changing JSONEncoder/Decoder isn't part of
// our value-add. Tests focus on our own logic.
//
// The fake `HTTPRequesting` matches request URL paths to scripted responses.
// Each invocation of `data(for:)` consumes one entry from the corresponding
// queue. The fake also records every request that came in so tests can
// assert on call counts and ordering.

@Suite("APIClient")
@MainActor
struct APIClientTests {
    @Test func injectsBearerHeaderOnAuthedCall() async throws {
        let session = MockSession()
        session.enqueue(path: "/auth/me", response: .success(authedUserJSON))

        let store = TokenStore(keychain: InMemoryKeychainStore())
        try await seedToken(store: store, access: "tkn-A", refresh: "tkn-R")
        let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)

        let user: AuthUser = try await api.send(method: "GET", path: "/auth/me", body: EmptyBody())
        #expect(user.id == "u1")

        let recorded = await session.requests
        #expect(recorded.count == 1)
        #expect(recorded.first?.value(forHTTPHeaderField: "Authorization") == "Bearer tkn-A")
    }

    @Test func refreshesAndRetriesOn401() async throws {
        let session = MockSession()
        // /auth/me first returns 401, then 200 after refresh rotates the token.
        session.enqueue(path: "/auth/me", response: .failure(status: 401, body: errorBody(code: "http_exception", message: "expired")))
        session.enqueue(path: "/auth/refresh", response: .success(refreshResponseJSON(access: "tkn-A2", refresh: "tkn-R2")))
        session.enqueue(path: "/auth/me", response: .success(authedUserJSON))

        let store = TokenStore(keychain: InMemoryKeychainStore())
        try await seedToken(store: store, access: "tkn-A", refresh: "tkn-R")
        let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)

        let user: AuthUser = try await api.send(method: "GET", path: "/auth/me", body: EmptyBody())
        #expect(user.id == "u1")

        let recorded = await session.requests
        #expect(recorded.count == 3)
        // The first /auth/me request used the original token.
        #expect(recorded[0].value(forHTTPHeaderField: "Authorization") == "Bearer tkn-A")
        // /auth/refresh is sent without auth header (refresh body carries the refresh token).
        #expect(recorded[1].value(forHTTPHeaderField: "Authorization") == nil)
        // Retried /auth/me carries the rotated access token.
        #expect(recorded[2].value(forHTTPHeaderField: "Authorization") == "Bearer tkn-A2")
        #expect(store.current?.accessToken == "tkn-A2")
        #expect(store.current?.refreshToken == "tkn-R2")
    }

    @Test func concurrentRequestsShareOneRefresh() async throws {
        let session = MockSession()
        // Each of 5 concurrent requests gets a 401 first.
        for _ in 0..<5 {
            session.enqueue(path: "/auth/me", response: .failure(status: 401, body: errorBody(code: "http_exception", message: "expired")))
        }
        // Exactly one refresh response is enqueued — if the implementation
        // makes two refresh calls, the second will find the queue empty and
        // the test will fail with `unscriptedRequest`.
        session.enqueue(path: "/auth/refresh", response: .success(refreshResponseJSON(access: "tkn-A2", refresh: "tkn-R2")))
        // After refresh, all 5 retried requests succeed.
        for _ in 0..<5 {
            session.enqueue(path: "/auth/me", response: .success(authedUserJSON))
        }

        let store = TokenStore(keychain: InMemoryKeychainStore())
        try await seedToken(store: store, access: "tkn-A", refresh: "tkn-R")
        let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)

        // Fire 5 calls in parallel.
        try await withThrowingTaskGroup(of: AuthUser.self) { group in
            for _ in 0..<5 {
                group.addTask {
                    try await api.send(method: "GET", path: "/auth/me", body: EmptyBody())
                }
            }
            for try await _ in group {}
        }

        let recorded = await session.requests
        // 5 initial /me + 1 /refresh + 5 retried /me = 11.
        #expect(recorded.count == 11)
        let refreshCalls = recorded.filter { $0.url?.path == "/auth/refresh" }.count
        #expect(refreshCalls == 1)
    }

    @Test func refreshFailureClearsTokenStore() async throws {
        let session = MockSession()
        session.enqueue(path: "/auth/me", response: .failure(status: 401, body: errorBody(code: "http_exception", message: "expired")))
        // Refresh itself returns 401 (e.g., refresh token revoked).
        session.enqueue(path: "/auth/refresh", response: .failure(status: 401, body: errorBody(code: "http_exception", message: "refresh invalid")))

        let store = TokenStore(keychain: InMemoryKeychainStore())
        try await seedToken(store: store, access: "tkn-A", refresh: "tkn-R")
        let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)

        await #expect(throws: APIError.self) {
            let _: AuthUser = try await api.send(method: "GET", path: "/auth/me", body: EmptyBody())
        }
        #expect(store.current == nil)
    }

    @Test func surfacesServerErrorEnvelope() async throws {
        let session = MockSession()
        session.enqueue(
            path: "/auth/login",
            response: .failure(status: 401, body: errorBody(code: "http_exception", message: "invalid credentials"))
        )
        let store = TokenStore(keychain: InMemoryKeychainStore())
        let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)

        do {
            let _: AuthResponse = try await api.send(
                method: "POST",
                path: "/auth/login",
                body: LoginBody(email: "a@b.c", password: "wrongpassword!"),
                requiresAuth: false
            )
            Issue.record("expected error")
        } catch let APIError.server(status, code, message, _) {
            #expect(status == 401)
            #expect(code == "http_exception")
            #expect(message == "invalid credentials")
        } catch {
            Issue.record("expected APIError.server, got \(error)")
        }
    }
}

// MARK: - Test fixtures

private let testBaseURL = URL(string: "https://example.test")!

private let authedUserJSON: Data = {
    let u = AuthUser(id: "u1", email: "alice@example.com", displayName: "Alice")
    return try! JSONEncoder().encode(u)
}()

private func refreshResponseJSON(access: String, refresh: String) -> Data {
    let body = AuthResponse(
        user: AuthUser(id: "u1", email: "alice@example.com", displayName: "Alice"),
        accessToken: access,
        refreshToken: refresh
    )
    return try! JSONEncoder().encode(body)
}

private func errorBody(code: String, message: String) -> Data {
    let env = APIErrorEnvelope(error: .init(code: code, message: message, requestId: "test-rid"))
    return try! JSONEncoder().encode(env)
}

@MainActor
private func seedToken(store: TokenStore, access: String, refresh: String) async throws {
    try await store.save(.init(
        accessToken: access,
        refreshToken: refresh,
        user: AuthUser(id: "u1", email: "alice@example.com", displayName: "Alice")
    ))
}

// MARK: - MockSession

actor MockSession: HTTPRequesting {
    enum ScriptedResponse {
        case success(Data)
        case failure(status: Int, body: Data)
    }

    private struct Entry {
        let response: ScriptedResponse
    }

    private var queues: [String: [Entry]] = [:]
    var requests: [URLRequest] = []

    nonisolated func enqueue(path: String, response: ScriptedResponse) {
        Task { await self.appendInternal(path: path, response: response) }
    }

    private func appendInternal(path: String, response: ScriptedResponse) {
        queues[path, default: []].append(Entry(response: response))
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        // Wait for any pending `enqueue` calls to drain. The test setup uses
        // `nonisolated` enqueue + Task hop, so a tightly-scheduled test could
        // call data(for:) before all enqueues land. A small await yields once.
        await Task.yield()

        requests.append(request)
        let path = request.url?.path ?? ""
        guard !(queues[path]?.isEmpty ?? true), let entry = queues[path]?.removeFirst() else {
            throw MockSessionError.unscriptedRequest(path: path)
        }
        let url = request.url ?? testBaseURL
        switch entry.response {
        case .success(let data):
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            return (data, response)
        case .failure(let status, let body):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            return (body, response)
        }
    }
}

enum MockSessionError: Error, CustomStringConvertible {
    case unscriptedRequest(path: String)
    var description: String {
        switch self {
        case .unscriptedRequest(let path):
            return "MockSession got an unscripted request for path: \(path)"
        }
    }
}
