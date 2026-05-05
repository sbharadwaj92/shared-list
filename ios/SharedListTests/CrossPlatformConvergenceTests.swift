import Foundation
import SwiftData
import Testing
@testable import SharedList

// Cross-platform sync convergence tests — Phase 9.
//
// Each test in this suite plays ONE role (act or observe) in ONE scenario.
// The shell harness `scripts/cross-platform-sync.sh` orchestrates the
// pairing: it invokes this suite once with role=A on iOS (or Android),
// then captures the resulting list/item ids from stdout, then invokes
// the role=B counterpart on the opposite platform. By running each role
// as its own process the suite exercises real cold-start behavior on
// both ends — token storage, container init, network monitor wiring —
// every scenario.
//
// Why this shape (vs. one-test-runs-both-roles-in-one-process):
//   - PLAN.md L386 calls for "two devices' sync engines provably
//     converge." Two devices means two processes — a single in-process
//     A+B run can't catch a scheduler difference between platforms or
//     a wire-encoding asymmetry that only manifests after one platform
//     decodes what the other encoded.
//   - Same-process A+B would let us cheat with shared in-memory state.
//     The split-process shape forces every scenario to ride the
//     backend's HTTP API as the only source of shared truth, which is
//     exactly what production use looks like.
//   - The downside is shell-level coordination: the harness has to
//     carry list ids forward between processes via env vars + stdout
//     parsing. We accept that — same trade we made for iOS ↔ Bun
//     handoff in slice C.3 integration tests.
//
// Same-user, two-device pattern:
//   - PLAN.md L386's four scenarios don't require *different* users —
//     they require two devices. We sign up one user at harness start
//     and `login` from a separate APIClient/TokenStore pair per role
//     to get an independent session per device. Multi-user / sharing-
//     flow testing belongs to Phase 15 where the invite/accept routes
//     land.
//
// Env vars (all required; tests skip silently if any is missing):
//   - BACKEND_URL              — backend root, e.g. http://localhost:3000
//   - CROSS_PLATFORM_USER_EMAIL — user signed up by the harness
//   - CROSS_PLATFORM_USER_PASSWORD — password for that user
//   - CROSS_PLATFORM_ROLE       — "A" or "B"
//   - CROSS_PLATFORM_LIST_ID    — present on observer steps to point at
//                                 the list the actor created in a prior
//                                 step. Empty on initial creation steps.
//   - CROSS_PLATFORM_ITEM_ID    — analogous for item-level scenarios.
//
// stdout protocol:
//   Each test prints "CROSS_PLATFORM_RESULT[<key>]=<value>" lines that
//   the harness greps. Keys: LIST_ID, ITEM_ID, OBSERVED_NAME,
//   OBSERVED_PRESENT, OBSERVED_DELETED. The format is parser-friendly
//   and noise-tolerant (the test runner emits plenty of other lines).

@Suite("CrossPlatformConvergence")
@MainActor
struct CrossPlatformConvergenceTests {

    // MARK: - Setup helper (used by harness to seed scenarios B, C, D
    // with their own fresh list so they don't interfere with each other's
    // state on the backend)

