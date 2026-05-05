import Foundation
import SwiftData
import Testing
@testable import SharedList

// SyncEngine tests for slice B. Pin the read-side reconciliation contract:
//   1. Reconcile pulls all three feeds in lists → items → members order.
//   2. Active rows are upserted into SwiftData with id-based uniqueness.
//   3. Tombstoned list/item rows delete the local copy.
//   4. Self-revocation (own member row tombstoned) sweeps the list + items
//      + remaining member rows for that list.
//   5. Per-resource cursors persist; the next reconcile passes them as `since`
//      and a stable second pull (no writes between) is empty-batch.
//   6. Offline reconcile is a no-op (no error, no requests).
//   7. Unauthenticated reconcile throws `notAuthenticated`.
//
// We mock at the HTTP layer (MockSession from APIClientTests) rather than
// boot a real backend. The wire shape is already pinned by the backend's
// integration tests (see backend/src/features/sync/integration.test.ts);
// the iOS tests focus on what the iOS engine does with that shape.
//
// The ModelContainer is in-memory per test (`isStoredInMemoryOnly: true`)
// so writes don't bleed across runs and tests are independent.

@Suite("SyncEngine")
@MainActor
struct SyncEngineTests {

    // MARK: - 1. Three-feed reconcile in correct order

    @Test func reconcilePullsAllThreeFeedsInOrder() async throws {
        let session = MockSession()
        // serverTime values are arbitrary but distinct so we can later
        // assert they were each persisted under the right resource cursor.
        session.enqueue(path: "/sync/lists", response: .success(emptyResponse(at: "2026-05-05T12:00:00.001Z")))
        session.enqueue(path: "/sync/items", response: .success(emptyResponse(at: "2026-05-05T12:00:00.002Z")))
        session.enqueue(path: "/sync/list_members", response: .success(emptyResponse(at: "2026-05-05T12:00:00.003Z")))

        let env = try await makeEnvironment(session: session)
        try await env.engine.reconcile()

        let recorded = await session.requests
        #expect(recorded.count == 3)
        // Order matters per `backend/docs/sync.md` reconciliation algorithm:
        // lists land first, items second, members last (so a self-revocation
        // sweep at step 3 happens after item rows have a chance to settle).
        #expect(recorded[0].url?.path == "/sync/lists")
        #expect(recorded[1].url?.path == "/sync/items")
        #expect(recorded[2].url?.path == "/sync/list_members")
    }

    // MARK: - 2. Active row upsert

    @Test func upsertsActiveListsItemsMembers() async throws {
        let session = MockSession()
        session.enqueue(path: "/sync/lists", response: .success(listsResponse(rows: [
            ListDTO(
                id: "L1",
                name: "Groceries",
                createdBy: testUserId,
                createdAt: t(0),
                updatedAt: t(1000),
                deletedAt: nil
            )
        ], serverTime: t(2000))))
        session.enqueue(path: "/sync/items", response: .success(itemsResponse(rows: [
            ItemDTO(
                id: "I1",
                listId: "L1",
                text: "milk",
                checkedAt: nil,
                position: 1,
                createdBy: testUserId,
                createdAt: t(0),
                updatedAt: t(1000),
                deletedAt: nil
            )
        ], serverTime: t(2000))))
        session.enqueue(path: "/sync/list_members", response: .success(membersResponse(rows: [
            ListMemberDTO(
                listId: "L1",
                userId: testUserId,
                role: "owner",
                createdAt: t(0),
                updatedAt: t(1000),
                deletedAt: nil
            )
        ], serverTime: t(2000))))

        let env = try await makeEnvironment(session: session)
        try await env.engine.reconcile()

        let context = env.modelContainer.mainContext
        // Lists: one row, name and id intact.
        let lists = try context.fetch(FetchDescriptor<ListModel>())
        #expect(lists.count == 1)
        #expect(lists.first?.id == "L1")
        #expect(lists.first?.name == "Groceries")
        #expect(lists.first?.deletedAt == nil)

        // Items: one row, listed against the right list.
        let items = try context.fetch(FetchDescriptor<ItemModel>())
        #expect(items.count == 1)
        #expect(items.first?.text == "milk")
        #expect(items.first?.listId == "L1")
        #expect(items.first?.checkedAt == nil)

        // Members: one row, composite id correctly synthesized.
        let members = try context.fetch(FetchDescriptor<MemberModel>())
        #expect(members.count == 1)
        #expect(members.first?.compositeId == "L1|\(testUserId)")
        #expect(members.first?.role == "owner")
    }

    // MARK: - 3. Tombstones delete locally

