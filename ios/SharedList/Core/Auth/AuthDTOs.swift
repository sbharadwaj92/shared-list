import Foundation

// Wire types that mirror the backend's auth schemas (backend/src/features/auth/schemas.ts).
//
// We keep these structs Codable + Sendable + Equatable. Sendable is the
// important one for Swift 6: any value crossing an actor boundary (an API
// call response decoded on the URLSession actor, then handed to TokenStore
// on the MainActor) needs Sendable. Plain value types whose stored properties
// are all Sendable get the conformance implicitly, but stating it explicitly
// is a useful sanity check — if a non-Sendable property sneaks in later,
// the compiler points at this declaration.
//
// Naming mirrors the backend types verbatim so a `git grep AuthResponse`
// finds matches across the whole repo. JSON keys also match the wire format
// (camelCase) — no Swift-side renaming dance.

public struct AuthUser: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let email: String
    public let displayName: String

    public init(id: String, email: String, displayName: String) {
        self.id = id
        self.email = email
        self.displayName = displayName
    }
}

public struct AuthResponse: Codable, Sendable, Equatable {
    public let user: AuthUser
    public let accessToken: String
    public let refreshToken: String
}

public struct SignupBody: Codable, Sendable, Equatable {
    public let email: String
    public let password: String
    public let displayName: String

    public init(email: String, password: String, displayName: String) {
        self.email = email
        self.password = password
        self.displayName = displayName
    }
}

public struct LoginBody: Codable, Sendable, Equatable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email
        self.password = password
    }
}

public struct RefreshBody: Codable, Sendable, Equatable {
    public let refreshToken: String
}

public struct LogoutBody: Codable, Sendable, Equatable {
    public let refreshToken: String
}

// Error envelope from the backend (backend/src/infra/middleware/error.ts).
// Every non-2xx response carries this shape; APIClient surfaces the inner
// `code` + `requestId` to the caller via APIError so a "weird thing happened"
// bug report can be matched to a server-side log line.
public struct APIErrorEnvelope: Codable, Sendable, Equatable {
    public struct Inner: Codable, Sendable, Equatable {
        public let code: String
        public let message: String
        public let requestId: String
    }
    public let error: Inner
}
