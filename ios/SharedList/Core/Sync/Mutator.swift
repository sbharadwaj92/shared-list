import Foundation
import SwiftData

// Mutator — slice C.2.
//
// Single responsibility: every user action (create/rename/delete a list or
// item; check/uncheck) goes through here. Each call does TWO things in one
// SwiftData transaction:
//
//   1. Apply the change to the local store (optimistic UI). The view layer
//      reads SwiftData directly via @Query and sees the change next render
//      tick; the user perceives the action as instant.
//   2. Append a `MutationQueueEntry` row capturing the intent. The drainer
//      (slice C.3) reads these rows and translates them into HTTP requests
//      against the backend, removing each entry on success or moving it to
//      `failed` on a permanent error.
//
// Two-in-one-transaction matters: if the local apply succeeded but the queue
// append failed, we'd silently lose a write to the backend (the row would
// look correct locally, never reach the server, and a future device-fresh
// pull would erase it). `context.save()` at the end of every mutator method
// is the single commit point — either both rows land or neither does.
//
// What this slice DOES NOT do:
//   - Send anything over the network. The Mutator has no APIClient
//     dependency by design — the drainer in slice C.3 owns all HTTP.
//   - 409 conflict resolution. The local row's `updatedAt` is pre-stamped
//     to `Date()` here; when the server response eventually arrives via the
//     `?since=` reconciler, the existing LWW guard in SyncEngine.upsert*
//     compares wire `updatedAt` to local and the newer wins. A 409 from
//     PATCH (server has newer state) is slice C.3's problem.
//   - UI. Every `LazyForEach` / `@Query` reading from SwiftData filters
//     `deletedAt == nil`, so a soft-delete here is invisible to the UI
//     immediately without any view-layer changes. The `ListsTabView`
//     itself doesn't exist yet — that's Phase 13.
//
// Cascade on `deleteList`:
//   The backend's `DELETE /lists/:id` cascades soft-delete to items in the
//   same transaction (slice C.1). We mirror that locally so the UI doesn't
//   show "list gone" with phantom items lingering. Importantly, we enqueue
//   ONLY the list-delete — the server cascades on its side, so enqueueing
//   N+1 entries (list + each item) would cause N redundant 404s when the
//   drainer runs (each item is already tombstoned by the cascade). One
//   queue entry, one HTTP request.
//
// Position picking on `createItem`:
//   New items get `position = (max(existing positions) ?? 0) + 1024`. The
//   1024 gap leaves room to reorder by midpoint without immediate collisions
//   (PLAN.md L165 documents the integer-position vs fractional-indexing
//   trade-off). Concurrent creates from two devices will race; LWW resolves
//   the visible order on the next reconcile, which is acceptable for v1.
//
// MainActor isolation:
//   Same story as SyncEngine — SwiftData's `mainContext` is
//   main-actor-bound, so the Mutator runs on `@MainActor`. No background
//   context here; the drainer in slice C.3 is the one that may need to
//   move work off the main actor.

@MainActor
public final class Mutator {
    private let container: ModelContainer
    /// Injected so tests can use `FixedClock` to assert exact timestamps
    /// without sleep-and-poll. Production wires `SystemClock`.
    private let clock: any Clock
    /// Injected for the same reason — tests want deterministic ids; prod
    /// uses `Foundation.UUID()` (v4 today; PLAN.md prefers v7 for server
    /// index locality, but clients generating v4 still satisfy the backend
    /// idempotency contract because `ON CONFLICT (id)` only cares about
    /// uniqueness, not version bits — see KNOWN_DEBT note at file bottom).
    private let uuidGenerator: any UUIDGenerating

    public init(
        container: ModelContainer,
        clock: any Clock = SystemClock(),
        uuidGenerator: any UUIDGenerating = SystemUUIDGenerator()
    ) {
        self.container = container
        self.clock = clock
        self.uuidGenerator = uuidGenerator
    }

