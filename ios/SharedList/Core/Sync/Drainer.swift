import Foundation
import SwiftData

// Drainer — slice C.3.
//
// The drainer is the back half of the offline-first write loop. Slice C.2
// gave us the `Mutator`, which applies every user action to the local
// SwiftData store optimistically AND appends a `MutationQueueEntry`. This
// file consumes those entries: pick the oldest pending row, decode its
// payload, build the right HTTP request against the slice-C.1 backend,
// react to the response, repeat until the queue is empty (or we hit a
// reason to stop).
//
// Sequencing model:
//   - Serial drain. One in-flight HTTP request at a time per drainer
//     instance. PLAN.md and the slice-C scope agree: parallelism is a
//     backend-throughput concern that has no measurable upside at 3
//     users / single-Mac backend, and serial drain keeps the merge logic
//     for 409→reconcile→retry trivially correct. We can revisit if a
//     fuzz test in slice D ever shows real waiting.
//   - Single-flight via `isDraining` flag inside `tick()`. Multiple
//     `kick()` calls during a drain coalesce — the in-flight tick will
//     re-check the queue at its tail and keep going if more rows landed.
//
// Triggers (wired by AppContainer):
//   1. Mutator post-call. After the Mutator commits a queue entry, it
//      calls `kick()`. If we're online, the drain starts immediately;
//      the user perceives "applied locally and synced to server" as one
//      atomic action.
//   2. NetworkMonitor going online. When the OS reports we're back on a
//      satisfied path, kick — any rows accumulated while offline drain.
//   3. App foreground. Same idea: the existing SyncEngine reconcile path
//      already kicks on foreground, and we add a drain kick alongside it.
//
// Status code handling:
//   - 2xx → delete the queue row. Idempotent POST returns 200 instead of
//     201 on retry; the Drainer treats both the same (success-shape).
//   - 401 → trust APIClient's single-flight refresh, which already
//     retries the underlying request. If the retried response is still
//     401 (refresh failed), we treat as transient and re-queue.
//   - 404 on PATCH/DELETE → the resource is gone server-side. For
//     DELETE this is success-shape (idempotent). For PATCH it means the
//     row was tombstoned out from under us — apply a local tombstone via
//     the SyncEngine helpers and remove the queue entry.
//   - 403 → the caller lost membership. Mark `failed`; the next reconcile
//     will sweep the local list via the membership feed's revocation
//     path.
//   - 409 on POST (id collision with tombstone) → mark `failed`. The
//     client's id-generator should never re-use, so this is a pathological
//     case; surface it instead of spinning.
//   - 409 on PATCH → reconcile + retry. See the dedicated method below.
//   - Other 4xx → mark `failed` with the server's `lastError` populated
//     so a future UI inspector can show what went wrong.
//   - 5xx + network errors → re-queue. Increment `retryCount`, leave the
//     row at `pending`. Slice D may add jittered backoff; for C.3 we just
//     bail the current tick and rely on the next kick (foreground, online
//     transition, next user action) to retry.
//
// The 409→reconcile→retry-once pattern:
//   When a PATCH returns 409 with `{error, latest: …DTO}`, the right
//   sequence is:
//   1. Decode the body's `latest` row.
//   2. Apply it through the SyncEngine's existing upsert helpers — the
//      LWW guard there merges server truth with our optimistic state.
//   3. Re-read the local row (now the LWW winner) and rebuild the
//      payload with the new `If-Match` value.
//   4. Send once more.
//   If the second send also 409s, it means another device is rapidly
//   editing the same row. Spinning would just generate noise; we mark
//   the row `failed` and let the user (eventually, in a future UI slice)
//   resolve the conflict manually. PLAN.md L195 is explicit that LWW is
//   the v1 conflict-resolution strategy and doesn't require us to
//   implement merge UX.
//
// Stale `inFlight` reset:
//   If the app crashes (or is force-quit) mid-request, a queue row may
//   be left at `inFlight`. On the next Drainer init we sweep those back
//   to `pending` so they get retried. Without this, a stale `inFlight`
//   would never drain (the live drainer only picks up `pending` rows).

@MainActor
public final class Drainer {
    private let api: APIClient
    private let container: ModelContainer
    private let monitor: any NetworkMonitoring
    private let syncEngine: SyncEngine
    private var isDraining: Bool = false

