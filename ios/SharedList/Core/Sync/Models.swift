import Foundation
import SwiftData

// SwiftData persistent models — the local cache the sync engine writes to.
//
// Why SwiftData and not Core Data / GRDB / a hand-rolled SQLite layer?
// PLAN.md L194 picks SwiftData for the iOS persistence: it's the Swift-6-era
// Apple-blessed answer, gives us `@Model` macro types that double as
// `Sendable`-friendly value carriers, and the `ModelContainer` lifecycle
// matches the AppContainer pattern we already use. Trade-off is that SwiftData
// is younger than Core Data and has rough edges (limited query DSL, no fully
// async store), but for a small per-user dataset that's not in the way.
//
// Field shapes mirror the wire DTOs in `backend/src/features/sync/schemas.ts`
// (and re-stated in `backend/docs/sync.md`). Same field names, same nullability,
// so the decode → upsert path is mechanical. We use `Date` for timestamps —
// the APIClient's `JSONDecoder` is configured with `.iso8601`, so the wire
// strings deserialize directly without per-field transforms.
//
// Identity:
// - The backend's natural key for `lists` and `items` is a UUID v7 string.
//   We store the raw string (not Foundation's `UUID`) because UUID v7 isn't
//   first-class on `UUID` and we don't want to round-trip through `UUID` for
//   identity comparisons. SwiftData's `@Attribute(.unique)` lets us declare
//   `id: String` as the unique key.
// - `list_members` has the composite (list_id, user_id) primary key. SwiftData
//   doesn't support composite uniques in a clean way, so we synthesize a
//   `compositeId = "\(listId)|\(userId)"` string and mark *that* unique. The
//   "|" separator is safe because UUIDs don't contain pipes. This keeps the
//   upsert logic single-column without inventing a phantom primary key.
//
// Tombstone semantics:
// - `deletedAt: Date?` mirrors the wire shape. A non-nil value is the tombstone
//   signal. Reads in feature code go through helpers (added in slice C) that
//   filter `deletedAt == nil`; the sync reconciler is the only consumer that
//   reads deleted rows.
//
// Sendable / actor isolation:
// - `@Model` types are reference types and not auto-Sendable. SwiftUI views
//   read them on the main actor; the sync reconciler also runs there (the
//   `ModelContainer.mainContext` lives on `@MainActor`). So the actor model
//   is "everything that touches SwiftData lives on @MainActor," same as
//   TokenStore. Slice C will revisit if mutation drainer needs a background
//   `ModelContext`.

// MARK: - User
//
// `UserModel` is more sparse than the others by design. The `/sync` feed does
// NOT currently surface user rows — there's no `/sync/users` endpoint (PLAN.md
// scope: members are referenced by FK, but the user record itself is owned by
// auth flows). For slice B we only persist the *current* signed-in user's
// row, hydrated from `/auth/me`. Other users' display names eventually get
// joined into UI from `list_members.user_id` lookups; for slice B that's not
// rendered.
//
// Why include UserModel at all? The PLAN explicitly calls it out as one of the
// five `@Model` types, and having a slot for "the signed-in user record"
// matches the layered intent — sync engine state and identity state both
// share one container.
@Model
public final class UserModel {
    @Attribute(.unique) public var id: String
    public var email: String
    public var displayName: String
    public var updatedAt: Date

    public init(id: String, email: String, displayName: String, updatedAt: Date) {
        self.id = id
        self.email = email
        self.displayName = displayName
        self.updatedAt = updatedAt
    }
}

// MARK: - List

@Model
public final class ListModel {
    @Attribute(.unique) public var id: String
    public var name: String
    public var createdBy: String
    public var createdAt: Date
    public var updatedAt: Date
    /// Non-nil means this list is a tombstone — the row exists locally only
    /// long enough for the sync reconciler to apply it; reads in feature code
    /// must filter on `deletedAt == nil`.
    public var deletedAt: Date?