    // MARK: - Lists

    /// Create a new list. Returns the new list's id so callers can navigate
    /// straight into it without a second fetch. The actor automatically
    /// becomes the owner — the backend handles that on its side via
    /// `insertListWithOwner`, and slice C.3 will optimistically insert the
    /// local owner-membership row (deferred here because we don't know the
    /// signed-in user id without taking an AuthService dependency the
    /// Mutator doesn't otherwise need; the next reconcile fills it in).
    @discardableResult
    public func createList(name: String) throws -> String {
        let id = uuidGenerator.newUUID()
        let now = clock.now()
        let context = container.mainContext

        // Local apply: insert the row pre-stamped to `now` so the LWW guard
        // in `SyncEngine.upsertList` correctly resolves an at-the-cursor
        // server response without overwriting our optimistic state.
        // `createdBy` is left empty — we don't have the user id without an
        // AuthService dep; the next reconcile will overwrite when the
        // server's row comes back via `?since=`. Same for any other
        // server-assigned columns in future phases.
        context.insert(ListModel(
            id: id,
            name: name,
            createdBy: "",
            createdAt: now,
            updatedAt: now,
            deletedAt: nil
        ))

        // Queue append: serialize the create-list payload as JSON. The
        // drainer (slice C.3) decodes back into `CreateListPayload` to
        // build the POST body. Same `id` field as the local row — that's
        // what makes server-side `INSERT ... ON CONFLICT (id) DO NOTHING`
        // idempotent against our retries.
        let payload = try encode(CreateListPayload(id: id, name: name))
        context.insert(MutationQueueEntry(
            id: uuidGenerator.newUUID(),
            opType: MutationOpType.createList.rawValue,
            targetId: id,
            payload: payload,
            createdAt: now
        ))

        // One save commits both rows atomically. A throw rolls both back
        // (which is the point — see file header).
        try context.save()
        return id
    }

    /// Rename an existing list. The local `updatedAt` bumps to `now` so the
    /// next reconcile's LWW guard picks the right winner. The queue entry
    /// captures the new name AND the local `updatedAt` so the drainer can
    /// send it as the `If-Match` header (slice C.3 will read this).
    public func renameList(id: String, newName: String) throws {
        let now = clock.now()
        let context = container.mainContext

        // Locate the local row. If it doesn't exist (or has been
        // tombstoned), this is a no-op rather than an error — the user
        // shouldn't see a crash because some other device deleted the list
        // between the rename tap and the mutator call. The next reconcile
        // will sync truth.
        guard let row = try findActiveList(id: id, in: context) else {
            return
        }
        // Capture the cursor BEFORE we mutate it — the drainer needs the
        // pre-mutation `updatedAt` as the `If-Match` value (matching what
        // the server currently has on disk). Stamping `now` then sending
        // `now` would 409 immediately because the server's row is older.
        let priorUpdatedAt = row.updatedAt

        row.name = newName
        row.updatedAt = now

        let payload = try encode(RenameListPayload(
            name: newName,
            ifMatch: priorUpdatedAt
        ))
        context.insert(MutationQueueEntry(
            id: uuidGenerator.newUUID(),
            opType: MutationOpType.renameList.rawValue,
            targetId: id,
            payload: payload,
            createdAt: now
        ))

        try context.save()
    }

    /// Soft-delete a list AND cascade soft-delete to its items, mirroring
    /// the backend's `DELETE /lists/:id` transaction. We enqueue ONLY the
    /// list-delete; the server cascades on its side, so enqueueing item
    /// deletes too would cause N redundant 404s when the drainer runs.
    public func deleteList(id: String) throws {
        let now = clock.now()
        let context = container.mainContext

        guard let row = try findActiveList(id: id, in: context) else {
            return
        }
        row.deletedAt = now
        row.updatedAt = now

        // Cascade — same `now` instant on every affected item so a future
        // user inspecting the trash sees a coherent "deleted at this
        // moment" timeline.
        let items = try findActiveItemsInList(listId: id, in: context)
        for item in items {
            item.deletedAt = now
            item.updatedAt = now
        }

        let payload = try encode(DeleteListPayload())
        context.insert(MutationQueueEntry(
            id: uuidGenerator.newUUID(),
            opType: MutationOpType.deleteList.rawValue,
            targetId: id,
            payload: payload,
            createdAt: now
        ))

        try context.save()
    }