    public init(
        api: APIClient,
        container: ModelContainer,
        monitor: any NetworkMonitoring,
        syncEngine: SyncEngine
    ) {
        self.api = api
        self.container = container
        self.monitor = monitor
        self.syncEngine = syncEngine
        // Reset any rows left at `inFlight` from a prior crash/force-quit.
        // The live drainer only picks up `pending` rows, so without this
        // sweep a stale `inFlight` would never drain.
        try? resetStaleInFlight()
    }

    /// External entry point. Multiple kicks during an in-flight drain
    /// coalesce — the in-flight tick re-checks the queue at its tail and
    /// keeps going if more rows landed. The bool guard means callers
    /// don't need their own "am I already draining?" coordination.
    public func kick() {
        guard !isDraining else { return }
        guard monitor.isOnline else {
            // Offline-aware bail: not an error, just a no-op. Next online
            // transition will kick again.
            #if DEBUG
            print("[Drain] kick skipped — offline")
            #endif
            return
        }
        Task { @MainActor [weak self] in
            await self?.tick()
        }
    }

    /// Process pending rows until the queue is empty or we hit a non-
    /// transient stop reason. Internal so tests can drive it directly
    /// without going through the kick → Task hop.
    ///
    /// Per-tick stop conditions:
    ///   - Queue is empty.
    ///   - We went offline mid-tick.
    ///   - The current row's drain re-queued it (transient failure). We
    ///     break instead of looping back to the same row immediately,
    ///     because (a) the next attempt would just hit the same backend
    ///     state and burn a retry, and (b) without this we'd spin
    ///     indefinitely on a persistent network outage. The next kick
    ///     (foreground, online transition, next user action) gets us
    ///     back to it. Slice D's jittered backoff will refine this.
    func tick() async {
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }

