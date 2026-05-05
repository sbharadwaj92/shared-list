import Foundation
import SwiftData

// SyncEngine — slice B (read-side only).
//
// Single responsibility for this slice: pull `/sync/lists`, `/sync/items`,
// and `/sync/list_members` from the backend in that order, reconcile each
// batch into SwiftData, and persist a per-resource `serverTime` cursor so the
// next reconcile picks up where this one left off.
//
// What slice B does NOT do (intentional cut):
//   - No mutation queue. We never write to the backend; only read.
//   - No LWW conflict resolution beyond "newer updatedAt wins on upsert."
//     Concurrent edits can't happen yet because there are no edits.
//   - No retry / backoff. A failed reconcile throws; the next call site
//     retries.
//   - No background scheduling. Reconciles happen at well-defined call sites
//     (login completion, app foreground) which the AppContainer drives.
//
// All of that is slice C territory.
//
// Why the resource order matters (lists → items → members):
//   - Lists arrive first so their UI placeholder rows exist before items try
//     to attach to them visually.
//   - Items second so any locally-cached items in a now-deleted list will
//     have a parent to drop.
//   - Members LAST so a self-revocation tombstone (which sweeps the local
//     list + items + other members) runs after any leftover rows have landed.
//     Putting it earlier would race the items pull and leave orphan items
//     visible for one tick.
//   This is the same ordering recommended by `backend/docs/sync.md`.
//
// Tombstone application:
//   - For lists: a row with `deletedAt != nil` causes us to delete the local
//     `ListModel` if present. Items and members of that list are NOT swept
//     here — they'll arrive as tombstones in their own feeds (the backend
//     cascades soft-deletes in app code, see PLAN.md L177). This separation
//     keeps each feed self-consistent.
//   - For items: same — delete the local `ItemModel`.
//   - For members: a `userId == self` tombstone is the revocation signal.
//     We delete the local `MemberModel`, AND the local `ListModel`, AND any
//     local `ItemModel`s belonging to that list. The other-member case just
//     deletes the `MemberModel`.
//
// MainActor isolation:
//   Everything in this engine runs on @MainActor because SwiftData's
//   `mainContext` is main-actor-bound. The HTTP send via APIClient hops off
//   for the network call and hops back; we await it from main actor. Slice C
//   may introduce a background `ModelContext` for the drainer, but for
//   read-side reconciliation the volume is small enough that staying on main
//   is fine and keeps SwiftUI consumers free of cross-actor reads.
//
// Self user id:
//   The members feed's revocation logic needs to know "is this me?" — for
//   that we read `auth.currentUserId` lazily at reconcile time. If no user
//   is signed in, `reconcile()` is a no-op early-out (there's nothing to
//   sync against an unauthenticated session).

public enum SyncEngineError: Error, Sendable {
    /// `reconcile()` was called while no user is authenticated. Call sites
    /// should gate on `auth.isAuthenticated` before invoking; surfacing this
    /// as an explicit error makes accidental calls visible in logs.
    case notAuthenticated
    /// One of the three feed pulls failed. Wraps the underlying APIError /
    /// network error so call sites can decide whether to retry.
    case feedFailed(resource: SyncResource, underlying: any Error)
}

@MainActor
public final class SyncEngine {
    private let api: APIClient
    private let container: ModelContainer
    private let monitor: any NetworkMonitoring
    /// Lazy lookup of the current user id — slice C will use this when
    /// queueing mutations; slice B uses it to recognize self-revocation in
    /// the members feed. We pass a closure so the engine doesn't have to
    /// take a hard dep on AuthService.
    private let currentUserId: @MainActor () -> String?

    public init(
        api: APIClient,
        container: ModelContainer,
        monitor: any NetworkMonitoring,
        currentUserId: @escaping @MainActor () -> String?
    ) {
        self.api = api
        self.container = container
        self.monitor = monitor
        self.currentUserId = currentUserId
    }

    /// Pull all three feeds in order, applying updates and tombstones. Throws
    /// on the first feed failure (no partial-success silent swallowing). Call
    /// sites: app foreground, post-login, slice-C will add WS-reconnect.
    public func reconcile() async throws {
        guard let userId = currentUserId() else {
            throw SyncEngineError.notAuthenticated
        }
        guard monitor.isOnline else {
            // Offline-aware bail: not an error, just a no-op. The caller's
            // expectation is "if the network is up, get me current state";
            // throwing here would surface as a misleading "sync failed" in
            // UI. Slice C will add a `lastReconciledAt` indicator to make
            // the offline case visible without throwing.
            return
        }

        try await reconcileLists()
        try await reconcileItems()
        try await reconcileListMembers(selfUserId: userId)
    }

    // MARK: - Per-feed reconcilers
    //
    // Each follows the same shape: read the cursor, build the URL with
    // `?since=<cursor>` if present, decode the response, upsert / tombstone
    // every row, persist the new cursor. Extracted into separate methods
    // (rather than a generic helper) because the upsert step is row-type-
    // specific and pulling it through generics added more friction than the
    // duplication saves at three resources.