    // MARK: - Items

    /// Add an item to a list. Returns the new item's id. `position` is
    /// auto-picked at `(max existing position) + 1024` so manual reorders
    /// have room to fit between by midpoint (PLAN.md L165).
    @discardableResult
    public func createItem(listId: String, text: String) throws -> String {
        let id = uuidGenerator.newUUID()
        let now = clock.now()
        let context = container.mainContext

        // Auto-position: max + 1024. If the list is empty, start at 1024
        // (rather than 0) so the FIRST manual reorder can pick a midpoint
        // that's still a positive integer.
        let nextPosition = try maxItemPosition(listId: listId, in: context).map { $0 + 1024 } ?? 1024

        context.insert(ItemModel(
            id: id,
            listId: listId,
            text: text,
            checkedAt: nil,
            position: nextPosition,
            createdBy: "",
            createdAt: now,
            updatedAt: now,
            deletedAt: nil
        ))

        let payload = try encode(CreateItemPayload(
            id: id,
            text: text,
            position: nextPosition
        ))
        context.insert(MutationQueueEntry(
            id: uuidGenerator.newUUID(),
            opType: MutationOpType.createItem.rawValue,
            targetId: id,
            payload: payload,
            createdAt: now
        ))

        try context.save()
        return id
    }

    /// Patch an item — any subset of `text`, `position`, `checkedAt`. Each
    /// nil-by-default parameter means "don't touch this column"; passing
    /// `checkedAt: nil` explicitly is NOT how you uncheck — use
    /// `setCheckedAt(.unchecked)` for that. The wrapper enum makes the
    /// "leave alone" vs "explicitly clear" distinction at the call site
    /// without making every other parameter a double-Optional.
    public func patchItem(
        id: String,
        text: String? = nil,
        position: Int? = nil,
        checkedAt: CheckedAtChange? = nil
    ) throws {
        // Empty patches are caller bugs — surface immediately rather than
        // silently no-op or hit the backend with a 400. Mirrors the
        // backend's empty-body 400 on PATCH /items/:id.
        if text == nil, position == nil, checkedAt == nil {
            throw MutatorError.emptyPatch
        }
        let now = clock.now()
        let context = container.mainContext

        guard let row = try findActiveItem(id: id, in: context) else {
            return
        }
        let priorUpdatedAt = row.updatedAt

        // Only the supplied fields change; the rest stay untouched.
        if let text { row.text = text }
        if let position { row.position = position }
        if let checkedAt {
            switch checkedAt {
            case .checked(let ts): row.checkedAt = ts
            case .unchecked: row.checkedAt = nil
            }
        }
        row.updatedAt = now

        let payload = try encode(PatchItemPayload(
            text: text,
            position: position,
            checked: checkedAt.map { change in
                switch change {
                case .checked(let ts): return .some(ts)
                case .unchecked: return .none
                }
            } ?? .leaveAlone,
            ifMatch: priorUpdatedAt
        ))
        context.insert(MutationQueueEntry(
            id: uuidGenerator.newUUID(),
            opType: MutationOpType.patchItem.rawValue,
            targetId: id,
            payload: payload,
            createdAt: now
        ))

        try context.save()
    }

