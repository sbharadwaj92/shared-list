import Foundation
import Security

// Custom wrapper around the C-level `Security.framework` Keychain Services API.
//
// Why a custom wrapper rather than KeychainAccess / Valet / SwiftKeychainWrapper?
// PLAN.md mandates "depth of learning over speed to ship." The Keychain API is
// notoriously fiddly (CFTypeRef bridging, attribute dictionaries, status code
// soup) and writing a small wrapper forces engagement with the actual data
// model — service/account/access-class — rather than calling someone else's
// `set("key", "value")`. Three users, no production stakes; the cost of a bug
// here is "I have to log in again."
//
// What we are NOT doing here:
//   - kSecAttrAccessGroup (cross-process / app-extension sharing) — single
//     app, no extensions yet. Add later if we ship a Share extension.
//   - SecAccessControl (biometric gating, ACL-protected items) — Phase 19
//     "Biometric Keychain gating" is the level-up that adds Face ID. Until
//     then, items are protected only by the device passcode lifecycle.
//   - iCloud Keychain sync (kSecAttrSynchronizable) — auth tokens are
//     device-scoped on purpose; sharing a refresh token across iCloud means a
//     stolen Mac with the same Apple ID inherits the session.
//
// Threading model: the actual Keychain calls (SecItemAdd / SecItemCopyMatching
// / SecItemDelete) are synchronous and do disk I/O. We mark the type
// `Sendable` and make the methods async so callers can await them without
// blocking, but the work runs on whatever queue invokes us. For Phase 5 the
// caller is `TokenStore`, called rarely (on login, on refresh, on launch) —
// no measurable performance reason to push to a background queue. If it ever
// matters we can wrap in `Task.detached`.

public enum KeychainError: Error, Equatable, Sendable {
    case unexpectedStatus(OSStatus)
    case dataCorrupted
}

public protocol KeychainStoring: Sendable {
    func set(_ value: String, for key: String) async throws
    func get(_ key: String) async throws -> String?
    func delete(_ key: String) async throws
}

public struct KeychainStore: KeychainStoring {
    // The `service` attribute scopes everything we write to a single namespace
    // inside the per-app Keychain partition. Bundle ID is the natural choice:
    // the Keychain is already partitioned by application identifier, but
    // setting `service` explicitly makes our queries unambiguous and lets a
    // unit test pass a different service string for isolation.
    private let service: String

    public init(service: String = Bundle.main.bundleIdentifier ?? "in.santosh-bharadwaj.sharedlist") {
        self.service = service
    }

    // SecItemAdd will fail with errSecDuplicateItem if the (service, account)
    // pair already has a row, so we always delete-then-add. The alternative
    // (SecItemUpdate) is more efficient but requires a different attribute
    // dictionary shape and the API surface is harder to reason about for a
    // learner. delete-then-add is the textbook idiom in the Apple sample code.
    public func set(_ value: String, for key: String) async throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.dataCorrupted
        }

        // SecItemDelete with a (service, account) match removes the existing
        // row if any; errSecItemNotFound is fine — we are about to add it.
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let deleteStatus = SecItemDelete(deleteQuery as CFDictionary)
        if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
            throw KeychainError.unexpectedStatus(deleteStatus)
        }

        // kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: the item is
        // readable only after the user has unlocked the device once since
        // boot, AND it never gets backed up to iCloud or moved to a new
        // device via encrypted backup. This is the standard "auth token"
        // accessibility class — it survives app relaunches but cannot be
        // exfiltrated by an attacker who clones the encrypted backup of a
        // never-unlocked device.
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    public func get(_ key: String) async throws -> String? {
        // kSecReturnData = "give me the value, not just the metadata."
        // kSecMatchLimitOne = stop after the first hit; our (service, account)
        // pair is logically unique, but explicit is better than implicit.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.dataCorrupted
            }
            return value
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func delete(_ key: String) async throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        // Deleting a missing item is a no-op from the caller's perspective.
        // Surfacing errSecItemNotFound as an error would force every caller
        // to write `try? store.delete(...)` everywhere — silent failure by
        // accident, which CLAUDE.md forbids. So we treat "not found" as success.
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}

// In-memory fake for tests. Deliberately NOT exposed via #if DEBUG so the
// production target sees the same type — it's just a different conformance
// of `KeychainStoring`. The protocol means callers are written against the
// abstract type and the swap is invisible.
public actor InMemoryKeychainStore: KeychainStoring {
    private var storage: [String: String] = [:]

    public init() {}

    public func set(_ value: String, for key: String) async throws {
        storage[key] = value
    }

    public func get(_ key: String) async throws -> String? {
        storage[key]
    }

    public func delete(_ key: String) async throws {
        storage.removeValue(forKey: key)
    }
}
