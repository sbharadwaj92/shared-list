import Foundation
import SwiftData
import SwiftUI

// Manual DI container. PLAN.md mandates this approach (vs. property wrappers
// like @EnvironmentObject for everything, or a third-party DI library):
//
//   1. Constructors take the dependencies they need, no global lookup, no
//      magic. Anyone reading a type's signature sees what it touches.
//   2. Lifecycle is explicit. The container is constructed once at app
//      launch, and every singleton lives for the app's lifetime.
//   3. No reflection, no runtime registration — Swift's type system enforces
//      that every dependency is wired before the program runs.
//
// We thread the container through SwiftUI via `Environment` so views deep in
// the tree can pull what they need without prop-drilling. That's the only
// "magic" here, and it's standard SwiftUI.

@MainActor
public final class AppContainer {
    public let keychain: any KeychainStoring
    public let tokenStore: TokenStore
    public let api: APIClient
    public let auth: any AuthServicing
    public let networkMonitor: any NetworkMonitoring
    public let modelContainer: ModelContainer
    public let syncEngine: SyncEngine
    public let mutator: Mutator
    public let drainer: Drainer

    // The base URL is hardcoded for v1 — local backend on the user's Mac at
    // its mDNS hostname. Putting it in code rather than Info.plist keeps the
    // configuration close to the construction site; if we ever support a
    // staging/prod endpoint, this is the obvious place to gate on a build
    // flag. PLAN.md is clear that off-LAN access is out of scope, so this
    // single URL is sufficient.
    public static let defaultBaseURL = URL(string: "https://Santoshs-MacBook-Pro-48.local")!

    public init(baseURL: URL = AppContainer.defaultBaseURL) {
        let keychain = KeychainStore()
        let tokenStore = TokenStore(keychain: keychain)
        let api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        let auth = AuthService(api: api, tokenStore: tokenStore)
        let monitor = NetworkMonitor()
        let modelContainer = AppContainer.makeModelContainer()
        let syncEngine = SyncEngine(
            api: api,
            container: modelContainer,
            monitor: monitor,
            currentUserId: { [weak auth] in auth?.currentUser()?.id }
        )
        let mutator = Mutator(container: modelContainer)
        let drainer = Drainer(
            api: api,
            container: modelContainer,
            monitor: monitor,
            syncEngine: syncEngine
        )
        // Two-phase wiring: Mutator + Drainer reference each other (mutator
        // kicks drainer post-save; drainer reads queue rows mutator wrote).
        // Constructing one-then-the-other and patching the back-reference
        // breaks the cycle without forcing an Optional or a lazy var.
        mutator.attachDrainer(drainer)

        self.keychain = keychain
        self.tokenStore = tokenStore
        self.api = api
        self.auth = auth
        self.networkMonitor = monitor
        self.modelContainer = modelContainer
        self.syncEngine = syncEngine
        self.mutator = mutator
        self.drainer = drainer
    }

    // Test/preview seam: build a container with hand-supplied collaborators.
    // We use this in #Preview blocks (real Keychain doesn't work in previews
    // on some Xcode versions) and in unit tests that want a real APIClient
    // wired to a mocked URLSession.
    public init(
        keychain: any KeychainStoring,
        tokenStore: TokenStore,
        api: APIClient,
        auth: any AuthServicing,
        networkMonitor: any NetworkMonitoring,
        modelContainer: ModelContainer,
        syncEngine: SyncEngine,
        mutator: Mutator,
        drainer: Drainer
    ) {
        self.keychain = keychain
        self.tokenStore = tokenStore
        self.api = api
        self.auth = auth
        self.networkMonitor = networkMonitor
        self.modelContainer = modelContainer
        self.syncEngine = syncEngine
        self.mutator = mutator
        self.drainer = drainer
        // Same two-phase wiring as the production initializer; a test
        // that builds these manually still wants the kick-on-save link.
        mutator.attachDrainer(drainer)
    }

    // Called from SharedListApp on launch to hydrate any persisted session.
    public func bootstrap() async {
        await tokenStore.loadFromKeychain()
    }

    /// Build the SwiftData container with all `@Model` types this app uses.
    /// Failure to build the container is a programmer error (schema mismatch,
    /// disk full, …) — we crash with a clear message rather than continue
    /// with no persistence and silent data loss. This mirrors how Apple's
    /// own templates handle `ModelContainer` construction.
    private static func makeModelContainer() -> ModelContainer {
        do {
            return try ModelContainer(
                for: UserModel.self,
                ListModel.self,
                ItemModel.self,
                MemberModel.self,
                SyncCursor.self,
                // MutationQueueEntry joined the schema in slice C.2. The order
                // doesn't matter — SwiftData hashes the type set — but we keep
                // it last so the diff is small.
                MutationQueueEntry.self
            )
        } catch {
            fatalError("Failed to construct ModelContainer: \(error)")
        }
    }
}

// SwiftUI environment plumbing. Reading `@Environment(\.appContainer)` in any
// view returns the running container; the @main App injects it once via
// `.environment(\.appContainer, container)`.
//
// We expose the value as Optional rather than non-optional + fatalError. The
// reason is subtle: `EnvironmentKey.defaultValue` must be nonisolated, but
// `AppContainer.init()` is @MainActor (it touches Keychain, TokenStore, etc).
// A fatalError default works at runtime but it ALSO gets evaluated by Xcode's
// preview / test harness in some configurations during host-app launch,
// crashing the app before our `.environment(...)` modifier in SharedListApp
// has a chance to inject the real value. An Optional default with `nil`
// avoids any "default lookup runs the actor-isolated init" pitfall and is
// the pattern Apple's own sample code uses for app-scoped containers.
//
// Views that need the container do `@Environment(\.appContainer) var container`
// and reach for `container?` — but in practice every view sits below the
// SharedListApp injection, so the unwrap is via the unwrap accessor below.
private struct AppContainerKey: EnvironmentKey {
    static let defaultValue: AppContainer? = nil
}

extension EnvironmentValues {
    public var appContainer: AppContainer? {
        get { self[AppContainerKey.self] }
        set { self[AppContainerKey.self] = newValue }
    }
}
