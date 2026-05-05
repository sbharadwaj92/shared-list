import Foundation

// Wire types that mirror `backend/src/features/sync/schemas.ts`.
//
// Same naming convention as AuthDTOs: struct names match the backend's Zod
// schema names, JSON keys match the wire camelCase, dates decode via the
// APIClient's `.iso8601` strategy (configured globally in APIClient.swift).
//
// We keep these DTOs distinct from the SwiftData `@Model` types in Models.swift
// for two reasons:
//   1. Wire shapes change with the protocol; persistence shapes change with
//      the local store. Coupling the two means a protocol field rename forces
//      a Core Data-style migration even when the local cache is unaffected.
//   2. `@Model` types are reference types and get @MainActor isolation by
//      virtue of where they're used. DTOs are plain Sendable value types that
//      can cross actors freely (decoded off the URLSession actor, handed to
//      the @MainActor reconciler).
//
// Conversion (`apply` helpers) lives in the SyncEngine, not on the DTOs —
// keeping the persistence write side in one place.

public struct ListDTO: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let createdBy: String
    public let createdAt: Date
    public let updatedAt: Date
    public let deletedAt: Date?
}

public struct ItemDTO: Codable, Sendable, Equatable {
    public let id: String
    public let listId: String
    public let text: String
    /// Wire field name from the backend: `checked` (a nullable timestamp).
    /// We decode into `checkedAt` for clarity at the call site — `checked: nil`
    /// vs `checkedAt: nil` is the same boolean signal but the latter reads
    /// more naturally next to `createdAt` / `updatedAt`. The `CodingKey`
    /// remaps the JSON key.
    public let checkedAt: Date?
    public let position: Int
    public let createdBy: String
    public let createdAt: Date
    public let updatedAt: Date
    public let deletedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id
        case listId
        case text
        case checkedAt = "checked"
        case position
        case createdBy
        case createdAt
        case updatedAt
        case deletedAt
    }
}

public struct ListMemberDTO: Codable, Sendable, Equatable {
    public let listId: String
    public let userId: String
    public let role: String
    public let createdAt: Date
    public let updatedAt: Date
    public let deletedAt: Date?
}

// Response envelope shared across the three feeds. Generic on `Row` so we get
// one decoder per resource without re-stating the `serverTime` pattern.
public struct SyncResponse<Row: Codable & Sendable>: Codable, Sendable {
    public let serverTime: Date
    public let rows: [Row]
}

public typealias SyncListsResponse = SyncResponse<ListDTO>
public typealias SyncItemsResponse = SyncResponse<ItemDTO>
public typealias SyncListMembersResponse = SyncResponse<ListMemberDTO>
