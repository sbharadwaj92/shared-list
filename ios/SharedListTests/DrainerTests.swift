import Foundation
import SwiftData
import Testing
@testable import SharedList

// Drainer unit tests for slice C.3.
//
// We script the network at the HTTP layer (MockSession from APIClientTests)
// rather than booting a real backend. The wire contract is already pinned
// by the backend's slice-C.1 integration tests; the iOS unit tests focus
// on what the iOS Drainer DOES with each response shape:
//
//   1. Serial drain: rows process in createdAt order; one in-flight at a
//      time; tick() returns when the queue is empty.
//   2. 2xx removes the queue row.
//   3. 409 on PATCH triggers a targeted reconcile (LWW upsert of the
//      `latest` row) followed by a single retry with the merged
//      `If-Match`.
//   4. Repeated 409 (second attempt also conflicts) marks the row failed
//      with a `concurrent edits, manual resolution needed` reason.
//   5. 404 on PATCH/DELETE removes the queue row (idempotent shape — the
//      resource is already gone; nothing to retry).
//   6. 5xx and network errors re-queue the row at `pending` with
//      `retryCount` incremented; `lastError` populated.
//   7. 403 marks failed (membership lost; a future reconcile will sweep).
//   8. 409 on POST (id collision with tombstone) marks failed.
//   9. Stale `inFlight` rows from a prior crash are reset to `pending`
//      on Drainer init.
//  10. Offline kick is a no-op.
//
// The integration test (env-gated `BACKEND_URL`) lives in a separate file
// and exercises the full real-network cycle.

@Suite("Drainer")
@MainActor
struct DrainerTests {

    // MARK: - 1. Serial drain in createdAt order

    @Test func drainsAllPendingRowsInCreatedAtOrder() async throws {
        let env = try await makeEnvironment()
        // Three queued list-creates; oldest first by createdAt.
        let id1 = try env.mutator.createList(name: "first")
        env.clock.advance(by: 1)
        let id2 = try env.mutator.createList(name: "second")
        env.clock.advance(by: 1)
        let id3 = try env.mutator.createList(name: "third")

        // Each create POST returns 201.
        for _ in 0..<3 {
            env.session.enqueue(path: "/lists", response: .success(emptyJSON()))
        }

        await env.drainer.tick()

        // All three queue rows are gone.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)

        // Three POSTs landed in the right order — assert by request body
        // ids since MockSession records every request.
        let recorded = await env.session.requests
        #expect(recorded.count == 3)
        let bodyIds = recorded.compactMap { req -> String? in
            guard let body = req.httpBody,
                  let payload = try? JSONDecoder().decode(CreateListPayload.self, from: body) else {
                return nil
            }
            return payload.id
        }
        #expect(bodyIds == [id1, id2, id3])
    }

    // MARK: - 2. 2xx removes the row (covered above) — explicit assertion

    @Test func successOn200RemovesTheRow() async throws {
        let env = try await makeEnvironment()
        // Pre-seed an existing list so renameList finds the local row.
        let priorUpdated = Date(timeIntervalSince1970: 100)
        env.context.insert(ListModel(
            id: "L1", name: "before", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "after")
        env.session.enqueue(path: "/lists/L1", response: .success(listDtoJSON(
            id: "L1", name: "after", updatedAt: env.clock.now()
        )))

        await env.drainer.tick()

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
    }

    // MARK: - 3. 409 on PATCH → reconcile + retry

    @Test func patch409RetriesOnceWithMergedIfMatch() async throws {
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "v1", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        // Local rename → queues a renameList entry with ifMatch=priorUpdated.
        try env.mutator.renameList(id: "L1", newName: "local-rename")

        // Server already had a competing edit; first PATCH returns 409 with
        // its current state in `latest`. Server's updatedAt is newer than
        // ours so SyncEngine.upsertListLWW will overwrite local on the
        // reconcile step.
        let serverUpdated = env.clock.now().addingTimeInterval(60)
        let conflictEnvelope = conflictBodyJSON(latest: listDtoBody(
            id: "L1", name: "server-edit", updatedAt: serverUpdated
        ))
        env.session.enqueue(path: "/lists/L1", response: .failure(status: 409, body: conflictEnvelope))

        // The drainer's retry sends the merged local state back; server
        // accepts at 200.
        let retryResponse = listDtoJSON(id: "L1", name: "server-edit", updatedAt: serverUpdated)
        env.session.enqueue(path: "/lists/L1", response: .success(retryResponse))

        await env.drainer.tick()

        // Two PATCH requests landed; the second carries the merged
        // ifMatch (= server's updatedAt from the 409 body).
        let recorded = await env.session.requests
        #expect(recorded.count == 2)
        #expect(recorded[1].value(forHTTPHeaderField: "If-Match") == serverUpdated.iso8601MillisString())

        // Queue row is gone (success on retry).
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)

        // Local list now reflects the LWW winner (server's name + updatedAt
        // since serverUpdated > local).
        let row = try env.context.fetch(FetchDescriptor<ListModel>()).first
        #expect(row?.name == "server-edit")
        #expect(row?.updatedAt == serverUpdated)
    }