        while monitor.isOnline {
            guard let entry = try? takeNextPending() else {
                // Either no rows or a fetch error. Either way, stop the
                // tick; the next kick will pick up from here.
                return
            }
            let entryId = entry.id
            do {
                try await drain(entry: entry)
            } catch {
                // `drain` already wrote the row's terminal status. Any
                // throw here is a programmer error (e.g. payload decode
                // failure) — log in DEBUG, leave the row marked failed,
                // and continue with the next entry.
                #if DEBUG
                print("[Drain] entry \(entryId) failed: \(error)")
                #endif
            }
            // Did we end up requeueing this entry (transient failure)?
            // If so, break out of the tick instead of immediately
            // re-picking the same row — see method header.
            if (try? entryStillPending(id: entryId)) == true {
                break
            }
        }
    }

    /// Returns true if the row with the given id is still in the
    /// `pending` queue after the drain attempt — meaning we requeued it
    /// (transient failure). Used by `tick()` to decide whether to break
    /// the loop and wait for the next kick.
    private func entryStillPending(id: String) throws -> Bool {
        let context = container.mainContext
        let pending = MutationStatus.pending.rawValue
        var descriptor = FetchDescriptor<MutationQueueEntry>(
            predicate: #Predicate { $0.id == id && $0.status == pending }
        )
        descriptor.fetchLimit = 1
        return try !context.fetch(descriptor).isEmpty
    }

    // MARK: - Per-entry dispatch

    private func drain(entry: MutationQueueEntry) async throws {
        // Translate the stored opType to a real enum case. An unknown
        // value is a programmer error (someone added an opType to the
        // enum without handling it here, or wrote a hand-crafted row).
        // Mark the row failed so it doesn't keep blocking the queue.
        guard let opType = MutationOpType(rawValue: entry.opType) else {
            try markFailed(entry: entry, reason: "unknown opType: \(entry.opType)")
            return
        }
        switch opType {
        case .createList:
            try await drainCreateList(entry: entry)
        case .renameList:
            try await drainRenameList(entry: entry)
        case .deleteList:
            try await drainDeleteList(entry: entry)
        case .createItem:
            try await drainCreateItem(entry: entry)
        case .patchItem:
            try await drainPatchItem(entry: entry)
        case .deleteItem:
            try await drainDeleteItem(entry: entry)
        }
    }

    // MARK: - createList

    private func drainCreateList(entry: MutationQueueEntry) async throws {
        let payload = try decode(CreateListPayload.self, json: entry.payload)
        do {
            let (_, status) = try await api.sendRaw(
                method: "POST",
                path: "/lists",
                body: payload
            )
            switch status {
            case 200, 201:
                try removeEntry(entry)
            case 409:
                // Soft-deleted-id collision on the server (slice C.1
                // contract). Pathological — clients shouldn't reuse ids.
                // Mark failed so the user can see something went wrong.
                try markFailed(entry: entry, reason: "id collides with a deleted list")
            default:
                try handleNonSuccess(entry: entry, status: status, data: nil)
            }
        } catch {
            try handleTransport(entry: entry, error: error)
        }
    }

    // MARK: - renameList

    private func drainRenameList(entry: MutationQueueEntry) async throws {
        let payload = try decode(RenameListPayload.self, json: entry.payload)
        let path = "/lists/\(entry.targetId)"

        let (firstData, firstStatus): (Data, Int)
        do {
            (firstData, firstStatus) = try await sendPatchWithIfMatch(
                path: path,
                body: PatchListBody(name: payload.name),
                ifMatch: payload.ifMatch
            )
        } catch {
            try handleTransport(entry: entry, error: error)
            return
        }

        switch firstStatus {
        case 200:
            try removeEntry(entry)
        case 404:
            // Server says the list is gone. The next reconcile will sweep
            // the local row via the `?since=` tombstone feed; we drop the
            // queue entry now since there's nothing to retry.
            try removeEntry(entry)
        case 409:
            // Reconcile + retry. Apply the server's `latest` row through
            // SyncEngine's LWW upsert (the existing guard merges server
            // truth with our optimistic edits), then re-read the local
            // row and send the merged state back.
            let conflict: ConflictBody<ListDTO>
            do {
                conflict = try api.responseDecoder.decode(
                    ConflictBody<ListDTO>.self,
                    from: firstData
                )
            } catch {
                try markFailed(entry: entry, reason: "409 body undecodable: \(error)")
                return
            }
            let context = container.mainContext
            try syncEngine.upsertListForDrainer(from: conflict.latest, in: context)
            try context.save()

            let id = entry.targetId
            var descriptor = FetchDescriptor<ListModel>(
                predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
            )
            descriptor.fetchLimit = 1
            guard let local = try context.fetch(descriptor).first else {
                // Local row vanished between the 409 response and the
                // rebuild — likely the user deleted it. Drop the queue
                // entry; the delete will propagate via its own entry.
                try removeEntry(entry)
                return
            }

            let (secondData, secondStatus): (Data, Int)
            do {
                (secondData, secondStatus) = try await sendPatchWithIfMatch(
                    path: path,
                    body: PatchListBody(name: local.name),
                    ifMatch: local.updatedAt
                )
            } catch {
                try handleTransport(entry: entry, error: error)
                return
            }
            try handleSecondAttempt(
                entry: entry,
                status: secondStatus,
                data: secondData
            )
        default:
            try handleNonSuccess(entry: entry, status: firstStatus, data: firstData)
        }
    }

    // MARK: - deleteList

    private func drainDeleteList(entry: MutationQueueEntry) async throws {
        do {
            let (_, status) = try await api.sendRaw(
                method: "DELETE",
                path: "/lists/\(entry.targetId)",
                body: EmptyBody()
            )
            switch status {
            case 204:
                try removeEntry(entry)
            case 404:
                // Already deleted server-side (idempotent). Treat as
                // success and remove the entry.
                try removeEntry(entry)
            default:
                try handleNonSuccess(entry: entry, status: status, data: nil)
            }
        } catch {
            try handleTransport(entry: entry, error: error)
        }
    }

    // MARK: - createItem

    private func drainCreateItem(entry: MutationQueueEntry) async throws {
        let payload = try decode(CreateItemPayload.self, json: entry.payload)
        // The Mutator's payload doesn't carry the listId — we look it up
        // from the local item row. The local row was inserted in the same
        // transaction as the queue entry (slice C.2's atomicity contract),
        // so it must exist unless the user has soft-deleted the item
        // before the drainer ran.
        let listId: String
        let context = container.mainContext
        let id = entry.targetId
        var itemDescriptor = FetchDescriptor<ItemModel>(
            predicate: #Predicate { $0.id == id }
        )
        itemDescriptor.fetchLimit = 1
        if let row = try context.fetch(itemDescriptor).first {
            listId = row.listId
        } else {
            // Item row vanished (force-quit between Mutator and Drainer
            // would leave the queue entry behind, but the SwiftData
            // commit was atomic so this is implausible). Treat as a
            // permanent failure rather than guess at a listId.
            try markFailed(entry: entry, reason: "local item row missing for queued create")
            return
        }
        do {
            let (_, status) = try await api.sendRaw(
                method: "POST",
                path: "/lists/\(listId)/items",
                body: payload
            )
            switch status {
            case 200, 201:
                try removeEntry(entry)
            case 409:
                try markFailed(entry: entry, reason: "id collides with a deleted item")
            default:
                try handleNonSuccess(entry: entry, status: status, data: nil)
            }
        } catch {
            try handleTransport(entry: entry, error: error)
        }
    }

    // MARK: - patchItem

    private func drainPatchItem(entry: MutationQueueEntry) async throws {
        let payload = try decode(PatchItemPayload.self, json: entry.payload)
        let path = "/items/\(entry.targetId)"

        let (firstData, firstStatus): (Data, Int)
        do {
            (firstData, firstStatus) = try await sendPatchWithIfMatch(
                path: path,
                body: payload.toWireBody(),
                ifMatch: payload.ifMatch
            )
        } catch {
            try handleTransport(entry: entry, error: error)
            return
        }

        switch firstStatus {
        case 200:
            try removeEntry(entry)
        case 404:
            try removeEntry(entry)
        case 409:
            let conflict: ConflictBody<ItemDTO>
            do {
                conflict = try api.responseDecoder.decode(
                    ConflictBody<ItemDTO>.self,
                    from: firstData
                )
            } catch {
                try markFailed(entry: entry, reason: "409 body undecodable: \(error)")
                return
            }
            let context = container.mainContext
            try syncEngine.upsertItemForDrainer(from: conflict.latest, in: context)
            try context.save()

            let id = entry.targetId
            var descriptor = FetchDescriptor<ItemModel>(
                predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
            )
            descriptor.fetchLimit = 1
            guard let local = try context.fetch(descriptor).first else {
                try removeEntry(entry)
                return
            }
            // Rebuild the patch body from the current local row (post-
            // LWW-merge). We send all fields here even though the
            // original patch may have only touched a subset — simpler and
            // correct, since the values match the local truth either way.
            let rebuiltBody = PatchItemWireBody(
                text: local.text,
                position: local.position,
                checked: local.checkedAt
            )
            let (secondData, secondStatus): (Data, Int)
            do {
                (secondData, secondStatus) = try await sendPatchWithIfMatch(
                    path: path,
                    body: rebuiltBody,
                    ifMatch: local.updatedAt
                )
            } catch {
                try handleTransport(entry: entry, error: error)
                return
            }
            try handleSecondAttempt(
                entry: entry,
                status: secondStatus,
                data: secondData
            )
        default:
            try handleNonSuccess(entry: entry, status: firstStatus, data: firstData)
        }
    }

    // MARK: - deleteItem

    private func drainDeleteItem(entry: MutationQueueEntry) async throws {
        do {
            let (_, status) = try await api.sendRaw(
                method: "DELETE",
                path: "/items/\(entry.targetId)",
                body: EmptyBody()
            )
            switch status {
            case 204, 404:
                try removeEntry(entry)
            default:
                try handleNonSuccess(entry: entry, status: status, data: nil)
            }
        } catch {
            try handleTransport(entry: entry, error: error)
        }
    }

    /// Shared HTTP send for both rename + patch — same shape (PATCH with
    /// If-Match), different bodies. Status handling is per-caller because
    /// the 409 path needs to decode + apply a resource-typed `latest`
    /// (ListDTO vs ItemDTO), and pushing that through opaque Sendable
    /// closures fights Swift 6 strict concurrency for no real benefit
    /// over the inline pattern in each caller.
    private func sendPatchWithIfMatch<Body: Encodable & Sendable>(
        path: String,
        body: Body,
        ifMatch: Date
    ) async throws -> (Data, Int) {
        let formattedIfMatch = ifMatch.iso8601MillisString()
        return try await api.sendRaw(
            method: "PATCH",
            path: path,
            body: body,
            extraHeaders: ["If-Match": formattedIfMatch]
        )
    }

    /// Status handling for the SECOND attempt of a PATCH after a 409 →
    /// reconcile → retry sequence. Same shape for both rename + patch:
    /// 200 / 404 = success, 409 = repeated conflict (mark failed, no
    /// further retry — repeated 409s mean an edit war and surfacing
    /// beats spinning per PLAN.md L195), other statuses route through
    /// the standard non-success handler.
    private func handleSecondAttempt(
        entry: MutationQueueEntry,
        status: Int,
        data: Data
    ) throws {
        switch status {
        case 200, 404:
            try removeEntry(entry)
        case 409:
            try markFailed(entry: entry, reason: "concurrent edits, manual resolution needed")
        default:
            try handleNonSuccess(entry: entry, status: status, data: data)
        }
    }

    // MARK: - Status / transport handling

    private func handleNonSuccess(
        entry: MutationQueueEntry,
        status: Int,
        data: Data?
    ) throws {
        switch status {
        case 401:
            // APIClient's single-flight refresh path already retried; if
            // we still see 401 here, refresh failed. Treat as transient
            // — the next kick after the user re-authenticates will retry.
            try requeue(entry: entry, reason: "auth refresh failed")
        case 403:
            try markFailed(entry: entry, reason: "membership lost (403)")
        case 500..<600:
            try requeue(entry: entry, reason: "server \(status)")
        default:
            // Other 4xx — mark failed with whatever the server said.
            let message = data.flatMap { String(data: $0, encoding: .utf8) } ?? "status \(status)"
            try markFailed(entry: entry, reason: "permanent error (\(status)): \(message)")
        }
    }

    private func handleTransport(entry: MutationQueueEntry, error: any Error) throws {
        // Network errors — connection lost, DNS fail, TLS handshake
        // timeout. Re-queue for the next kick.
        try requeue(entry: entry, reason: "transport: \(error)")
    }

    // MARK: - Queue mutation

    /// Pop the oldest pending row, flip its status to `inFlight` in the
    /// same save. Subsequent calls won't see it until we either remove
    /// the entry (on success) or flip it back to `pending` (transient
    /// failure) / `failed` (permanent).
    private func takeNextPending() throws -> MutationQueueEntry? {
        let context = container.mainContext
        let pending = MutationStatus.pending.rawValue
        var descriptor = FetchDescriptor<MutationQueueEntry>(
            predicate: #Predicate { $0.status == pending },
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        descriptor.fetchLimit = 1
        guard let entry = try context.fetch(descriptor).first else { return nil }
        entry.status = MutationStatus.inFlight.rawValue
        try context.save()
        return entry
    }

    private func removeEntry(_ entry: MutationQueueEntry) throws {
        let context = container.mainContext
        context.delete(entry)
        try context.save()
    }

    private func requeue(entry: MutationQueueEntry, reason: String) throws {
        let context = container.mainContext
        entry.status = MutationStatus.pending.rawValue
        entry.retryCount += 1
        entry.lastError = reason
        try context.save()
    }

    private func markFailed(entry: MutationQueueEntry, reason: String) throws {
        let context = container.mainContext
        entry.status = MutationStatus.failed.rawValue
        entry.lastError = reason
        try context.save()
    }

    private func resetStaleInFlight() throws {
        let context = container.mainContext
        let inFlight = MutationStatus.inFlight.rawValue
        let descriptor = FetchDescriptor<MutationQueueEntry>(
            predicate: #Predicate { $0.status == inFlight }
        )
        let stale = try context.fetch(descriptor)
        for entry in stale {
            entry.status = MutationStatus.pending.rawValue
        }
        if !stale.isEmpty {
            try context.save()
        }
    }

    // MARK: - Decoding

    private func decode<T: Decodable>(_ type: T.Type, json: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: Data(json.utf8))
    }
}

