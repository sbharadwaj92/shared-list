package `in`.santosh_bharadwaj.sharedlist.core.auth

import kotlinx.serialization.Serializable

/**
 * Wire types that mirror the backend's auth schemas (backend/src/features/auth/schemas.ts).
 *
 * @Serializable lets the kotlinx.serialization plugin generate JSON
 * encoders/decoders at compile time — closest cultural mirror to Swift's
 * Codable. JSON keys are camelCase to match the wire format and the iOS DTOs
 * verbatim, so a `git grep AuthResponse` finds matches across all three
 * platforms.
 *
 * Naming mirrors backend types (and iOS DTOs) exactly: `<Verb><Subject>Body`
 * for requests, `<Subject>Response` for responses.
 */
@Serializable
public data class AuthUser(
    public val id: String,
    public val email: String,
    public val displayName: String,
)

@Serializable
public data class AuthResponse(
    public val user: AuthUser,
    public val accessToken: String,
    public val refreshToken: String,
)

@Serializable
public data class SignupBody(
    public val email: String,
    public val password: String,
    public val displayName: String,
)

@Serializable
public data class LoginBody(
    public val email: String,
    public val password: String,
)

@Serializable
public data class RefreshBody(
    public val refreshToken: String,
)

@Serializable
public data class LogoutBody(
    public val refreshToken: String,
)

/**
 * Error envelope from the backend (backend/src/infra/middleware/error.ts).
 * Every non-2xx response carries this shape; ApiClient surfaces the inner
 * `code` + `requestId` to callers via [ApiError.Server].
 */
@Serializable
public data class ApiErrorEnvelope(
    public val error: ApiErrorBody,
)

@Serializable
public data class ApiErrorBody(
    public val code: String,
    public val message: String,
    public val requestId: String,
)