    // MARK: - 4. Repeated 409 marks failed

    @Test func patchSecondConflictMarksFailed() async throws {
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "v1", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "local-rename")

        let serverUpdated1 = env.clock.now().addingTimeInterval(60)
        env.session.enqueue(path: "/lists/L1", response: .failure(
            status: 409,
            body: conflictBodyJSON(latest: listDtoBody(id: "L1", name: "server-1", updatedAt: serverUpdated1))
        ))
        // Second attempt also conflicts — meaning yet another device wrote
        // between our reconcile and our retry. PLAN.md L195's LWW
        // strategy doesn't try to merge; we surface as failed.
        let serverUpdated2 = serverUpdated1.addingTimeInterval(60)
        env.session.enqueue(path: "/lists/L1", response: .failure(
            status: 409,
            body: conflictBodyJSON(latest: listDtoBody(id: "L1", name: "server-2", updatedAt: serverUpdated2))
        ))

        await env.drainer.tick()

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.count == 1)
        #expect(queue.first?.status == MutationStatus.failed.rawValue)
        #expect(queue.first?.lastError?.contains("concurrent edits") == true)
    }

    // MARK: - 5. 404 on PATCH removes the row (server resource gone)

    @Test func patch404RemovesQueueRow() async throws {
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "before", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "after")
        env.session.enqueue(path: "/lists/L1", response: .failure(
            status: 404,
            body: errorJSON(code: "http_exception", message: "not found")
        ))

        await env.drainer.tick()

        // Row is gone — the next reconcile will sweep the local list via
        // the ?since= tombstone feed; no point retrying.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
    }

    // MARK: - 5b. 404 on DELETE removes the row (idempotent)

    @Test func delete404IsTreatedAsSuccess() async throws {
        let env = try await makeEnvironment()
        env.context.insert(ListModel(
            id: "L1", name: "doomed", createdBy: "u",
            createdAt: Date(), updatedAt: Date(), deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.deleteList(id: "L1")
        env.session.enqueue(path: "/lists/L1", response: .failure(
            status: 404,
            body: errorJSON(code: "http_exception", message: "already deleted")
        ))

        await env.drainer.tick()

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
    }

    // MARK: - 6. 5xx re-queues with retryCount++

    @Test func server5xxRequeuesWithRetryCountIncremented() async throws {
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "before", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "after")
        env.session.enqueue(path: "/lists/L1", response: .failure(
            status: 503,
            body: errorJSON(code: "internal_server_error", message: "down")
        ))

        await env.drainer.tick()

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.count == 1)
        #expect(queue.first?.status == MutationStatus.pending.rawValue)
        #expect(queue.first?.retryCount == 1)
        #expect(queue.first?.lastError?.contains("503") == true)
    }

    // MARK: - 7. 403 marks failed

    @Test func threeOhThreeMarksFailed() async throws {
        let env = try await makeEnvironment()
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "before", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "after")
        env.session.enqueue(path: "/lists/L1", response: .failure(
            status: 403,
            body: errorJSON(code: "http_exception", message: "not a member")
        ))

        await env.drainer.tick()

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.first?.status == MutationStatus.failed.rawValue)
        #expect(queue.first?.lastError?.contains("membership lost") == true)
    }

    // MARK: - 8. 409 on POST id-with-tombstone marks failed

    @Test func createListConflictWithTombstoneMarksFailed() async throws {
        let env = try await makeEnvironment()
        try env.mutator.createList(name: "Groceries")

        env.session.enqueue(path: "/lists", response: .failure(
            status: 409,
            body: errorJSON(code: "http_exception", message: "id collides with deleted list")
        ))

        await env.drainer.tick()

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.count == 1)
        #expect(queue.first?.status == MutationStatus.failed.rawValue)
        #expect(queue.first?.lastError?.contains("deleted list") == true)
    }

    // MARK: - 9. Stale inFlight reset on init

    @Test func resetStaleInFlightOnInit() async throws {
        // Bootstrap with a queue row already at `inFlight` (simulating a
        // crash mid-request). The Drainer init should sweep it back to
        // `pending` so the next tick can pick it up.
        let env = try await makeEnvironment(buildDrainer: false)
        env.context.insert(MutationQueueEntry(
            id: "queue-stale",
            opType: MutationOpType.deleteItem.rawValue,
            targetId: "I1",
            payload: try encode(DeleteItemPayload()),
            createdAt: Date(timeIntervalSince1970: 100),
            status: MutationStatus.inFlight.rawValue,
            retryCount: 0,
            lastError: nil
        ))
        try env.context.save()

        // Construct the drainer NOW — this triggers the resetStaleInFlight
        // sweep in init.
        let drainer = Drainer(
            api: env.api,
            container: env.modelContainer,
            monitor: env.monitor,
            syncEngine: env.syncEngine
        )
        _ = drainer  // silence unused-warning; constructor side effect is what we test

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.first?.status == MutationStatus.pending.rawValue)
    }

    // MARK: - 10. Offline kick is a no-op

    @Test func offlineKickIsNoop() async throws {
        let env = try await makeEnvironment(isOnline: false)
        try env.mutator.createList(name: "x")
        // Don't enqueue any responses — if the drainer tries to network
        // while offline, MockSession.unscriptedRequest will throw.
        env.drainer.kick()
        // Give the (no-op) Task a chance to schedule.
        try await Task.sleep(for: .milliseconds(20))

        let recorded = await env.session.requests
        #expect(recorded.isEmpty)

        // Queue row is still pending — drainer didn't touch it.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.first?.status == MutationStatus.pending.rawValue)
    }
}