    @Test func setup_seedFreshList() async throws {
        // Special harness invocation: role can be "A" or "B" — whichever
        // platform the harness picked to do the seeding for the next
        // scenario. The seed step is not a sync verification; it only
        // ensures the next scenario starts from a known state.
        guard let env = try await makeEnvironmentOrSkip(expectedRole: anyRole()) else { return }
        let name = "seed-\(env.runId)"
        let id = try env.mutator.createList(name: name)
        await env.drainer.tick()
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty, "expected queue empty after seed drain, got \(queue.count)")
        printResult(key: "LIST_ID", value: id)
        printResult(key: "LIST_NAME", value: name)
    }

    // MARK: - Scenario (a): A creates → B sees after ?since=

    @Test func scenarioA_creatorCreatesList() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "A") else { return }
        let name = "scenario-a-\(env.runId)"
        let id = try env.mutator.createList(name: name)
        try await drainAndAssertEmpty(env: env)
        printResult(key: "LIST_ID", value: id)
        printResult(key: "LIST_NAME", value: name)
    }

    @Test func scenarioA_observerSeesList() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "B") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")

        try await env.syncEngine.reconcile()

        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        let observed = lists.first { $0.id == listId }
        #expect(observed != nil, "expected list \(listId) after reconcile, found \(lists.count) total")
        if let observed {
            printResult(key: "OBSERVED_NAME", value: observed.name)
            printResult(key: "OBSERVED_PRESENT", value: "true")
        } else {
            printResult(key: "OBSERVED_PRESENT", value: "false")
        }
    }

    // MARK: - Scenario (b): A offline-mutates → reconnects → B sees result

    @Test func scenarioB_creatorMutatesOfflineThenReconnects() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "A") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")

        // Make the existing list visible locally so the rename has a
        // target. Without this initial reconcile the Mutator would no-op
        // (findActiveList returns nil for an unknown id).
        try await env.syncEngine.reconcile()

        // Go offline. The Mutator enqueues the rename but the drainer
        // can't send anything yet.
        env.monitor.isOnline = false
        let newName = "scenario-b-renamed-\(env.runId)"
        try env.mutator.renameList(id: listId, newName: newName)

        // Drainer kick is a no-op while offline — confirm the queue
        // still holds the rename.
        env.drainer.kick()
        try await Task.sleep(for: .milliseconds(50))
        let queueOffline = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queueOffline.count == 1, "expected 1 queued mutation while offline, got \(queueOffline.count)")

        // Reconnect; explicit tick so we don't race the kick.
        env.monitor.isOnline = true
        await env.drainer.tick()

        let queueDrained = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queueDrained.isEmpty, "expected queue empty after reconnect-drain, got \(queueDrained.count)")

        printResult(key: "LIST_ID", value: listId)
        printResult(key: "RENAMED_TO", value: newName)
    }

    @Test func scenarioB_observerSeesRename() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "B") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")
        let expectedName = try requireEnv("CROSS_PLATFORM_EXPECTED_NAME")

        try await env.syncEngine.reconcile()

        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        let observed = lists.first { $0.id == listId }
        #expect(observed?.name == expectedName,
                "expected list \(listId) to read as '\(expectedName)', got '\(observed?.name ?? "<missing>")'")
        printResult(key: "OBSERVED_NAME", value: observed?.name ?? "")
    }

    // MARK: - Scenario (c): concurrent edits resolve LWW consistently

    @Test func scenarioC_creatorEditsThenDrains() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "A") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")

        try await env.syncEngine.reconcile()

        // The actor renames the list and immediately drains. The harness
        // invokes B with the same starting state (a separate process,
        // separate APIClient, separate local store) which races against
        // this rename's serverside `updated_at`. Because both A and B
        // captured the same prior `updatedAt` (their respective initial
        // reconcile fetched the same row), they both send If-Match against
        // the SAME cursor — one will land 200, the other 409. Whichever
        // wins, both eventually-converge on the same name after their
        // post-409 reconcile + retry-once cycle.
        let nameFromA = "scenario-c-from-A-\(env.runId)"
        try env.mutator.renameList(id: listId, newName: nameFromA)
        await env.drainer.tick()

        // After the drain, our local row may be either the A-name (if we
        // won) or the B-name (if we lost the 409 race and the retry-once
        // path applied the server's latest). Both are consistent — we
        // just need both PROCESSES (this one and the B counterpart) to
        // see the same end state after their final reconcile.
        try await env.syncEngine.reconcile()
        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        let observed = lists.first { $0.id == listId }
        printResult(key: "LIST_ID", value: listId)
        printResult(key: "FINAL_NAME", value: observed?.name ?? "")
    }

    @Test func scenarioC_observerEditsThenDrains() async throws {
        // Same shape as the creator side — different name, same flow.
        // Both processes run sequentially (act first, then this one);
        // because both started from the same seeded list and pre-staged
        // their If-Match against the same `updatedAt`, this one will
        // hit a 409 → reconcile → retry-once cycle. Final state on the
        // server is "scenario-c-from-B-..." (this process's value).
        // The harness's `scenarioC_reconcileOnly` step runs on the act
        // platform AFTER this method to confirm both end up with the
        // same name post-final-reconcile.
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "B") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")

        try await env.syncEngine.reconcile()

        let nameFromB = "scenario-c-from-B-\(env.runId)"
        try env.mutator.renameList(id: listId, newName: nameFromB)
        await env.drainer.tick()

        try await env.syncEngine.reconcile()
        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        let observed = lists.first { $0.id == listId }
        printResult(key: "LIST_ID", value: listId)
        printResult(key: "FINAL_NAME", value: observed?.name ?? "")
    }

    /// Reconcile-only step the harness invokes on the act platform
    /// AFTER the observer ran its rename. Refreshes the local row to
    /// the latest serverside name without performing any new mutation.
    /// The harness asserts FINAL_NAME from this run matches the
    /// observer's FINAL_NAME — that's the cross-platform convergence
    /// invariant (both devices end up with the same row).
    @Test func scenarioC_reconcileOnly() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: anyRole()) else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")

        try await env.syncEngine.reconcile()
        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        let observed = lists.first { $0.id == listId }
        printResult(key: "LIST_ID", value: listId)
        printResult(key: "FINAL_NAME", value: observed?.name ?? "")
    }

    // MARK: - Scenario (d): tombstones flow during 90-day window

    @Test func scenarioD_creatorAddsThenDeletesItem() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "A") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")

        try await env.syncEngine.reconcile()

        // Two-step act: create an item (so B has something to observe
        // disappear), then delete it. Drain after each so the server
        // serializes the operations into the items feed in a known
        // order. The deletion's tombstone is what scenario (d)
        // verifies — that B's `?since=` pull surfaces the tombstoned
        // item and the read-side reconciler's deleteLocalItem path
        // removes B's local row.
        let itemId = try env.mutator.createItem(listId: listId, text: "scenario-d item")
        await env.drainer.tick()

        try env.mutator.deleteItem(id: itemId)
        await env.drainer.tick()

        let queueAfter = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queueAfter.isEmpty, "expected queue empty after both drains")

        printResult(key: "ITEM_ID", value: itemId)
    }

    @Test func scenarioD_observerSeesTombstone() async throws {
        guard let env = try await makeEnvironmentOrSkip(expectedRole: "B") else { return }
        let listId = try requireEnv("CROSS_PLATFORM_LIST_ID")
        let itemId = try requireEnv("CROSS_PLATFORM_ITEM_ID")

        try await env.syncEngine.reconcile()

        // The deletion happened on A's side. The read-side reconciler's
        // contract for tombstones (see SyncEngine.reconcileItems) is
        // "delete the local row entirely" — NOT "upsert with deletedAt
        // set." So the correct assertion is that no local row exists for
        // this id after reconcile. This holds whether or not B had a
        // local row before:
        //   - If B never saw the item (this scenario): nothing was ever
        //     inserted; reconcile sees the tombstoned wire row and the
        //     deleteLocalItem path is a no-op. End state: no row.
        //   - If B had a local active row: reconcile sees the tombstone
        //     and removes it. End state: no row.
        let items = try env.context.fetch(FetchDescriptor<ItemModel>(
            predicate: #Predicate<ItemModel> { $0.id == itemId }
        ))
        #expect(items.isEmpty, "expected no local row for tombstoned item \(itemId), found \(items.count)")

        // Also assert the list is still around — only the item was deleted,
        // not the parent list.
        let lists = try env.context.fetch(FetchDescriptor<ListModel>(
            predicate: #Predicate<ListModel> { $0.id == listId && $0.deletedAt == nil }
        ))
        #expect(!lists.isEmpty, "expected parent list to still exist after item delete")

        printResult(key: "OBSERVED_DELETED", value: items.isEmpty ? "true" : "false")
    }
}

