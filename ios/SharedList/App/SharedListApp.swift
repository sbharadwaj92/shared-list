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
    @Environment(\.scenePhase) private var scenePhase

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
                        // the next foreground tick.
                        if container.auth.currentUser() != nil {
                            try? await container.syncEngine.reconcile()
                            // Slice C.3: kick the drainer too in case any
                            // queued mutations from a prior session are
                            // still pending (force-quit before drain
                            // completed, then relaunch).
                            container.drainer.kick()
                        }
                        didBootstrap = true
                    }
                }
                // Slice C.3 trigger: when NetworkMonitor reports we just
                // came online, kick the drainer. Any rows queued while
                // offline drain immediately. We use the @Observable
                // tracking via the bridge `isOnline` property — SwiftUI
                // re-runs the closure on every change.
                .onChange(of: container.networkMonitor.isOnline) { _, isOnline in
                    if isOnline {
                        container.drainer.kick()
                    }
                }
                // Slice C.3 trigger: foreground. The same trigger surface
                // SyncEngine reconciliation uses (Phase 18 will revisit if
                // we want both reconcile + drain in one foreground hop).
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active && container.auth.currentUser() != nil {
                        Task { @MainActor in
                            try? await container.syncEngine.reconcile()
                            container.drainer.kick()
                        }
                    }
                }
        }
    }
}