    private func reconcileLists() async throws {
        let cursor = readCursor(.lists)
        let path = pathWithSince("/sync/lists", since: cursor)
        let response: SyncListsResponse
        do {
            response = try await api.send(method: "GET", path: path, body: EmptyBody())
        } catch {
            throw SyncEngineError.feedFailed(resource: .lists, underlying: error)
        }

        let context = container.mainContext
        for row in response.rows {
            if row.deletedAt != nil {
                try deleteLocalList(id: row.id, in: context)
            } else {
                try upsertList(from: row, in: context)
            }
        }
        try writeCursor(.lists, serverTime: response.serverTime, in: context)
        try context.save()
    }

    private func reconcileItems() async throws {
        let cursor = readCursor(.items)
        let path = pathWithSince("/sync/items", since: cursor)
        let response: SyncItemsResponse
        do {
            response = try await api.send(method: "GET", path: path, body: EmptyBody())
        } catch {
            throw SyncEngineError.feedFailed(resource: .items, underlying: error)
        }

        let context = container.mainContext
        for row in response.rows {
            if row.deletedAt != nil {
                try deleteLocalItem(id: row.id, in: context)
            } else {
                try upsertItem(from: row, in: context)
            }
        }
        try writeCursor(.items, serverTime: response.serverTime, in: context)
        try context.save()
    }

    private func reconcileListMembers(selfUserId: String) async throws {
        let cursor = readCursor(.listMembers)
        let path = pathWithSince("/sync/list_members", since: cursor)
        let response: SyncListMembersResponse
        do {
            response = try await api.send(method: "GET", path: path, body: EmptyBody())
        } catch {
            throw SyncEngineError.feedFailed(resource: .listMembers, underlying: error)
        }

        let context = container.mainContext
        for row in response.rows {
            if row.deletedAt != nil {
                if row.userId == selfUserId {
                    // Self-revocation: drop the local list + items + members.
                    try sweepLocalList(listId: row.listId, in: context)
                } else {
                    try deleteLocalMember(listId: row.listId, userId: row.userId, in: context)
                }
            } else {
                try upsertMember(from: row, in: context)
            }
        }
        try writeCursor(.listMembers, serverTime: response.serverTime, in: context)
        try context.save()
    }

    // MARK: - Cursor helpers
    //
    // Cursors live in `SyncCursor` rows. Reading: a missing row means
    // "first sync ever" — we omit `?since=` and the backend defaults to
    // epoch. Writing: upsert by resource key.

    private func readCursor(_ resource: SyncResource) -> Date? {
        let context = container.mainContext
        let resourceKey = resource.rawValue
        var descriptor = FetchDescriptor<SyncCursor>(
            predicate: #Predicate { $0.resource == resourceKey }
        )
        descriptor.fetchLimit = 1
        do {
            return try context.fetch(descriptor).first?.serverTime
        } catch {
            // A failed cursor read is non-fatal — falling back to nil pulls
            // everything from epoch, which is correct (if slow) recovery.
            // This branch should be unreachable in practice (FetchDescriptor
            // failures imply corrupt store), so we don't try to be clever.
            return nil
        }
    }

    private func writeCursor(
        _ resource: SyncResource,
        serverTime: Date,
        in context: ModelContext
    ) throws {
        let resourceKey = resource.rawValue
        var descriptor = FetchDescriptor<SyncCursor>(
            predicate: #Predicate { $0.resource == resourceKey }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            existing.serverTime = serverTime
        } else {
            context.insert(SyncCursor(resource: resource.rawValue, serverTime: serverTime))
        }
    }

    private func pathWithSince(_ basePath: String, since: Date?) -> String {
        guard let since else { return basePath }
        // ISO8601 with millisecond fraction matches what the backend emits
        // and what its Zod `.datetime({ offset: true })` validator accepts.
        // The `.iso8601` format style defaults to second precision; the
        // explicit `time(includingFractionalSeconds: true)` puts the `.SSS`
        // fragment back so cursor round-trip is lossless.
        let formatted = since.formatted(.iso8601.year().month().day()
            .dateSeparator(.dash).time(includingFractionalSeconds: true)
            .timeSeparator(.colon).timeZone(separator: .omitted))
        // Build the URL via URLComponents so any characters that legally
        // require percent-encoding in a query value are escaped per
        // RFC 3986. Foundation does NOT aggressively encode `:` (it's a
        // valid "sub-delim" in query values per spec) and Hono parses
        // either form correctly — see backend integration tests + the
        // manual curl walkthrough during slice A. Manual
        // `addingPercentEncoding` was attempted earlier but `urlQueryAllowed`
        // is too permissive for path segments and there's no built-in
        // "query value" character set on iOS, so URLComponents is the
        // right path even though some humans expect more escaping than RFC.
        var components = URLComponents()
        components.path = basePath
        components.queryItems = [URLQueryItem(name: "since", value: formatted)]
        // Pull just the path-and-query portion back out — we want a relative
        // path that APIClient resolves against `baseURL`, not an absolute URL.
        let path = components.path
        let query = components.percentEncodedQuery ?? ""
        return query.isEmpty ? path : "\(path)?\(query)"
    }

    // MARK: - Upsert + tombstone helpers