// MARK: - Test fixtures

@MainActor
private struct ConvergenceEnvironment {
    let mutator: Mutator
    let drainer: Drainer
    let syncEngine: SyncEngine
    let monitor: MockNetworkMonitor
    let modelContainer: ModelContainer
    let context: ModelContext
    /// Per-process unique suffix so log/list/item names are
    /// disambiguable across iOS-A and iOS-B (or in mixed-platform
    /// runs) when greping the harness output.
    let runId: String
}

/// Sentinel for the seed-only test that doesn't care which role the
/// harness assigned. The harness sets CROSS_PLATFORM_ROLE to either
/// "A" or "B" depending on which platform is doing the seed; we accept
/// either.
private let SEED_ANY_ROLE = "*"

@MainActor
private func anyRole() -> String { SEED_ANY_ROLE }

@MainActor
private func makeEnvironmentOrSkip(expectedRole: String) async throws -> ConvergenceEnvironment? {
    guard let backendURL = backendURLFromEnv() else {
        // Same skip pattern as DrainerIntegrationTests — return nil so
        // the test body's `guard ... else { return }` makes the test
        // pass-with-nothing on a plain `xcodebuild test` invocation.
        // The harness invocation always exports BACKEND_URL.
        return nil
    }
    guard let role = ProcessInfo.processInfo.environment["CROSS_PLATFORM_ROLE"] else {
        return nil
    }
    // Each test is single-role; if the harness invoked the wrong test
    // for the role it set, that's a harness bug worth surfacing as a
    // test pass-with-nothing rather than a misleading failure. The role
    // mismatch shows up in the harness's expected-output assertions.
    // SEED_ANY_ROLE is the seed-step exception — it accepts whichever
    // role the harness assigned.
    guard expectedRole == SEED_ANY_ROLE || role == expectedRole else {
        return nil
    }
    return try await makeEnvironment(backendURL: backendURL, role: role)
}

