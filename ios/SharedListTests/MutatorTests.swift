import Foundation
import SwiftData
import Testing
@testable import SharedList

// Mutator tests for slice C.2. Pin the optimistic-apply + queue-append
// contract that the drainer (slice C.3) and the eventual UI will rely on:
//
//   1. Every Mutator call writes BOTH a local row mutation AND a
//      corresponding `MutationQueueEntry` row, in one save.
//   2. Local rows pre-stamp `updatedAt = clock.now()` so the next
//      reconcile's LWW guard resolves correctly when the server's row
//      arrives via `?since=`.
//   3. Idempotency-id reuse: the local row's id matches the queue entry's
//      `targetId` AND the JSON payload's `id` field for create ops. That
//      tuple is what makes a server retry idempotent.
//   4. `deleteList` cascades a local soft-delete to items, but enqueues
//      ONLY the list-delete (server cascades on its side).
//   5. `patchItem` rejects an empty patch with `MutatorError.emptyPatch`,
//      mirroring the backend's 400 on PATCH /items/:id with `{}`.
//   6. The `If-Match` value persisted in patch/rename payloads is the
//      PRIOR `updatedAt`, not the post-mutation value — otherwise the
//      drainer would 409 itself.
//
// We use a `FixedClock` and `SequenceUUIDGenerator` so timestamps and ids
// are exact, removing flake-prone near-equal comparisons.

@Suite("Mutator")
@MainActor
struct MutatorTests {

    // MARK: - 1. Atomic write: local row + queue entry land together

    @Test func createListInsertsLocalRowAndQueueEntry() throws {
        let env = makeEnvironment(uuids: ["list-1", "queue-1"])
        let id = try env.mutator.createList(name: "Groceries")
        #expect(id == "list-1")

        let lists = try env.context.fetch(FetchDescriptor<ListModel>())
        #expect(lists.count == 1)
        #expect(lists.first?.id == "list-1")
        #expect(lists.first?.name == "Groceries")
        // Local apply pre-stamps updatedAt to the clock's `now()` — same
        // value that gets serialized into the queue entry's createdAt.
        #expect(lists.first?.updatedAt == env.clock.fixed)
        #expect(lists.first?.createdAt == env.clock.fixed)
        #expect(lists.first?.deletedAt == nil)

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.count == 1)
        let entry = queue.first
        #expect(entry?.id == "queue-1")
        #expect(entry?.opType == MutationOpType.createList.rawValue)
        // The queue entry's targetId must equal the local row's id — that's
        // how the drainer joins queue → resource and how the server-side
        // ON CONFLICT (id) makes a retry idempotent.
        #expect(entry?.targetId == "list-1")
        #expect(entry?.createdAt == env.clock.fixed)
        #expect(entry?.status == MutationStatus.pending.rawValue)
        #expect(entry?.retryCount == 0)
        #expect(entry?.lastError == nil)

