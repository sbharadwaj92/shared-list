import Foundation
import SwiftData
import Testing
@testable import SharedList

// Tombstone + LWW fuzz for the sync engine — slice D.
//
// PLAN.md L231 lists the hostile scenarios Phase 7 should converge under:
// rapid create-delete-create, simultaneous edits, edits-on-deleted,
// lists-deleted-while-editing. We don't need 100% — pick the cases that
// exercise the most LWW and tombstone interactions and prove the cycle
// holds.
//
// All scenarios drive the system through the *public* API surface
// (Mutator → Drainer → SyncEngine) against a scripted MockSession.
// That's deliberate: a fuzz test that pokes internals proves only that
// the internals work the way you wrote them. A fuzz test that goes
// through the public API proves the contract holds end-to-end, which is
// what matters for a future device-pair scenario.
//
// The MockSession is the mock seam, not the SyncEngine — the wire
// contract is already pinned by the backend's slice-C.1 integration
// tests, and the env-gated DrainerIntegrationTests run against the
// real server. These fuzz tests stay deterministic + fast so they can
// guard the CI lane.
//
// Why these four specific scenarios:
//   1. rapid create-delete-create — exercises the queue ordering AND
//      the cascade-during-pending-creates interaction. A tombstoned
//      list with a pending create-item entry would be a nasty
//      end-state to land in.
//   2. simultaneous local edits → drainer sends both → server LWWs.
//      Pins the "Mutator pre-stamps updatedAt at call time + drainer
//      sends each in createdAt order" contract.
//   3. edits-on-deleted (server-side delete while local edit pending)
//      — drainer should treat 404 as success-shape, not crash, not
//      keep retrying.
//   4. list-deleted-while-items-have-pending-mutations — the most
//      load-bearing tombstone scenario. Local cascade tombstones the
//      items immediately (so UI is coherent), server cascades on its
//      end when DELETE /lists hits, and the queued item-PATCHes that
//      were already in-flight become orphans the drainer must retire
//      cleanly via 404.

@Suite("SyncFuzz")
@MainActor
struct SyncFuzzTests {

    // MARK: - 1. Rapid create-delete-create

    @Test func rapidCreateDeleteCreateConverges() async throws {
        // Three create-then-delete cycles back-to-back. Each cycle
        // produces a distinct list id (UUID v4 from SystemUUIDGenerator),
        // and each delete enqueues one DELETE entry. After the drainer
        // ticks the entire batch, the queue should be empty and the
        // local store should reflect the soft-delete of each list.
        let env = try await makeEnvironment()

        var createdIds: [String] = []
        for cycle in 0..<3 {
            let id = try env.mutator.createList(name: "cycle-\(cycle)")
            createdIds.append(id)
            try env.mutator.deleteList(id: id)
        }
        // Six queue entries total: three creates + three deletes,
        // interleaved per cycle. Drainer processes oldest-first.
        let initialQueue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(initialQueue.count == 6)

        // Script the responses in createdAt order: create then delete,
        // three times.
        for _ in 0..<3 {
            env.session.enqueue(path: "/lists", response: .success(emptyJSON()))
        }
        // The MockSession matches by path; create + delete share
        // /lists vs /lists/<id>. Per-cycle we need the right delete
        // response keyed to the list id we got back.
        for id in createdIds {
            env.session.enqueue(path: "/lists/\(id)", response: .failure(status: 204, body: Data()))
        }

        await env.drainer.tick()

        // All six queue entries gone.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty, "expected queue empty after rapid create-delete-create, found \(queue.count)")

        // Local state: every list is tombstoned (soft-deleted).
        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        #expect(lists.count == 3)
        for row in lists {
            #expect(row.deletedAt != nil, "list \(row.id) should be tombstoned")
        }
    }

    // MARK: - 2. Simultaneous local edits drain in order

