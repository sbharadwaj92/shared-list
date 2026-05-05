import Foundation

// AuthService is the domain layer between the UI and APIClient/TokenStore.
//
// Why a separate type rather than calling APIClient directly from views?
//   - It owns the "what does signup mean" sequencing: hit the endpoint, save
//     the returned tokens via TokenStore. A view shouldn't have to know that
//     order — it just calls `await auth.signup(email:..., password:...)`.
//   - It's the seam where future cross-cutting auth concerns land (e.g., a
//     "force log out" reaction to a 401 from a non-auth endpoint, or a
//     "biometric re-auth before sensitive action" hook).
//   - Tests can fake AuthService to drive the views without standing up the
//     full APIClient stack.
//
// The methods are MainActor-isolated to match TokenStore. View models call
// these from `await` blocks inside Task { ... } closures launched from button
// taps; the await hop is free in practice.

@MainActor
public protocol AuthServicing: AnyObject, Sendable {
    func signup(email: String, password: String, displayName: String) async throws -> AuthUser
    func login(email: String, password: String) async throws -> AuthUser
    func logout() async
    func currentUser() -> AuthUser?
}

@MainActor
public final class AuthService: AuthServicing {
    private let api: APIClient
    private let tokenStore: TokenStore

    public init(api: APIClient, tokenStore: TokenStore) {
        self.api = api
        self.tokenStore = tokenStore
    }

    public func signup(email: String, password: String, displayName: String) async throws -> AuthUser {
        let body = SignupBody(email: email, password: password, displayName: displayName)
        let response: AuthResponse = try await api.send(
            method: "POST",
            path: "/auth/signup",
            body: body,
            requiresAuth: false
        )
        try await tokenStore.save(.init(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            user: response.user
        ))
        return response.user
    }

    public func login(email: String, password: String) async throws -> AuthUser {
        let body = LoginBody(email: email, password: password)
        let response: AuthResponse = try await api.send(
            method: "POST",
            path: "/auth/login",
            body: body,
            requiresAuth: false
        )
        try await tokenStore.save(.init(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            user: response.user
        ))
        return response.user
    }

    public func logout() async {
        // Best-effort: tell the backend to revoke this device's refresh
        // token, then clear local state regardless of network outcome.
        // The user's intent ("log me out") must always succeed locally
        // even if the device is offline; the backend rotates+revokes
        // the next time the token is used and reuse-detection wins.
        if let refreshToken = tokenStore.current?.refreshToken {
            do {
                try await api.sendNoContent(
                    method: "POST",
                    path: "/auth/logout",
                    body: LogoutBody(refreshToken: refreshToken),
                    requiresAuth: false
                )
            } catch {
                // Swallow: the server-side revocation is a nice-to-have.
                // Local clear() below is the user-visible operation.
            }
        }
        await tokenStore.clear()
    }

    public func currentUser() -> AuthUser? {
        tokenStore.current?.user
    }
}