        // Decode the payload and confirm it carries the same id + name —
        // the drainer reads this back to build the POST body.
        let payload = try env.decode(CreateListPayload.self, json: entry?.payload ?? "")
        #expect(payload.id == "list-1")
        #expect(payload.name == "Groceries")
    }

    // MARK: - 2. Pre-stamped updatedAt for LWW friendliness

    @Test func renameListBumpsLocalUpdatedAtAndPersistsPriorAsIfMatch() throws {
        // Seed an existing list with an "old" updatedAt; rename and check
        // that (a) the local row jumps to clock.now and (b) the queue
        // entry's payload carries the OLD updatedAt as `ifMatch` — sending
        // the new one would 409 against the server immediately.
        let env = makeEnvironment(uuids: ["queue-1"])
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ListModel(
            id: "L1", name: "before", createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.renameList(id: "L1", newName: "after")

        let row = try env.context.fetch(FetchDescriptor<ListModel>()).first
        #expect(row?.name == "after")
        #expect(row?.updatedAt == env.clock.fixed)

        let entry = try env.context.fetch(FetchDescriptor<MutationQueueEntry>()).first
        #expect(entry?.opType == MutationOpType.renameList.rawValue)
        #expect(entry?.targetId == "L1")
        let payload = try env.decode(RenameListPayload.self, json: entry?.payload ?? "")
        #expect(payload.name == "after")
        // `ifMatch` is the PRIOR cursor — the value the server still has.
        // The drainer sends this to the server as the If-Match header.
        #expect(payload.ifMatch == priorUpdated)
    }

    @Test func patchItemUsesPriorUpdatedAtAsIfMatch() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: nil,
            position: 1, createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.patchItem(id: "I1", text: "almond milk")

        let row = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(row?.text == "almond milk")
        #expect(row?.updatedAt == env.clock.fixed)

        let entry = try env.context.fetch(FetchDescriptor<MutationQueueEntry>()).first
        let payload = try env.decode(PatchItemPayload.self, json: entry?.payload ?? "")
        #expect(payload.text == "almond milk")
        #expect(payload.position == nil)
        #expect(payload.checked == .leaveAlone)
        #expect(payload.ifMatch == priorUpdated)
    }

    // MARK: - 3. Idempotency id reuse on creates

    @Test func createItemReusesIdInLocalRowAndPayload() throws {
        let env = makeEnvironment(uuids: ["item-1", "queue-1"])
        let id = try env.mutator.createItem(listId: "L1", text: "milk")
        #expect(id == "item-1")

        let row = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(row?.id == "item-1")

        let entry = try env.context.fetch(FetchDescriptor<MutationQueueEntry>()).first
        #expect(entry?.targetId == "item-1")
        let payload = try env.decode(CreateItemPayload.self, json: entry?.payload ?? "")
        #expect(payload.id == "item-1")
        // First item in an empty list starts at position 1024 (PLAN.md L165
        // documents the integer-position trade-off; midpoint reorders need
        // a non-zero start so even the very first reorder has room).
        #expect(payload.position == 1024)
        #expect(row?.position == 1024)
    }

    @Test func createItemPicksMaxPositionPlus1024() throws {
        let env = makeEnvironment(uuids: ["item-2", "queue-2"])
        // Seed one existing item at position 5_000.
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "first", checkedAt: nil,
            position: 5_000, createdBy: "u", createdAt: Date(), updatedAt: Date(),
            deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.createItem(listId: "L1", text: "second")

        let rows = try env.context
            .fetch(FetchDescriptor<ItemModel>())
            .sorted { $0.position < $1.position }
        #expect(rows.map(\.position) == [5_000, 6_024])
    }

    // MARK: - 4. Cascade soft-delete on deleteList

    @Test func deleteListCascadesItemsButEnqueuesOnlyTheListDelete() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        env.context.insert(ListModel(
            id: "L1", name: "shopping", createdBy: "u",
            createdAt: Date(), updatedAt: Date(), deletedAt: nil
        ))
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: nil,
            position: 1, createdBy: "u", createdAt: Date(), updatedAt: Date(),
            deletedAt: nil
        ))
        env.context.insert(ItemModel(
            id: "I2", listId: "L1", text: "eggs", checkedAt: nil,
            position: 2, createdBy: "u", createdAt: Date(), updatedAt: Date(),
            deletedAt: nil
        ))
        // An already-tombstoned item should NOT have its updatedAt re-bumped
        // (mirrors backend slice-C.1 cascade behaviour: don't churn dead
        // rows back into the read feed).
        let priorTombstone = Date(timeIntervalSince1970: 100)
        env.context.insert(ItemModel(
            id: "I-old", listId: "L1", text: "ancient", checkedAt: nil,
            position: 0, createdBy: "u", createdAt: Date(),
            updatedAt: priorTombstone, deletedAt: priorTombstone
        ))
        try env.context.save()

        try env.mutator.deleteList(id: "L1")

        // List is soft-deleted.
        let list = try env.context.fetch(FetchDescriptor<ListModel>()).first
        #expect(list?.deletedAt == env.clock.fixed)
        #expect(list?.updatedAt == env.clock.fixed)

        // Both active items are now tombstoned at clock.now.
        let live = try env.context
            .fetch(FetchDescriptor<ItemModel>())
            .filter { $0.id != "I-old" }
            .sorted { $0.id < $1.id }
        #expect(live.map(\.deletedAt) == [env.clock.fixed, env.clock.fixed])
        #expect(live.map(\.updatedAt) == [env.clock.fixed, env.clock.fixed])

        // Already-tombstoned item left untouched.
        let oldFetch = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.id == "I-old" }
        )
        let old = try env.context.fetch(oldFetch).first
        #expect(old?.deletedAt == priorTombstone)
        #expect(old?.updatedAt == priorTombstone)

        // ONE queue entry — the list-delete. Item-deletes are NOT enqueued
        // (the server cascades on its side; enqueueing per-item would mean
        // N redundant 404s when the drainer runs).
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.count == 1)
        #expect(queue.first?.opType == MutationOpType.deleteList.rawValue)
        #expect(queue.first?.targetId == "L1")
    }

    @Test func deleteItemSoftDeletesAndEnqueues() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: nil,
            position: 1, createdBy: "u", createdAt: Date(), updatedAt: Date(),
            deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.deleteItem(id: "I1")

        let row = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(row?.deletedAt == env.clock.fixed)

        let entry = try env.context.fetch(FetchDescriptor<MutationQueueEntry>()).first
        #expect(entry?.opType == MutationOpType.deleteItem.rawValue)
        #expect(entry?.targetId == "I1")
    }

    // MARK: - 5. Empty patch is a 400-shape error

    @Test func patchItemRejectsEmptyPatch() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: nil,
            position: 1, createdBy: "u", createdAt: Date(), updatedAt: Date(),
            deletedAt: nil
        ))
        try env.context.save()

        do {
            try env.mutator.patchItem(id: "I1")
            Issue.record("expected MutatorError.emptyPatch")
        } catch MutatorError.emptyPatch {
            // expected
        } catch {
            Issue.record("expected MutatorError.emptyPatch, got \(error)")
        }

        // Nothing was queued — the throw blocked the append.
        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
    }

    // MARK: - 6. Checked toggle three-state encoding

    @Test func patchItemCheckedExplicitlyClearsViaJsonNull() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        let priorUpdated = Date(timeIntervalSince1970: 1_000)
        let checkTime = Date(timeIntervalSince1970: 2_000)
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: checkTime,
            position: 1, createdBy: "u", createdAt: priorUpdated,
            updatedAt: priorUpdated, deletedAt: nil
        ))
        try env.context.save()

        try env.mutator.patchItem(id: "I1", checkedAt: .unchecked)

        let row = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(row?.checkedAt == nil)

        // The persisted JSON must carry `"checked": null` (literal null),
        // NOT omit the key. The backend reads "key absent" as "leave the
        // column alone" — encoding nil-as-omitted would silently fail to
        // uncheck on the server.
        let entry = try env.context.fetch(FetchDescriptor<MutationQueueEntry>()).first
        #expect(entry?.payload.contains("\"checked\":null") == true)
    }

    @Test func patchItemCheckedSetsTimestamp() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        env.context.insert(ItemModel(
            id: "I1", listId: "L1", text: "milk", checkedAt: nil,
            position: 1, createdBy: "u", createdAt: Date(), updatedAt: Date(),
            deletedAt: nil
        ))
        try env.context.save()

        let checkTime = Date(timeIntervalSince1970: 2_000)
        try env.mutator.patchItem(id: "I1", checkedAt: .checked(checkTime))

        let row = try env.context.fetch(FetchDescriptor<ItemModel>()).first
        #expect(row?.checkedAt == checkTime)

        let entry = try env.context.fetch(FetchDescriptor<MutationQueueEntry>()).first
        let payload = try env.decode(PatchItemPayload.self, json: entry?.payload ?? "")
        #expect(payload.checked == .some(checkTime))
    }

    // MARK: - 7. Mutating a tombstoned/missing row is a no-op

    @Test func mutatingMissingListIsNoOp() throws {
        let env = makeEnvironment(uuids: ["queue-1"])
        // No seeded list. The rename should silently no-op so a stale tap
        // (some other device deleted the list mid-edit) doesn't crash.
        try env.mutator.renameList(id: "L-ghost", newName: "x")

        let queue = try env.context.fetch(FetchDescriptor<MutationQueueEntry>())
        #expect(queue.isEmpty)
    }
}