    public init(
        id: String,
        name: String,
        createdBy: String,
        createdAt: Date,
        updatedAt: Date,
        deletedAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

// MARK: - Item

@Model
public final class ItemModel {
    @Attribute(.unique) public var id: String
    public var listId: String
    public var text: String
    /// Wire shape from the backend: nullable timestamp (when checked, or nil).
    /// The "is this item checked?" boolean question is `checkedAt != nil`.
    /// Preserving the timestamp lets a future "checked at 4:32pm" UI render
    /// without a schema migration.
    public var checkedAt: Date?
    public var position: Int
    public var createdBy: String
    public var createdAt: Date
    public var updatedAt: Date
    public var deletedAt: Date?

    public init(
        id: String,
        listId: String,
        text: String,
        checkedAt: Date? = nil,
        position: Int,
        createdBy: String,
        createdAt: Date,
        updatedAt: Date,
        deletedAt: Date? = nil
    ) {
        self.id = id
        self.listId = listId
        self.text = text
        self.checkedAt = checkedAt
        self.position = position
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

// MARK: - Member

@Model
public final class MemberModel {
    /// Synthesized unique key: `"\(listId)|\(userId)"`. SwiftData doesn't model
    /// composite uniques cleanly; rather than inventing a phantom UUID we
    /// project the natural composite key into a single string. The "|"
    /// separator is safe because UUIDs don't contain pipes.
    @Attribute(.unique) public var compositeId: String
    public var listId: String
    public var userId: String
    public var role: String
    public var createdAt: Date
    public var updatedAt: Date
    public var deletedAt: Date?

    public init(
        listId: String,
        userId: String,
        role: String,
        createdAt: Date,
        updatedAt: Date,
        deletedAt: Date? = nil
    ) {
        self.compositeId = MemberModel.makeCompositeId(listId: listId, userId: userId)
        self.listId = listId
        self.userId = userId
        self.role = role
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }

    public static func makeCompositeId(listId: String, userId: String) -> String {
        "\(listId)|\(userId)"
    }
}

// MARK: - Sync cursors
//
// The reconciler persists one cursor per resource type so a relaunch or
// foreground tick picks up where the last sync left off. We model cursors as
// rows in SwiftData (rather than UserDefaults) for two reasons:
//
//   1. They're part of the same data set as the rows they describe — backing
//      them up / wiping them happens together. UserDefaults gets cleared
//      independently, which would create a "we have local rows but no cursor"
//      state that causes a redundant full pull at best, conflicts at worst.
//   2. Co-locating cursors with model data lets us atomically reset the cache
//      (e.g., on logout) by deleting the entire ModelContainer's store.

@Model
public final class SyncCursor {
    /// Resource identifier — use `SyncResource.rawValue` as the key. Marked
    /// unique so the reconciler can `upsert` by resource without juggling
    /// duplicate rows.
    @Attribute(.unique) public var resource: String
    public var serverTime: Date

    public init(resource: String, serverTime: Date) {
        self.resource = resource
        self.serverTime = serverTime
    }
}

/// Stable string keys for cursor rows. We avoid persisting raw enum values
/// (Swift can renumber them on schema changes) and pin the wire-style names.
public enum SyncResource: String, CaseIterable, Sendable {
    case lists
    case items
    case listMembers = "list_members"
}

// MARK: - Mutation queue (slice C.2)
//
// `MutationQueueEntry` is the durable record of a pending write. The Mutator
// (see Mutator.swift) appends one row per user action AFTER applying the
// change to the local SwiftData store; the drainer (slice C.3) reads these
// rows, sends the corresponding HTTP request, and removes them on success.
//
// Why durable in SwiftData (rather than in-memory or in UserDefaults):
//   - The user expects their offline writes to survive an app force-quit. A
//     row in the same persistent store as the data it mutates is the only
//     way to guarantee that — UserDefaults gets cleared independently of
//     SwiftData migrations, and an in-memory queue evaporates on relaunch.
//   - Co-locating queue + data in one container lets the Mutator do the
//     local apply and the queue append in the same `context.save()`. If
//     either fails the whole transaction rolls back, so we never leave a
//     local-applied-but-not-queued state (which would silently lose writes
//     to the backend).
//
// Why fields are stringly-typed (`opType`, `payload`, `status`):
//   - SwiftData supports `RawRepresentable` enums via the `@Attribute`
//     transformer, but the surface is rough on Swift 6 strict concurrency
//     — we prefer the explicit string column and convert at use-site.
//   - The `payload` JSON String is the simplest persistent shape that
//     can carry the per-opType body (CreateListPayload vs PatchItemPayload
//     etc). The drainer decodes back to a typed payload before sending.
//   - `status` defaults to "pending"; slice C.3 will flip it to "inFlight"
//     while a request is in-flight and "failed" if a non-409 server error
//     keeps a row from draining (with `lastError` populated for the UI).
//
// Why we DON'T model `MutationOpType` as a SwiftData enum:
//   - SwiftData's enum support requires `Codable + RawRepresentable + String`
//     and trips on Swift 6 strict-concurrency annotations in some 17.x
//     toolchains. The string + typed-helper pattern is what we already use
//     for `SyncResource`, so we stay consistent.
@Model
public final class MutationQueueEntry {
    /// Each queue row has its own UUID v7 — distinct from the `targetId`
    /// of the resource it mutates. Two queue rows for the same target
    /// (e.g. quick double-tap on "check item") are valid; the drainer
    /// processes them in `createdAt` order.
    @Attribute(.unique) public var id: String
    /// One of `MutationOpType.rawValue`. We persist the string (not the
    /// enum) because SwiftData enum migrations are rough on Swift 6 strict
    /// concurrency; `MutationOpType(rawValue:)` is the only conversion seam.
    public var opType: String
    /// The id of the resource being mutated. For create operations this
    /// equals the new resource's id (which is also the body's `id` field
    /// for backend idempotency). For patch/delete this is the existing
    /// resource id.
    public var targetId: String
    /// JSON-encoded payload — one of the `*Payload` Codable types defined
    /// in `Mutator.swift`. The drainer decodes this back into the right
    /// payload type via `MutationOpType` discrimination.
    public var payload: String
    public var createdAt: Date
    /// One of `MutationStatus.rawValue`. New rows are `"pending"`; the
    /// drainer (slice C.3) flips through `"inFlight"` and may end at
    /// `"failed"` if a non-409 error blocks progress.
    public var status: String
    /// 0 on insert. The drainer (slice C.3) increments on retryable
    /// failures; a hard ceiling lets the UI surface "give up" on a row
    /// rather than spinning forever.
    public var retryCount: Int
    /// Last error message shown to UI when `status == "failed"`. Slice C.3
    /// populates this; nil on insert.
    public var lastError: String?

    public init(
        id: String,
        opType: String,
        targetId: String,
        payload: String,
        createdAt: Date,
        status: String = MutationStatus.pending.rawValue,
        retryCount: Int = 0,
        lastError: String? = nil
    ) {
        self.id = id
        self.opType = opType
        self.targetId = targetId
        self.payload = payload
        self.createdAt = createdAt
        self.status = status
        self.retryCount = retryCount
        self.lastError = lastError
    }
}

/// Stable string keys for the queue's `opType` column. Mirrors the six
/// backend write endpoints (slice C.1). The drainer (slice C.3) switches on
/// this to pick the request method + path + payload type.
public enum MutationOpType: String, CaseIterable, Sendable {
    case createList
    case renameList
    case deleteList
    case createItem
    case patchItem
    case deleteItem
}

/// Lifecycle states for a queue row. Stored as `rawValue` strings.
public enum MutationStatus: String, CaseIterable, Sendable {
    /// In the queue, not yet attempted (or retry-eligible after backoff).
    case pending
    /// The drainer has picked it up and is mid-request. Slice C.3 will
    /// guard against picking up an `inFlight` row twice.
    case inFlight
    /// The drainer hit a permanent error (non-409, or 409 reconciliation
    /// failed). The row stays for UI inspection until the user explicitly
    /// clears it (slice D may add a "retry/discard" UI).
    case failed
}