    public func deleteItem(id: String) throws {
        let now = clock.now()
        let context = container.mainContext

        guard let row = try findActiveItem(id: id, in: context) else {
            return
        }
        row.deletedAt = now
        row.updatedAt = now

        let payload = try encode(DeleteItemPayload())
        context.insert(MutationQueueEntry(
            id: uuidGenerator.newUUID(),
            opType: MutationOpType.deleteItem.rawValue,
            targetId: id,
            payload: payload,
            createdAt: now
        ))

        try context.save()
    }

    // MARK: - Lookup helpers
    //
    // Active-row helpers all filter `deletedAt == nil` — same convention as
    // the SyncEngine's deleteLocalList/deleteLocalItem and the eventual
    // feature views. Centralizing here keeps the filter rule in one place.

    private func findActiveList(id: String, in context: ModelContext) throws -> ListModel? {
        var descriptor = FetchDescriptor<ListModel>(
            predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    private func findActiveItem(id: String, in context: ModelContext) throws -> ItemModel? {
        var descriptor = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    private func findActiveItemsInList(
        listId: String,
        in context: ModelContext
    ) throws -> [ItemModel] {
        let descriptor = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.listId == listId && $0.deletedAt == nil }
        )
        return try context.fetch(descriptor)
    }

    /// Returns the highest position among active items in the list, or nil
    /// if the list is empty. We fetch all rows and pick the max in Swift
    /// rather than push the aggregation into a SwiftData predicate — the
    /// per-list item count is small (3-user grocery list), and SwiftData's
    /// `FetchDescriptor` doesn't expose `MAX()` cleanly. Optimize later
    /// if profiling ever shows it.
    private func maxItemPosition(listId: String, in context: ModelContext) throws -> Int? {
        let rows = try findActiveItemsInList(listId: listId, in: context)
        return rows.map(\.position).max()
    }

    // MARK: - Encoding

    /// JSON-encode a payload to the string we persist in the queue row.
    /// Uses `.iso8601` so the embedded `If-Match` timestamp round-trips
    /// losslessly to the wire format (matches APIClient's decoder config).
    private func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            // JSONEncoder always produces valid UTF-8; this branch is a
            // sanity guard, not a real failure mode.
            throw MutatorError.payloadEncodingFailed
        }
        return string
    }
}

// MARK: - Payload types
//
// One Codable struct per opType. The drainer (slice C.3) decodes the
// queue's JSON `payload` into the right type via the opType string and
// then maps to an HTTP request.
//
// We keep payload types separate from `SyncDTOs.swift` even though they
// share field names with `ListDTO` / `ItemDTO`. The wire DTO is what the
// server SENDS; the payload is what the client SENDS. They diverge over
// time (e.g. PATCH bodies don't include createdAt/createdBy/etc) and
// coupling them would force noise into the read DTOs.

public struct CreateListPayload: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
}

public struct RenameListPayload: Codable, Sendable, Equatable {
    public let name: String
    /// Drainer hands this to the server as the `If-Match` header. The
    /// server compares against its current `updated_at` and 409s on
    /// mismatch (slice C.1 contract).
    public let ifMatch: Date
}

public struct DeleteListPayload: Codable, Sendable, Equatable {
    // No body fields — the resource id lives on the queue entry, the URL
    // path carries it. The empty struct is here for Codable symmetry with
    // the other payload types (one decode site per opType, no special-case).
    public init() {}
}

public struct CreateItemPayload: Codable, Sendable, Equatable {
    public let id: String
    public let text: String
    public let position: Int
}

public struct PatchItemPayload: Codable, Sendable, Equatable {
    public let text: String?
    public let position: Int?
    /// Three-state to capture "leave checked alone" vs "set checked to a
    /// timestamp" vs "explicitly uncheck (set to null)". The wire shape
    /// for the third case is the literal JSON `null`, which a plain
    /// `Date?` cannot distinguish from "field omitted". `OptionalChange`
    /// gives us the encoding seam.
    public let checked: OptionalChange<Date>
    public let ifMatch: Date

    private enum CodingKeys: String, CodingKey {
        case text
        case position
        case checked
        case ifMatch
    }