    @Test func simultaneousLocalEditsDrainInOrder() async throws {
        // Use a deterministic clock that advances between Mutator calls
        // — three rapid renames within the same wall-clock millisecond
        // would all share an `updatedAt`, making the chained If-Match
        // values identical and breaking the LWW assumption that
        // subsequent edits have strictly-greater cursors. The test
        // forces 1ms gaps to model the realistic case where two
        // distinct user actions arrive at distinct millisecond ticks.
        let clock = AdvancingClock(start: Date(timeIntervalSince1970: 9_000))
        let env = try await makeEnvironment(clock: clock)

        // Seed a list locally so renameList finds the row. Pre-stamp
        // updatedAt to the clock's current value so the first
        // rename's ifMatch matches what's on the row.
        env.context.insert(ListModel(
            id: "L1", name: "v0", createdBy: "u",
            createdAt: clock.fixed, updatedAt: clock.fixed, deletedAt: nil
        ))
        try env.context.save()

        // Three rapid renames with explicit 1ms advances BEFORE each
        // call. The advance has to come before call N (not between
        // N and N+1) because each call's `ifMatch` is the row's
        // pre-call updatedAt — if we don't advance first, call N+1
        // reads the same updatedAt that call N's local apply just
        // wrote, and the chained If-Match values collapse. The seeded
        // row sits at `clock.fixed` from setup; advancing once here
        // means call 1's local apply writes a new timestamp distinct
        // from the seed.
        clock.advance(by: 0.001)
        try env.mutator.renameList(id: "L1", newName: "v1")
        clock.advance(by: 0.001)
        try env.mutator.renameList(id: "L1", newName: "v2")
        clock.advance(by: 0.001)
        try env.mutator.renameList(id: "L1", newName: "v3")

        let initialQueue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(initialQueue.count == 3)

        // Server accepts each — happy path. The 200 response carries
        // the updated row (which the drainer just removes; it doesn't
        // re-apply).
        for name in ["v1", "v2", "v3"] {
            env.session.enqueue(
                path: "/lists/L1",
                response: .success(listDtoJSON(id: "L1", name: name, updatedAt: Date()))
            )
        }

        await env.drainer.tick()

        // Queue empty, three PATCHes landed in order.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
        let recorded = await env.session.requests
        #expect(recorded.count == 3, "expected 3 PATCH calls, got \(recorded.count)")

        // Verify the If-Match headers chain correctly: each request's
        // If-Match advances strictly because we forced clock gaps. The
        // chain is the load-bearing invariant for LWW correctness on
        // the wire — without monotonic If-Match values, the second
        // PATCH would 409 even though we sent it from a single
        // device's serialized queue.
        for i in 1..<recorded.count {
            let prev = recorded[i - 1].value(forHTTPHeaderField: "If-Match") ?? ""
            let curr = recorded[i].value(forHTTPHeaderField: "If-Match") ?? ""
            #expect(curr > prev,
                    "If-Match should advance: prev=\(prev), curr=\(curr)")
        }

        // Local row reflects the last rename.
        let row = try env.context.fetch(FetchDescriptor<ListModel>()).first
        #expect(row?.name == "v3")
    }

    // MARK: - 3. Edit-on-deleted: server returns 404 mid-drain

    @Test func editOnServerDeletedRowDrainsCleanly() async throws {
        // Local edit was queued; before the drainer runs, another
        // device deleted the same row. The server's PATCH returns 404.
        // The drainer should remove the queue entry (no point
        // retrying) — the next reconcile's tombstone feed will sweep
        // the local row.
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "before", createdBy: "u",
            createdAt: priorUpdated, updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "after")

        env.session.enqueue(
            path: "/lists/L1",
            response: .failure(status: 404, body: errorJSON(code: "http_exception", message: "not found"))
        )

        await env.drainer.tick()

        // Queue entry gone (404 on PATCH = idempotent shape).
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
        // Local row is still present — the drainer doesn't sweep on
        // 404 (the next /sync/lists pull will). Test the contract,
        // not extra cleanup.
        let row = try env.context.fetch(FetchDescriptor<ListModel>()).first
        #expect(row != nil, "drainer's 404 path leaves local row for the reconciler to sweep")
    }

    // MARK: - 4. List deleted while items have pending mutations

    @Test func listDeletedWhileItemsHavePendingMutationsConverges() async throws {
        // The hardest scenario in the slice-D set. Sequence:
        //   1. List + items present locally.
        //   2. User patches an item (queues item PATCH).
        //   3. User deletes the parent list (cascade tombstones items
        //      locally + queues list DELETE — slice C.2 contract).
        //   4. Drainer runs: the queued item PATCH targets a row whose
        //      server-side parent is about to be deleted; the queued
        //      list DELETE follows.
        //
        // Per createdAt order, the item PATCH drains first (queued at
        // step 2), THEN the list DELETE (queued at step 3). The item
        // PATCH should succeed against the still-live server row; the
        // list DELETE then cascades server-side. End state:
        // queue empty, local items + list all tombstoned.
        //
        // Note this test pins the OPTIMISTIC case where the item
        // PATCH lands BEFORE the list DELETE. The interesting harder
        // case (item PATCH races against an already-deleted server
        // list) is covered by test 3 above. Together they fence in
        // the relevant convergence behavior.
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "shopping", createdBy: "u",
            createdAt: priorUpdated, updatedAt: priorUpdated, deletedAt: nil
        ))
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: nil,
            position: 1, createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        // (2) Patch the item.
        try env.mutator.patchItem(id: "I1", text: "almond milk")
        // (3) Delete the parent list. Local cascade tombstones the
        // item (slice C.2 contract).
        try env.mutator.deleteList(id: "L1")

        // Local state immediately after step 3: list tombstoned, item
        // tombstoned (cascade), 2 queue entries (item PATCH + list
        // DELETE).
        let listAfterCascade = try env.context.fetch(FetchDescriptor<ListModel>()).first
        let itemAfterCascade = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(listAfterCascade?.deletedAt != nil)
        #expect(itemAfterCascade?.deletedAt != nil)
        let queueBefore = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queueBefore.count == 2, "expected item PATCH + list DELETE, got \(queueBefore.count)")

        // Server scripts: PATCH /items/I1 → 200; DELETE /lists/L1 → 204.
        env.session.enqueue(
            path: "/items/I1",
            response: .success(itemDtoJSON(id: "I1", text: "almond milk", listId: "L1", updatedAt: Date()))
        )
        env.session.enqueue(
            path: "/lists/L1",
            response: .failure(status: 204, body: Data())
        )

        await env.drainer.tick()

        // Convergence: queue empty, local rows still tombstoned.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
        let list = try env.context.fetch(FetchDescriptor<ListModel>()).first
        let item = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(list?.deletedAt != nil)
        #expect(item?.deletedAt != nil)
    }
}

