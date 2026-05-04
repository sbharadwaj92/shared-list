import Foundation
import Observation

// TokenStore is the single owner of the access + refresh token pair.
//
// Two concerns rolled into one type, intentionally:
//   1. Persistence — read/write the pair to KeychainStore, survive app relaunches.
//   2. Observation  — expose the current pair to UI / APIClient as @Observable
//      state so screens can react to login/logout without an extra notification
//      bus. Logging out is "set tokens to nil"; the RootView's switch on
//      `tokens == nil` does the rest.
//
// We use `@Observable` (Observation framework, iOS 17+) instead of @ObservableObject.
// Two practical reasons for this project:
//   - It works with classes (not structs/actors), and ergonomically lets us
//     treat the store as a single shared instance threaded through AppContainer.
//   - The compiler-synthesized observation tracking is per-property, so a view
//     that reads only `currentUser` doesn't re-render when `accessToken` rotates.
//
// Threading: the type is `@MainActor`-isolated. Reasoning: the @Observable
// surface is read directly by SwiftUI views, which are MainActor-bound, so any
// mutation must happen on the main actor anyway to avoid SwiftUI's "modifying
// state during view update" warnings. The Keychain calls underneath are
// `await`-ed and run their I/O off-main implicitly via async; the cost is one
// hop per call which is fine for tokens-on-launch and tokens-on-refresh.

@MainActor
@Observable
public final class TokenStore {
    public struct Tokens: Equatable, Sendable {
        public let accessToken: String
        public let refreshToken: String
        public let user: AuthUser

        public init(accessToken: String, refreshToken: String, user: AuthUser) {
            self.accessToken = accessToken
            self.refreshToken = refreshToken
            self.user = user
        }
    }

    // Non-observed because we only read it once at init; the user could
    // subscribe to changes if we ever change the keychain at runtime, which
    // we never do.
    @ObservationIgnored
    private let keychain: any KeychainStoring

    // The single piece of observable state. nil = logged out. Setting it to a
    // value means "logged in"; APIClient picks up the new accessToken on its
    // next request (it reads `current?.accessToken` lazily, not at init).
    public private(set) var current: Tokens?

    // Keys are namespaced under the app's Keychain partition (KeychainStore's
    // service), so collisions with other apps are impossible. The strings
    // here are stable wire identifiers — never rename without a migration
    // (which we won't bother with for v1; the worst case is "log in again").
    private enum Key {
        static let accessToken = "auth.accessToken"
        static let refreshToken = "auth.refreshToken"
        static let userId = "auth.user.id"
        static let userEmail = "auth.user.email"
        static let userDisplayName = "auth.user.displayName"
    }

    public init(keychain: any KeychainStoring) {
        self.keychain = keychain
    }

    // Called once at app launch from AppContainer. We hydrate the in-memory
    // `current` pair from the Keychain so the app comes up logged-in if a
    // previous session left tokens behind. Failure to load (corrupted entry,
    // partial write from a crash) is treated as "no tokens" — safe default.
    public func loadFromKeychain() async {
        do {
            guard let access = try await keychain.get(Key.accessToken),
                  let refresh = try await keychain.get(Key.refreshToken),
                  let userId = try await keychain.get(Key.userId),
                  let email = try await keychain.get(Key.userEmail),
                  let displayName = try await keychain.get(Key.userDisplayName) else {
                current = nil
                return
            }
            current = Tokens(
                accessToken: access,
                refreshToken: refresh,
                user: AuthUser(id: userId, email: email, displayName: displayName)
            )
        } catch {
            // A keychain read error at launch is rare. Treat it as "logged
            // out" rather than crashing — a re-login fixes it. The error is
            // not silently dropped at the system level (OSStatus is logged
            // by the OS); we just don't propagate it to UI.
            current = nil
        }
    }

    // Persist a fresh token pair after signup / login / refresh. The
    // in-memory `current` is updated first so any view binding sees the new
    // identity immediately; the Keychain writes happen after but errors there
    // are still surfaced — we don't want a half-saved state to silently
    // succeed because then a relaunch would log the user back out.
    public func save(_ tokens: Tokens) async throws {
        current = tokens
        try await keychain.set(tokens.accessToken, for: Key.accessToken)
        try await keychain.set(tokens.refreshToken, for: Key.refreshToken)
        try await keychain.set(tokens.user.id, for: Key.userId)
        try await keychain.set(tokens.user.email, for: Key.userEmail)
        try await keychain.set(tokens.user.displayName, for: Key.userDisplayName)
    }

    // After a refresh response, only the access + refresh tokens change; the
    // user identity is identical. Avoid rewriting unchanged keychain rows.
    public func updateTokens(accessToken: String, refreshToken: String) async throws {
        guard let user = current?.user else {
            // Programmer error: refreshing tokens with no user record means
            // someone called this from the wrong path. Fail loudly.
            throw TokenStoreError.notLoggedIn
        }
        let updated = Tokens(accessToken: accessToken, refreshToken: refreshToken, user: user)
        current = updated
        try await keychain.set(accessToken, for: Key.accessToken)
        try await keychain.set(refreshToken, for: Key.refreshToken)
    }

    public func clear() async {
        current = nil
        // Best-effort delete of every key. We use try? because logout must
        // succeed from the user's perspective even if a keychain row was
        // somehow already missing — relaunch will recompute "logged out"
        // from the absence of any one of these.
        try? await keychain.delete(Key.accessToken)
        try? await keychain.delete(Key.refreshToken)
        try? await keychain.delete(Key.userId)
        try? await keychain.delete(Key.userEmail)
        try? await keychain.delete(Key.userDisplayName)
    }
}

public enum TokenStoreError: Error, Equatable, Sendable {
    case notLoggedIn
}

// Helpers used by APIClient to plumb a /auth/refresh response back into the
// store. They live in the same file as TokenStore so they can mutate the
// `private(set)` `current` property; APIClient.swift is in a different file
// and would only see the public read accessor.
extension TokenStore {
    // Apply a rotated pair to the in-memory state immediately. The Keychain
    // is written separately (via `persistRotated`) after the retried request
    // fires — splitting the two halves means a slow keychain write doesn't
    // delay the retry, which is the user-visible work.
    func applyRefresh(accessToken: String, refreshToken: String) throws {
        guard let user = current?.user else {
            throw TokenStoreError.notLoggedIn
        }
        current = Tokens(accessToken: accessToken, refreshToken: refreshToken, user: user)
    }

    // Persist the rotated pair. Failure is non-fatal — worst case is a
    // relaunch reads the older tokens and triggers another refresh.
    func persistRotated(accessToken: String, refreshToken: String) async throws {
        try await updateTokens(accessToken: accessToken, refreshToken: refreshToken)
    }
}