// MARK: - Wire bodies for write endpoints
//
// The drainer sends bodies that match the slice-C.1 backend's Zod schemas.
// We keep them here (rather than bundle into SyncDTOs.swift) because
// they're write-side request bodies; the read-side response DTOs live
// alongside the read feed.

/// PATCH /lists/:id body — only `name` is patchable in slice C.1.
public struct PatchListBody: Codable, Sendable, Equatable {
    public let name: String
    public init(name: String) { self.name = name }
}

/// PATCH /items/:id wire body. The `Mutator`'s `PatchItemPayload` already
/// handles the 3-state JSON encoding of `checked`; for the drainer's
/// rebuild path (where we send the LWW-merged local row) we use this
/// simpler shape because the local row stores `checkedAt` as a plain
/// `Date?` — there's no "leave alone" case at this point, only "is the
/// item currently checked?". `nil` here serializes as the JSON literal
/// `null` (Swift's JSONEncoder default), which the backend reads as
/// "explicitly clear the column" — matching what the local row says.
public struct PatchItemWireBody: Codable, Sendable, Equatable {
    public let text: String
    public let position: Int
    public let checked: Date?

    public init(text: String, position: Int, checked: Date?) {
        self.text = text
        self.position = position
        self.checked = checked
    }
}

extension PatchItemPayload {
    /// Convert the Mutator's 3-state-aware payload into the wire body
    /// the backend's PATCH /items/:id endpoint expects. The `checked`
    /// 3-state collapses to the original behavior at the wire level
    /// because `JSONEncoder` already encodes `Date?` as either an ISO
    /// string or `null` — but the absent vs. null distinction MUST be
    /// preserved. `JSONEncoder.OutputFormatting` doesn't help here, so
    /// we hand-encode in the original payload's `encode(to:)` and
    /// keep the wire body separate.
    func toWireBody() -> PatchItemDispatchBody {
        var body = PatchItemDispatchBody()
        body.text = text
        body.position = position
        switch checked {
        case .leaveAlone: break  // omit the field
        case .none: body.checkedExplicitlyNull = true
        case .some(let date): body.checked = date
        }
        return body
    }
}

