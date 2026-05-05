import Foundation
import SwiftData

#if DEBUG
// Helpers used only by SwiftUI #Preview blocks. Compiled out of release
// builds via #if DEBUG so the production binary doesn't carry preview-only
// code paths.
//
// We construct an AppContainer with an in-memory Keychain (real Keychain
// behavior in previews is unreliable across Xcode versions) and a stub
// AuthService that doesn't hit the network. Previews that just need to
// render UI in different states (logged in / logged out) can use these
// without standing up the live backend.

@MainActor
enum PreviewSupport {
    static func loggedOutContainer() -> AppContainer {
        makeContainer(behavior: .alwaysLoggedOut, seedSession: false)
    }

    static func loggedInContainer() -> AppContainer {
        // Seed a session synchronously so the preview comes up with state.
        // The Task is fire-and-forget; the preview view re-renders when the
        // state lands, which is exactly the behavior we'd see at runtime.
        let container = makeContainer(behavior: .alwaysLoggedIn, seedSession: true)
        return container
    }

    private static func makeContainer(behavior: StubAuthService.Behavior, seedSession: Bool) -> AppContainer {
        let keychain = InMemoryKeychainStore()
        let tokenStore = TokenStore(keychain: keychain)
        let api = APIClient(baseURL: AppContainer.defaultBaseURL, tokenStore: tokenStore)
        let auth = StubAuthService(tokenStore: tokenStore, behavior: behavior)
        let monitor = MockNetworkMonitor(isOnline: true)
        let modelContainer = previewModelContainer()
        let syncEngine = SyncEngine(
            api: api,
            container: modelContainer,
            monitor: monitor,
            currentUserId: { [weak auth] in auth?.currentUser()?.id }
        )
        if seedSession {
            Task { @MainActor in
                try? await tokenStore.save(.init(
                    accessToken: "preview-access",
                    refreshToken: "preview-refresh",
                    user: AuthUser(id: "preview-user", email: "alice@example.com", displayName: "Alice")
                ))
            }
        }
        return AppContainer(
            keychain: keychain,
            tokenStore: tokenStore,
            api: api,
            auth: auth,
            networkMonitor: monitor,
            modelContainer: modelContainer,
            syncEngine: syncEngine
        )
    }

    /// Build a SwiftData container with `isStoredInMemoryOnly: true` so each
    /// preview / test session gets a fresh empty store and writes don't bleed
    /// across runs. The schema lists every `@Model` type the app uses; if a
    /// type is added in production code, this list must grow too.
    static func previewModelContainer() -> ModelContainer {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        do {
            return try ModelContainer(
                for: UserModel.self,
                ListModel.self,
                ItemModel.self,
                MemberModel.self,
                SyncCursor.self,
                configurations: configuration
            )
        } catch {
            fatalError("Failed to construct preview ModelContainer: \(error)")
        }
    }
}

@MainActor
final class StubAuthService: AuthServicing {
    enum Behavior {
        case alwaysLoggedOut
        case alwaysLoggedIn
    }

    private let tokenStore: TokenStore
    private let behavior: Behavior

    init(tokenStore: TokenStore, behavior: Behavior) {
        self.tokenStore = tokenStore
        self.behavior = behavior
    }

    func signup(email: String, password: String, displayName: String) async throws -> AuthUser {
        let user = AuthUser(id: "stub-id", email: email, displayName: displayName)
        if behavior == .alwaysLoggedIn {
            try await tokenStore.save(.init(
                accessToken: "stub-access",
                refreshToken: "stub-refresh",
                user: user
            ))
        }
        return user
    }

    func login(email: String, password: String) async throws -> AuthUser {
        let user = AuthUser(id: "stub-id", email: email, displayName: "Stub User")
        if behavior == .alwaysLoggedIn {
            try await tokenStore.save(.init(
                accessToken: "stub-access",
                refreshToken: "stub-refresh",
                user: user
            ))
        }
        return user
    }

    func logout() async {
        await tokenStore.clear()
    }

    func currentUser() -> AuthUser? {
        tokenStore.current?.user
    }
}
#endif
