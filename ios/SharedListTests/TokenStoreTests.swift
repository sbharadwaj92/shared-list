import Foundation
import Testing
@testable import SharedList

@Suite("TokenStore")
@MainActor
struct TokenStoreTests {
    @Test func loadsNothingFromEmptyKeychain() async {
        let store = TokenStore(keychain: InMemoryKeychainStore())
        await store.loadFromKeychain()
        #expect(store.current == nil)
    }

    @Test func saveWritesToKeychainAndExposesCurrent() async throws {
        let keychain = InMemoryKeychainStore()
        let store = TokenStore(keychain: keychain)
        let user = AuthUser(id: "u1", email: "alice@example.com", displayName: "Alice")
        try await store.save(.init(accessToken: "a", refreshToken: "r", user: user))

        // In-memory state.
        #expect(store.current?.accessToken == "a")
        #expect(store.current?.refreshToken == "r")
        #expect(store.current?.user == user)

        // Persisted state — a new store rehydrating from the same keychain
        // must come back with the same values.
        let rehydrated = TokenStore(keychain: keychain)
        await rehydrated.loadFromKeychain()
        #expect(rehydrated.current?.accessToken == "a")
        #expect(rehydrated.current?.refreshToken == "r")
        #expect(rehydrated.current?.user == user)
    }

    @Test func updateTokensRotatesPair() async throws {
        let keychain = InMemoryKeychainStore()
        let store = TokenStore(keychain: keychain)
        let user = AuthUser(id: "u1", email: "alice@example.com", displayName: "Alice")
        try await store.save(.init(accessToken: "a1", refreshToken: "r1", user: user))

        try await store.updateTokens(accessToken: "a2", refreshToken: "r2")

        #expect(store.current?.accessToken == "a2")
        #expect(store.current?.refreshToken == "r2")
        #expect(store.current?.user == user)
    }

    @Test func updateTokensThrowsIfNotLoggedIn() async {
        let store = TokenStore(keychain: InMemoryKeychainStore())
        await #expect(throws: TokenStoreError.notLoggedIn) {
            try await store.updateTokens(accessToken: "a", refreshToken: "r")
        }
    }

    @Test func clearRemovesEverything() async throws {
        let keychain = InMemoryKeychainStore()
        let store = TokenStore(keychain: keychain)
        try await store.save(.init(
            accessToken: "a",
            refreshToken: "r",
            user: AuthUser(id: "u", email: "e", displayName: "n")
        ))

        await store.clear()
        #expect(store.current == nil)

        let rehydrated = TokenStore(keychain: keychain)
        await rehydrated.loadFromKeychain()
        #expect(rehydrated.current == nil)
    }
}
