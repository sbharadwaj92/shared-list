import Foundation
import Testing
@testable import SharedList

// KeychainStore tests run against the real Security.framework keychain. Each
// test uses a unique `service` string so concurrent test runs don't collide,
// and tearDown deletes anything we wrote so a flake doesn't pollute the
// keychain across runs.
//
// We can't unit-test the InMemoryKeychainStore against the real one without
// duplication, so the InMemoryKeychainStore tests assert its own contract
// instead.

@Suite("KeychainStore (real Security.framework)")
struct KeychainStoreTests {
    @Test func roundTripsAValue() async throws {
        let service = uniqueService()
        let store = KeychainStore(service: service)
        defer { Task { try? await store.delete("k") } }

        try await store.set("v", for: "k")
        let value = try await store.get("k")
        #expect(value == "v")
    }

    @Test func overwritesExistingValue() async throws {
        let service = uniqueService()
        let store = KeychainStore(service: service)
        defer { Task { try? await store.delete("k") } }

        try await store.set("first", for: "k")
        try await store.set("second", for: "k")
        let value = try await store.get("k")
        #expect(value == "second")
    }

    @Test func returnsNilForMissingKey() async throws {
        let service = uniqueService()
        let store = KeychainStore(service: service)
        let value = try await store.get("never-set")
        #expect(value == nil)
    }

    @Test func deleteIsIdempotent() async throws {
        let service = uniqueService()
        let store = KeychainStore(service: service)
        // Deleting a missing key must not throw — our public contract.
        try await store.delete("never-set")
        try await store.set("v", for: "k")
        try await store.delete("k")
        let value = try await store.get("k")
        #expect(value == nil)
    }

    @Test func differentServicesAreIsolated() async throws {
        let serviceA = uniqueService()
        let serviceB = uniqueService()
        let storeA = KeychainStore(service: serviceA)
        let storeB = KeychainStore(service: serviceB)
        defer {
            Task {
                try? await storeA.delete("k")
                try? await storeB.delete("k")
            }
        }

        try await storeA.set("a-value", for: "k")
        try await storeB.set("b-value", for: "k")

        #expect(try await storeA.get("k") == "a-value")
        #expect(try await storeB.get("k") == "b-value")
    }
}

@Suite("InMemoryKeychainStore")
struct InMemoryKeychainStoreTests {
    @Test func roundTripsAValue() async throws {
        let store = InMemoryKeychainStore()
        try await store.set("v", for: "k")
        #expect(try await store.get("k") == "v")
    }

    @Test func deleteRemovesValue() async throws {
        let store = InMemoryKeychainStore()
        try await store.set("v", for: "k")
        try await store.delete("k")
        #expect(try await store.get("k") == nil)
    }

    @Test func missingKeyReturnsNil() async throws {
        let store = InMemoryKeychainStore()
        #expect(try await store.get("missing") == nil)
    }
}

private func uniqueService() -> String {
    "in.santosh-bharadwaj.sharedlist.tests.\(UUID().uuidString)"
}