/// Hand-rolled wire body for PATCH /items/:id that preserves the 3-state
/// `checked` encoding (omit / null / timestamp) when the drainer first
/// sends a queued `PatchItemPayload`. Distinct from `PatchItemWireBody`
/// because that one is for the rebuild path (where we always send all
/// fields from local truth) and doesn't need the omit case.
public struct PatchItemDispatchBody: Encodable, Sendable {
    public var text: String?
    public var position: Int?
    public var checked: Date?
    public var checkedExplicitlyNull: Bool = false

    public init() {}

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(position, forKey: .position)
        if let checked {
            try c.encode(checked, forKey: .checked)
        } else if checkedExplicitlyNull {
            try c.encodeNil(forKey: .checked)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case text, position, checked
    }
}

// MARK: - Conflict response envelope
//
// The slice-C.1 backend returns 409 with `{error: {...}, latest: …DTO}`
// for both lists and items. We model it generically so one type covers
// both endpoints.

struct ConflictBody<Latest: Decodable & Sendable>: Decodable {
    let latest: Latest
}

// MARK: - SyncEngine bridge
//
// The Drainer needs the SyncEngine's per-row upsert helpers to apply a
// 409 response's `latest` row through the same LWW path that the
// reconciler uses. Those helpers are private to SyncEngine; we expose
// drainer-only entry points here that forward to them, keeping the
// "outside callers can't bypass LWW" invariant in place.

extension SyncEngine {
    /// Apply a single ListDTO via the existing LWW upsert. Drainer-only
    /// entry point — feature code should never call this directly; it
    /// goes through `reconcile()`.
    func upsertListForDrainer(from dto: ListDTO, in context: ModelContext) throws {
        try upsertListLWW(from: dto, in: context)
    }

    /// Same shape for items.
    func upsertItemForDrainer(from dto: ItemDTO, in context: ModelContext) throws {
        try upsertItemLWW(from: dto, in: context)
    }
}

// MARK: - Date formatting
//
// The backend's If-Match header expects ISO8601 with millisecond
// precision (matches what the read feed emits in `updatedAt`). The
// SyncEngine's `pathWithSince` helper does the same shape; rather than
// duplicate the formatter literal, we put it in one extension here.

extension Date {
    func iso8601MillisString() -> String {
        // `.iso8601` format style defaults to second precision; explicit
        // `.time(includingFractionalSeconds: true)` puts the `.SSS`
        // fragment back so cursor + If-Match round-trips are lossless.
        formatted(.iso8601.year().month().day()
            .dateSeparator(.dash)
            .time(includingFractionalSeconds: true)
            .timeSeparator(.colon)
            .timeZone(separator: .omitted))
    }
}
