import SwiftUI

// App entry. Constructs the AppContainer once, runs bootstrap to hydrate any
// persisted session, then hands the SwiftUI tree a RootView with the
// container injected via the environment.
//
// The `@State container` lifetime matches the App's, which itself outlives
// every Scene — exactly the lifecycle we want for our long-lived singletons.

@main
struct SharedListApp: App {
    @State private var container = AppContainer()
    @State private var didBootstrap = false

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(\.appContainer, container)
                .modelContainer(container.modelContainer)
                .task {
                    // `.task` on the RootView is run-once on appear. Doing
                    // bootstrap here (rather than in init) keeps the App
                    // initializer synchronous, which makes SwiftUI happier
                    // and avoids subtle ordering issues with state setup.
                    if !didBootstrap {
                        await container.bootstrap()
                        // Slice B: kick off an initial sync if we have a
                        // signed-in session. The reconcile is best-effort —
                        // a thrown error here just means we'll try again on
                        // the next foreground tick. We deliberately don't
                        // surface the error in UI yet (slice C will add a
                        // "last synced" indicator).
                        if container.auth.currentUser() != nil {
                            try? await container.syncEngine.reconcile()
                        }
                        didBootstrap = true
                    }
                }
        }
    }
}