// MARK: - Test fixtures

@MainActor
private struct MutatorTestEnvironment {
    let mutator: Mutator
    let modelContainer: ModelContainer
    let context: ModelContext
    let clock: FixedClock
    let uuidGenerator: SequenceUUIDGenerator

    func decode<T: Decodable>(_ type: T.Type, json: String) throws -> T {
        // Use the production decoder so millisecond-fractional dates
        // round-trip correctly; Foundation's default `.iso8601`
        // strategy is second-precision and would fail on fractional
        // input.
        let decoder = JSONCoders.makeDecoder()
        return try decoder.decode(type, from: Data(json.utf8))
    }
}

@MainActor
private func makeEnvironment(uuids: [String]) -> MutatorTestEnvironment {
    let container = inMemoryContainer()
    let clock = FixedClock(fixed: Date(timeIntervalSince1970: 9_999))
    let generator = SequenceUUIDGenerator(values: uuids)
    let mutator = Mutator(
        container: container,
        clock: clock,
        uuidGenerator: generator
    )
    return MutatorTestEnvironment(
        mutator: mutator,
        modelContainer: container,
        context: container.mainContext,
        clock: clock,
        uuidGenerator: generator
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

/// Fixed-time clock so every assertion against `updatedAt` / `createdAt` is
/// exact. No `Date.now` flakiness, no near-equal floats, no sleeps.
private final class FixedClock: Clock, @unchecked Sendable {
    let fixed: Date
    init(fixed: Date) { self.fixed = fixed }
    func now() -> Date { fixed }
}

/// UUID generator that hands out a pre-scripted sequence and crashes when
/// asked for one beyond the sequence — that shape makes "the test forgot
/// to script enough ids" a loud failure rather than a silent random id
/// that breaks downstream assertions.
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