    @Test func tombstonedListRemovesLocalCopy() async throws {
        // Seed local state, then run a reconcile that returns a tombstone
        // for the same list. The local row must be gone after.
        let env = try await makeEnvironment(session: MockSession())
        let context = env.modelContainer.mainContext
        context.insert(ListModel(
            id: "L1", name: "before", createdBy: testUserId,
            createdAt: t(0), updatedAt: t(500), deletedAt: nil
        ))
        try context.save()

        let session = env.session
        session.enqueue(path: "/sync/lists", response: .success(listsResponse(rows: [
            ListDTO(
                id: "L1", name: "before", createdBy: testUserId,
                createdAt: t(0), updatedAt: t(1500), deletedAt: t(1500)
            )
        ], serverTime: t(2000))))
        session.enqueue(path: "/sync/items", response: .success(emptyResponse(at: "2026-05-05T12:00:00.000Z")))
        session.enqueue(path: "/sync/list_members", response: .success(emptyResponse(at: "2026-05-05T12:00:00.000Z")))

        try await env.engine.reconcile()

        let lists = try context.fetch(FetchDescriptor<ListModel>())
        #expect(lists.isEmpty)
    }

    @Test func tombstonedItemRemovesLocalCopy() async throws {
        let env = try await makeEnvironment(session: MockSession())
        let context = env.modelContainer.mainContext
        context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk",
            checkedAt: nil, position: 1, createdBy: testUserId,
            createdAt: t(0), updatedAt: t(500), deletedAt: nil
        ))
        try context.save()

        let session = env.session
        session.enqueue(path: "/sync/lists", response: .success(emptyResponse(at: "2026-05-05T12:00:00.000Z")))
        session.enqueue(path: "/sync/items", response: .success(itemsResponse(rows: [
            ItemDTO(
                id: "I1", listId: "L1", text: "milk", checkedAt: nil,
                position: 1, createdBy: testUserId,
                createdAt: t(0), updatedAt: t(1500), deletedAt: t(1500)
            )
        ], serverTime: t(2000))))
        session.enqueue(path: "/sync/list_members", response: .success(emptyResponse(at: "2026-05-05T12:00:00.000Z")))

        try await env.engine.reconcile()

        let items = try context.fetch(FetchDescriptor<ItemModel>())
        #expect(items.isEmpty)
    }

    // MARK: - 4. Self-revocation sweep

    @Test func selfRevocationSweepsListItemsMembers() async throws {
        // Set up local state for a list the user is a member of: list +
        // items + members (self + another). Then run a reconcile that
        // surfaces only the self member row tombstoned. The whole list +
        // its items + the OTHER member's row must all disappear.
        let env = try await makeEnvironment(session: MockSession())
        let context = env.modelContainer.mainContext
        let otherUserId = "other-user"
        context.insert(ListModel(
            id: "L1", name: "before", createdBy: testUserId,
            createdAt: t(0), updatedAt: t(500), deletedAt: nil
        ))
        context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk",
            checkedAt: nil, position: 1, createdBy: testUserId,
            createdAt: t(0), updatedAt: t(500), deletedAt: nil
        ))
        context.insert(MemberModel(
            listId: "L1", userId: testUserId, role: "owner",
            createdAt: t(0), updatedAt: t(500), deletedAt: nil
        ))
        context.insert(MemberModel(
            listId: "L1", userId: otherUserId, role: "editor",
            createdAt: t(0), updatedAt: t(500), deletedAt: nil
        ))
        try context.save()

        let session = env.session
        session.enqueue(path: "/sync/lists", response: .success(emptyResponse(at: "2026-05-05T12:00:00.000Z")))
        session.enqueue(path: "/sync/items", response: .success(emptyResponse(at: "2026-05-05T12:00:00.000Z")))
        session.enqueue(path: "/sync/list_members", response: .success(membersResponse(rows: [
            // Self revocation: own member row tombstoned. The OTHER member
            // row is not surfaced (the backend stops sending it once the
            // caller is revoked — see backend/docs/sync.md).
            ListMemberDTO(
                listId: "L1", userId: testUserId, role: "owner",
                createdAt: t(0), updatedAt: t(1500), deletedAt: t(1500)
            )
        ], serverTime: t(2000))))

        try await env.engine.reconcile()

        // Everything for L1 should be gone, even the rows we never saw a
        // tombstone for (other member, items). That's the sweep guarantee:
        // since we no longer have access to the list, we proactively clear
        // any stale state for it.
        let lists = try context.fetch(FetchDescriptor<ListModel>())
        let items = try context.fetch(FetchDescriptor<ItemModel>())
        let members = try context.fetch(FetchDescriptor<MemberModel>())
        #expect(lists.isEmpty)
        #expect(items.isEmpty)
        #expect(members.isEmpty)
    }

    // MARK: - 5. Cursor persistence + round-trip

    @Test func persistsCursorsAndPassesThemAsSinceOnSecondPull() async throws {
        let session = MockSession()
        // First pull — no cursor yet, returns serverTime t(2000).
        session.enqueue(path: "/sync/lists", response: .success(emptyResponse(at: "2026-05-05T12:00:00.001Z")))
        session.enqueue(path: "/sync/items", response: .success(emptyResponse(at: "2026-05-05T12:00:00.002Z")))
        session.enqueue(path: "/sync/list_members", response: .success(emptyResponse(at: "2026-05-05T12:00:00.003Z")))
        // Second pull — empty (nothing changed). The `since` value should
        // match the serverTime returned on pull #1 for each respective
        // resource.
        session.enqueue(path: "/sync/lists", response: .success(emptyResponse(at: "2026-05-05T12:00:01.000Z")))
        session.enqueue(path: "/sync/items", response: .success(emptyResponse(at: "2026-05-05T12:00:01.000Z")))
        session.enqueue(path: "/sync/list_members", response: .success(emptyResponse(at: "2026-05-05T12:00:01.000Z")))

        let env = try await makeEnvironment(session: session)
        try await env.engine.reconcile()
        try await env.engine.reconcile()

        let recorded = await session.requests
        #expect(recorded.count == 6)
        // First three: no `since=` query.
        for i in 0..<3 {
            let q = recorded[i].url?.query ?? ""
            #expect(q.isEmpty, "expected pull #1 to omit since=, got: \(q)")
        }
        // Next three: each carries a `since=...` matching the prior pull's
        // serverTime for the same resource. We don't pin the exact percent
        // encoding (Foundation's URLComponents handles that); we only check
        // the value is present and non-empty.
        for i in 3..<6 {
            let q = recorded[i].url?.query ?? ""
            #expect(q.contains("since="), "expected pull #2 to include since=, got: \(q)")
        }
        // Cursor for /sync/lists on pull #2 carries the serverTime from
        // pull #1 ("2026-05-05T12:00:00.001Z"). Foundation's URLComponents
        // doesn't aggressively percent-encode `:` in query values (it's a
        // legal sub-delim per RFC 3986) and Hono parses it correctly either
        // way — see the live curl tests for confirmation. We only assert
        // the literal timestamp appears, not the exact encoding.
        let listsQuery = recorded[3].url?.query ?? ""
        #expect(listsQuery.contains("2026-05-05T12:00:00.001Z"))
    }

    // MARK: - 6. Offline guard

    @Test func reconcileWhileOfflineIsNoOp() async throws {
        let session = MockSession()
        // Don't enqueue ANY responses — if the engine attempts a network
        // call, MockSession.unscriptedRequest would throw and the test fails.

        let env = try await makeEnvironment(session: session, isOnline: false)
        try await env.engine.reconcile()

        let recorded = await session.requests
        #expect(recorded.isEmpty)
    }

    // MARK: - 7. Auth gate

    @Test func reconcileWithoutAuthThrows() async throws {
        let session = MockSession()
        let env = try await makeEnvironment(session: session, signedIn: false)
        do {
            try await env.engine.reconcile()
            Issue.record("expected SyncEngineError.notAuthenticated")
        } catch SyncEngineError.notAuthenticated {
            // expected
        } catch {
            Issue.record("expected SyncEngineError.notAuthenticated, got \(error)")
        }
    }
}