    private func upsertList(from dto: ListDTO, in context: ModelContext) throws {
        let id = dto.id
        var descriptor = FetchDescriptor<ListModel>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            // LWW guard: only overwrite when the wire row is strictly newer.
            // Without this, a same-tick re-pull (rare but possible if the
            // cursor sliced exactly here) would still touch the local row
            // and bump SwiftData's change tracker spuriously.
            if dto.updatedAt > existing.updatedAt {
                existing.name = dto.name
                existing.createdBy = dto.createdBy
                existing.updatedAt = dto.updatedAt
                existing.deletedAt = dto.deletedAt
            }
        } else {
            context.insert(ListModel(
                id: dto.id,
                name: dto.name,
                createdBy: dto.createdBy,
                createdAt: dto.createdAt,
                updatedAt: dto.updatedAt,
                deletedAt: dto.deletedAt
            ))
        }
    }

    private func deleteLocalList(id: String, in context: ModelContext) throws {
        var descriptor = FetchDescriptor<ListModel>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            context.delete(existing)
        }
        // Note: items belonging to this list will arrive as their own
        // tombstones via /sync/items. We don't sweep them here — keeping each
        // feed self-consistent makes the reconciler easier to reason about
        // (and tested without cross-feed dependencies). The brief window
        // between "list disappears" and "items disappear" is one reconcile
        // cycle in length and not user-visible because feature views read
        // through helpers that filter `deletedAt == nil`.
    }

    private func upsertItem(from dto: ItemDTO, in context: ModelContext) throws {
        let id = dto.id
        var descriptor = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            if dto.updatedAt > existing.updatedAt {
                existing.listId = dto.listId
                existing.text = dto.text
                existing.checkedAt = dto.checkedAt
                existing.position = dto.position
                existing.createdBy = dto.createdBy
                existing.updatedAt = dto.updatedAt
                existing.deletedAt = dto.deletedAt
            }
        } else {
            context.insert(ItemModel(
                id: dto.id,
                listId: dto.listId,
                text: dto.text,
                checkedAt: dto.checkedAt,
                position: dto.position,
                createdBy: dto.createdBy,
                createdAt: dto.createdAt,
                updatedAt: dto.updatedAt,
                deletedAt: dto.deletedAt
            ))
        }
    }

    private func deleteLocalItem(id: String, in context: ModelContext) throws {
        var descriptor = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            context.delete(existing)
        }
    }

    private func upsertMember(from dto: ListMemberDTO, in context: ModelContext) throws {
        let composite = MemberModel.makeCompositeId(listId: dto.listId, userId: dto.userId)
        var descriptor = FetchDescriptor<MemberModel>(
            predicate: #Predicate { $0.compositeId == composite }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            if dto.updatedAt > existing.updatedAt {
                existing.role = dto.role
                existing.updatedAt = dto.updatedAt
                existing.deletedAt = dto.deletedAt
            }
        } else {
            context.insert(MemberModel(
                listId: dto.listId,
                userId: dto.userId,
                role: dto.role,
                createdAt: dto.createdAt,
                updatedAt: dto.updatedAt,
                deletedAt: dto.deletedAt
            ))
        }
    }

    private func deleteLocalMember(
        listId: String,
        userId: String,
        in context: ModelContext
    ) throws {
        let composite = MemberModel.makeCompositeId(listId: listId, userId: userId)
        var descriptor = FetchDescriptor<MemberModel>(
            predicate: #Predicate { $0.compositeId == composite }
        )
        descriptor.fetchLimit = 1
        if let existing = try context.fetch(descriptor).first {
            context.delete(existing)
        }
    }

    /// Self-revocation sweep: when our own membership for a list is
    /// tombstoned, the entire local presence of that list (the list itself,
    /// its items, every member row) must be cleared. The user no longer has
    /// access to that list and we shouldn't keep stale state around.
    ///
    /// Distinct from `deleteLocalList` which is the "list itself was
    /// soft-deleted on the server" path: there, items + members will arrive
    /// via their own feeds. Here, we won't see those rows because we no
    /// longer have membership — so we have to sweep proactively.
    private func sweepLocalList(listId: String, in context: ModelContext) throws {
        // Items first — purely cosmetic: lets a future debug build inspect
        // the order in console logs and see the bottom-up sweep. SwiftData
        // doesn't enforce delete order beyond what cascade rules say (we
        // don't model relationships, so each delete is independent).
        var itemDesc = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.listId == listId }
        )
        itemDesc.fetchLimit = 10_000  // de-facto unbounded for v1's data sizes
        for row in try context.fetch(itemDesc) {
            context.delete(row)
        }

        var memberDesc = FetchDescriptor<MemberModel>(
            predicate: #Predicate { $0.listId == listId }
        )
        memberDesc.fetchLimit = 10_000
        for row in try context.fetch(memberDesc) {
            context.delete(row)
        }

        var listDesc = FetchDescriptor<ListModel>(
            predicate: #Predicate { $0.id == listId }
        )
        listDesc.fetchLimit = 1
        if let existing = try context.fetch(listDesc).first {
            context.delete(existing)
        }
    }
}