// MARK: - Test fixtures
//
// Mirrors DrainerTests' fixtures intentionally — these are the shapes
// that work for the "drive Mutator + Drainer through MockSession"
// pattern. Keeping them in this file (rather than in a shared helper)
// because the fuzz scenarios may eventually want fixtures the unit
// tests don't (e.g., simulated clock skew between Mutator + Drainer).

@MainActor
private struct FuzzEnvironment {
    let drainer: Drainer
    let mutator: Mutator
    let session: MockSession
    let monitor: MockNetworkMonitor
    let modelContainer: ModelContainer
    let context: ModelContext
}

@MainActor
private func makeEnvironment(
    isOnline: Bool = true,
    clock: (any Clock)? = nil
) async throws -> FuzzEnvironment {
    let session = MockSession()
    let store = TokenStore(keychain: InMemoryKeychainStore())
    try await store.save(.init(
        accessToken: "tkn-A",
        refreshToken: "tkn-R",
        user: AuthUser(id: "user-1", email: "test@example.com", displayName: "Test")
    ))
    let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)
    let monitor = MockNetworkMonitor(isOnline: isOnline)
    let container = inMemoryContainer()
    let syncEngine = SyncEngine(
        api: api,
        container: container,
        monitor: monitor,
        currentUserId: { [weak store] in store?.current?.user.id }
    )
    // Default to SystemClock + SystemUUIDGenerator so the rapid-
    // create-delete-create scenario uses real time advancement
    // between calls. Tests that need deterministic chained timestamps
    // (e.g. simultaneousLocalEdits) pass an `AdvancingClock` instead.
    let mutator: Mutator = {
        if let clock {
            return Mutator(container: container, clock: clock)
        }
        return Mutator(container: container)
    }()
    let drainer = Drainer(api: api, container: container, monitor: monitor, syncEngine: syncEngine)
    mutator.attachDrainer(drainer)
    return FuzzEnvironment(
        drainer: drainer,
        mutator: mutator,
        session: session,
        monitor: monitor,
        modelContainer: container,
        context: container.mainContext
    )
}

/// Test clock with explicit `advance(by:)` so timestamp-sensitive fuzz
/// scenarios can model "two distinct user actions arrived at distinct
/// millisecond ticks" without relying on Date.now's wall-clock
/// granularity (which can collapse rapid Mutator calls into the same
/// instant on a fast machine).
private final class AdvancingClock: Clock, @unchecked Sendable {
    private(set) var fixed: Date
    init(start: Date) { self.fixed = start }
    func now() -> Date { fixed }
    func advance(by seconds: TimeInterval) { fixed = fixed.addingTimeInterval(seconds) }
}

private let testBaseURL = URL(string: "https://example.test")!

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

// MARK: - JSON helpers

private func emptyJSON() -> Data { Data("{}".utf8) }

private func listDtoJSON(id: String, name: String, updatedAt: Date) -> Data {
    let dto = ListDTO(
        id: id,
        name: name,
        createdBy: "user-1",
        createdAt: updatedAt.addingTimeInterval(-3600),
        updatedAt: updatedAt,
        deletedAt: nil
    )
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return try! encoder.encode(dto)
}

private func itemDtoJSON(id: String, text: String, listId: String, updatedAt: Date) -> Data {
    let dto = ItemDTO(
        id: id,
        listId: listId,
        text: text,
        checkedAt: nil,
        position: 1,
        createdBy: "user-1",
        createdAt: updatedAt.addingTimeInterval(-3600),
        updatedAt: updatedAt,
        deletedAt: nil
    )
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return try! encoder.encode(dto)
}

private func errorJSON(code: String, message: String) -> Data {
    let body = """
    {"error":{"code":"\(code)","message":"\(message)","requestId":"req-1"}}
    """
    return Data(body.utf8)
}