@MainActor
private func makeEnvironment(backendURL: URL, role: String) async throws -> ConvergenceEnvironment {
    let email = try requireEnv("CROSS_PLATFORM_USER_EMAIL")
    let password = try requireEnv("CROSS_PLATFORM_USER_PASSWORD")

    // Fresh in-memory keychain + token store per process — this is
    // the "two devices" property. Even though both processes log in
    // as the same user, they hold independent access/refresh tokens
    // and independent local SwiftData stores.
    let store = TokenStore(keychain: InMemoryKeychainStore())
    let api = APIClient(baseURL: backendURL, tokenStore: store)
    let monitor = MockNetworkMonitor(isOnline: true)
    let container = inMemoryContainer()
    let auth = AuthService(api: api, tokenStore: store)
    let syncEngine = SyncEngine(
        api: api,
        container: container,
        monitor: monitor,
        currentUserId: { [weak store] in store?.current?.user.id }
    )
    let mutator = Mutator(container: container)
    let drainer = Drainer(api: api, container: container, monitor: monitor, syncEngine: syncEngine)
    mutator.attachDrainer(drainer)

    // Log in to get a session. The harness signs the user up once at
    // start; every test process hits /auth/login afterwards. The
    // generous login limit (PLAN.md L81: 30/min/IP) keeps the
    // 8-process Phase 9 run comfortably under the bucket.
    _ = try await auth.login(email: email, password: password)

    return ConvergenceEnvironment(
        mutator: mutator,
        drainer: drainer,
        syncEngine: syncEngine,
        monitor: monitor,
        modelContainer: container,
        context: container.mainContext,
        runId: "\(role)-\(ProcessInfo.processInfo.processIdentifier)"
    )
}

@MainActor
private func inMemoryContainer() -> ModelContainer {
    let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
    do {
        return try ModelContainer(
            for: UserModel.self,
            ListModel.self,
            ItemModel.self,
            MemberModel.self,
            SyncCursor.self,
            MutationQueueEntry.self,
            configurations: configuration
        )
    } catch {
        fatalError("test ModelContainer init failed: \(error)")
    }
}

private func backendURLFromEnv() -> URL? {
    guard let raw = ProcessInfo.processInfo.environment["BACKEND_URL"],
          let url = URL(string: raw) else {
        return nil
    }
    return url
}

private func requireEnv(_ name: String) throws -> String {
    guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else {
        throw ConvergenceEnvError.missingEnv(name)
    }
    return value
}

@MainActor
private func drainAndAssertEmpty(env: ConvergenceEnvironment) async throws {
    await env.drainer.tick()
    let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
    #expect(queue.isEmpty, "expected queue empty after drain, got \(queue.count)")
}

private enum ConvergenceEnvError: Error, CustomStringConvertible {
    case missingEnv(String)

    var description: String {
        switch self {
        case .missingEnv(let name): return "missing required env var \(name)"
        }
    }
}

/// Print a structured RESULT line the shell harness greps for. Keep the
/// format simple: harness uses `grep -oE "CROSS_PLATFORM_RESULT\[KEY\]=.*"`
/// then strips the prefix.
private func printResult(key: String, value: String) {
    print("CROSS_PLATFORM_RESULT[\(key)]=\(value)")
}