// MARK: - Test fixtures

private let testBaseURL = URL(string: "https://example.test")!
private let testUserId = "user-1"

@MainActor
private struct SyncTestEnvironment {
    let engine: SyncEngine
    let modelContainer: ModelContainer
    let session: MockSession
}

@MainActor
private func makeEnvironment(
    session: MockSession,
    isOnline: Bool = true,
    signedIn: Bool = true
) async throws -> SyncTestEnvironment {
    let store = TokenStore(keychain: InMemoryKeychainStore())
    if signedIn {
        try await store.save(.init(
            accessToken: "tkn-A",
            refreshToken: "tkn-R",
            user: AuthUser(id: testUserId, email: "test@example.com", displayName: "Test")
        ))
    }
    let api = APIClient(baseURL: testBaseURL, session: session, tokenStore: store)
    let monitor = MockNetworkMonitor(isOnline: isOnline)
    let container = inMemoryContainer()
    let engine = SyncEngine(
        api: api,
        container: container,
        monitor: monitor,
        currentUserId: { [weak store] in store?.current?.user.id }
    )
    return SyncTestEnvironment(engine: engine, modelContainer: container, session: session)
}

/// Fresh SwiftData container per test — `isStoredInMemoryOnly: true` so writes
/// don't survive between tests and the container can be torn down with the
/// test struct.
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
            configurations: configuration
        )
    } catch {
        // A test setup failure is a programmer error — surface immediately.
        fatalError("test ModelContainer init failed: \(error)")
    }
}

/// Build a Date from a millisecond offset (test only). Avoids the floating
/// point fragility of `Date(timeIntervalSince1970:)` for fixed test instants.
private func t(_ ms: Int) -> Date {
    Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
}

private func emptyResponse(at iso: String) -> Data {
    let body = """
    {"serverTime":"\(iso)","rows":[]}
    """
    return Data(body.utf8)
}

private func listsResponse(rows: [ListDTO], serverTime: Date) -> Data {
    encode(SyncListsResponse(serverTime: serverTime, rows: rows))
}

private func itemsResponse(rows: [ItemDTO], serverTime: Date) -> Data {
    encode(SyncItemsResponse(serverTime: serverTime, rows: rows))
}

private func membersResponse(rows: [ListMemberDTO], serverTime: Date) -> Data {
    encode(SyncListMembersResponse(serverTime: serverTime, rows: rows))
}

private func encode<T: Encodable>(_ value: T) -> Data {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    do {
        return try encoder.encode(value)
    } catch {
        fatalError("test fixture encode failed: \(error)")
    }
}
