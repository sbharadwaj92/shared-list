import Foundation
import Network

// NetworkMonitor — proactive online/offline awareness for the sync engine.
//
// Why proactive: the sync drainer (slice C) needs to know whether to even
// attempt a request. A reactive approach (just try, fail with .notConnected)
// burns power, generates spurious error logs, and confuses the retry path.
// Apple's Network framework solves this via `NWPathMonitor`, which delivers
// path updates whenever the OS observes a connectivity change — Wi-Fi drop,
// cellular handover, airplane mode toggle, even VPN flap.
//
// Why @Observable instead of a Combine publisher / async stream: views and
// the SyncEngine both want to consume the value. SwiftUI's @Observable macro
// gives us tracking-by-keypath for free; SyncEngine reads `isOnline` directly
// and SwiftUI views can `if monitor.isOnline { ... }` without any additional
// glue. PLAN.md L202 picks NWPathMonitor for exactly this reason.
//
// Actor model: NWPathMonitor delivers callbacks on a private dispatch queue.
// We bounce the result onto @MainActor before mutating `isOnline` so SwiftUI
// observation happens on the right actor. This is the same pattern Apple's
// own sample code uses for connectivity-watching Observable types.
//
// Test seam: `NetworkMonitoring` protocol with a `MockNetworkMonitor` impl
// for tests. The real impl uses NWPathMonitor; the mock just exposes a
// settable `isOnline`. Slice B tests use the mock so we don't have to wait
// on real network state in CI.

@MainActor
public protocol NetworkMonitoring: AnyObject {
    var isOnline: Bool { get }
}

@MainActor
@Observable
public final class NetworkMonitor: NetworkMonitoring {
    /// `true` when the OS reports an unrestricted, satisfied path. We only
    /// gate sync on the binary "any path / no path" question — distinguishing
    /// Wi-Fi vs. cellular isn't worth the complexity for v1 (the user is on
    /// the same LAN as the backend either way). Slice C may revisit if we
    /// add cost-aware behavior on cellular.
    public private(set) var isOnline: Bool = false

    /// Pure-Swift path monitor. We hold a reference for the lifetime of the
    /// AppContainer; `start(queue:)` activates it, and the OS keeps delivering
    /// updates until `cancel()` is called. We don't currently call `cancel()`
    /// — the monitor is meant to live for the app's lifetime.
    nonisolated(unsafe) private let monitor = NWPathMonitor()

    /// Private dispatch queue for path callbacks. Apple's docs require we
    /// pass *some* queue; using a dedicated one avoids contention with
    /// arbitrary user-visible work on the main queue.
    nonisolated(unsafe) private let queue = DispatchQueue(label: "in.santosh-bharadwaj.sharedlist.network-monitor")

    public init() {
        // Capture self weakly so the closure doesn't keep us alive past the
        // AppContainer (defensive — the AppContainer outlives the app process,
        // so practically this is never collected, but the lint pattern is
        // worth modeling for slice-C contributors copying this layout).
        monitor.pathUpdateHandler = { [weak self] path in
            // Path callbacks land on `queue`; bounce to MainActor before
            // mutating @Observable state so SwiftUI's tracking sees the
            // change on the actor it cares about.
            Task { @MainActor [weak self] in
                self?.isOnline = (path.status == .satisfied)
            }
        }
        monitor.start(queue: queue)
    }
}

/// Test double — the SyncEngine reads only `isOnline`, so a tiny class with a
/// settable property is enough to script offline/online transitions in tests.
/// Marked `@MainActor` to match the protocol; `@Observable` so SwiftUI usage
/// in previews works the same way the real type does.
@MainActor
@Observable
public final class MockNetworkMonitor: NetworkMonitoring {
    public var isOnline: Bool

    public init(isOnline: Bool = true) {
        self.isOnline = isOnline
    }
}