// MARK: - Test fixtures

@MainActor
private struct DrainerTestEnvironment {
    let drainer: Drainer
    let mutator: Mutator
    let api: APIClient
    let session: MockSession
    let monitor: MockNetworkMonitor
    let modelContainer: ModelContainer
    let context: ModelContext
    let clock: AdvancingClock
    let syncEngine: SyncEngine
}

@MainActor
private func makeEnvironment(
    isOnline: Bool = true,
    buildDrainer: Bool = true
) async throws -> DrainerTestEnvironment {
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
    let clock = AdvancingClock(start: Date(timeIntervalSince1970: 9_999))
    let uuids = SequenceUUIDGenerator(values: (0..<200).map { "uuid-\($0)" })
    let mutator = Mutator(container: container, clock: clock, uuidGenerator: uuids)

    let drainer: Drainer
    if buildDrainer {
        drainer = Drainer(api: api, container: container, monitor: monitor, syncEngine: syncEngine)
        mutator.attachDrainer(drainer)
    } else {
        // Some tests want to construct the Drainer themselves later (to
        // exercise init-time behavior). Hand back a stub one we won't
        // use; the test will build the real one.
        drainer = Drainer(api: api, container: container, monitor: monitor, syncEngine: syncEngine)
    }

    return DrainerTestEnvironment(
        drainer: drainer,
        mutator: mutator,
        api: api,
        session: session,
        monitor: monitor,
        modelContainer: container,
        context: container.mainContext,
        clock: clock,
        syncEngine: syncEngine
    )
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

/// Clock that defaults to a fixed instant but lets tests advance time
/// between Mutator calls so distinct queue rows have monotonically
/// increasing `createdAt` values (the drainer picks oldest-first).
private final class AdvancingClock: Clock, @unchecked Sendable {
    private(set) var fixed: Date
    init(start: Date) { self.fixed = start }
    func now() -> Date { fixed }
    func advance(by seconds: TimeInterval) { fixed = fixed.addingTimeInterval(seconds) }
}

/// Same SequenceUUIDGenerator pattern as MutatorTests — pre-scripted ids
/// so tests assert on exact values without coupling to v4 randomness.
private final class SequenceUUIDGenerator: UUIDGenerating, @unchecked Sendable {
    private var values: [String]
    init(values: [String]) { self.values = values }
    func newUUID() -> String {
        guard !values.isEmpty else {
            fatalError("SequenceUUIDGenerator exhausted — script more ids in the test")
        }
        return values.removeFirst()
    }
}

// MARK: - JSON helpers

private func emptyJSON() -> Data {
    Data("{}".utf8)
}

private func encode<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(value)
    return String(data: data, encoding: .utf8)!
}

/// Build a fully-populated ListDTO JSON body matching what slice C.1's
/// PATCH /lists/:id returns at 200. Tests pass updatedAt explicitly so
/// the assertion side can compare to a known value.
private func listDtoJSON(id: String, name: String, updatedAt: Date) -> Data {
    let dto = listDtoBody(id: id, name: name, updatedAt: updatedAt)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return try! encoder.encode(dto)
}

private func listDtoBody(id: String, name: String, updatedAt: Date) -> ListDTO {
    ListDTO(
        id: id,
        name: name,
        createdBy: "user-1",
        createdAt: updatedAt.addingTimeInterval(-3600),
        updatedAt: updatedAt,
        deletedAt: nil
    )
}

/// 409 conflict envelope: `{error: {...}, latest: …DTO}` shape.
private func conflictBodyJSON(latest: ListDTO) -> Data {
    struct Envelope<T: Encodable>: Encodable {
        let error: ErrorBody
        let latest: T
    }
    struct ErrorBody: Encodable {
        let code: String
        let message: String
        let requestId: String
    }
    let env = Envelope(
        error: ErrorBody(code: "precondition_failed", message: "If-Match mismatch", requestId: "req-1"),
        latest: latest
    )
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return try! encoder.encode(env)
}

/// Standard error envelope for non-conflict failures (404 / 403 / 5xx).
private func errorJSON(code: String, message: String) -> Data {
    let body = """
    {"error":{"code":"\(code)","message":"\(message)","requestId":"req-1"}}
    """
    return Data(body.utf8)
}