    public init(
        text: String?,
        position: Int?,
        checked: OptionalChange<Date>,
        ifMatch: Date
    ) {
        self.text = text
        self.position = position
        self.checked = checked
        self.ifMatch = ifMatch
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(position, forKey: .position)
        switch checked {
        case .leaveAlone:
            // Don't emit the key at all — backend reads "field absent" as
            // "leave the column alone". This matches the slice-C.1 PATCH
            // contract.
            break
        case .none:
            // Emit the JSON literal `null` to explicitly clear the column.
            try c.encodeNil(forKey: .checked)
        case .some(let date):
            try c.encode(date, forKey: .checked)
        }
        try c.encode(ifMatch, forKey: .ifMatch)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        ifMatch = try c.decode(Date.self, forKey: .ifMatch)
        // Distinguish "key absent" (leaveAlone), "key present and null"
        // (none), and "key present with value" (some).
        if c.contains(.checked) {
            if try c.decodeNil(forKey: .checked) {
                checked = .none
            } else {
                checked = .some(try c.decode(Date.self, forKey: .checked))
            }
        } else {
            checked = .leaveAlone
        }
    }
}

public struct DeleteItemPayload: Codable, Sendable, Equatable {
    public init() {}
}

/// Three-state representation for nullable PATCH fields where "field
/// absent" and "field present and null" mean different things on the wire
/// (the former says "leave the column unchanged", the latter says
/// "explicitly set the column to NULL"). Plain `Date??` is the
/// theoretically-correct shape but Codable's auto-synthesis collapses it.
public enum OptionalChange<Wrapped: Codable & Sendable & Equatable>: Sendable, Equatable {
    case leaveAlone
    case none
    case some(Wrapped)
}

/// Caller-side three-state for `Mutator.patchItem(checkedAt:)`. The
/// Mutator translates this into the wire-side `OptionalChange<Date>` for
/// the payload. Keeping the call-site type and the wire-side type
/// distinct means callers don't need to know about the JSON-null dance.
public enum CheckedAtChange: Sendable, Equatable {
    case checked(Date)
    case unchecked
}

// MARK: - Errors

public enum MutatorError: Error, Sendable, Equatable {
    /// Mirrors the backend's 400 on an empty PATCH body — caller bug to
    /// surface immediately rather than swallow.
    case emptyPatch
    /// JSONEncoder failed to produce UTF-8 from a payload — should be
    /// unreachable in practice; surfaced for completeness.
    case payloadEncodingFailed
}

// MARK: - Time + UUID seams (test-injectable)
//
// The Mutator pins `createdAt` and `updatedAt` to `clock.now()` and ids
// to `uuidGenerator.newUUID()` — both behind protocols so the test suite
// can use deterministic stand-ins. Without these seams, asserting on
// "did the queue row's createdAt match the local row's updatedAt?" would
// require sleeping or fishy near-equal comparisons.

public protocol Clock: Sendable {
    func now() -> Date
}

public struct SystemClock: Clock {
    public init() {}
    public func now() -> Date { Date() }
}

public protocol UUIDGenerating: Sendable {
    func newUUID() -> String
}

public struct SystemUUIDGenerator: UUIDGenerating {
    public init() {}
    public func newUUID() -> String {
        // PLAN.md L47 prefers UUID v7 for Postgres index locality. Apple's
        // `Foundation.UUID` is v4 only as of iOS 26. The backend's
        // `INSERT ... ON CONFLICT (id) DO NOTHING` only cares that the id
        // is unique — it doesn't validate the version bits — so v4 here
        // satisfies the idempotency contract. Index locality on the
        // server's `lists.id` / `items.id` PK is a measurable-but-small
        // loss for a 3-user app; we accept it for v1 and treat upgrading
        // to a real v7 generator as a Phase-19 polish.
        UUID().uuidString.lowercased()
    }
}
