package `in`.santosh_bharadwaj.sharedlist.core.auth

import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiClient
import io.ktor.http.HttpMethod

/**
 * Domain layer between the UI and ApiClient/TokenStore. Mirrors iOS
 * `AuthServicing` / `AuthService`.
 *
 * Why a separate interface rather than calling ApiClient directly from
 * ViewModels?
 *   - It owns the "what does signup mean" sequencing: hit the endpoint, save
 *     returned tokens via TokenStore. A view shouldn't have to know that
 *     order — it just calls `auth.signup(email, password, displayName)`.
 *   - It's the seam where future cross-cutting concerns land (force-logout
 *     reactions, biometric re-auth gating, telemetry on login attempts).
 *   - Tests can fake AuthService to drive ViewModels without standing up the
 *     full ApiClient stack.
 */
public interface AuthService {
    public suspend fun signup(email: String, password: String, displayName: String): AuthUser
    public suspend fun login(email: String, password: String): AuthUser
    public suspend fun logout()
    public fun currentUser(): AuthUser?
}

public class DefaultAuthService(
    private val api: ApiClient,
    private val tokenStore: TokenStore,
) : AuthService {

    override suspend fun signup(email: String, password: String, displayName: String): AuthUser {
        val response: AuthResponse = api.send(
            method = HttpMethod.Post,
            path = "/auth/signup",
            body = SignupBody(email = email, password = password, displayName = displayName),
            requiresAuth = false,
        )
        tokenStore.save(
            TokenStore.Tokens(
                accessToken = response.accessToken,
                refreshToken = response.refreshToken,
                user = response.user,
            ),
        )
        return response.user
    }

    override suspend fun login(email: String, password: String): AuthUser {
        val response: AuthResponse = api.send(
            method = HttpMethod.Post,
            path = "/auth/login",
            body = LoginBody(email = email, password = password),
            requiresAuth = false,
        )
        tokenStore.save(
            TokenStore.Tokens(
                accessToken = response.accessToken,
                refreshToken = response.refreshToken,
                user = response.user,
            ),
        )
        return response.user
    }

    override suspend fun logout() {
        // Best-effort: tell the backend to revoke this device's refresh token,
        // then clear local state regardless of network outcome. The user's
        // intent ("log me out") must always succeed locally even if offline.
        // Reuse-detection at the backend will revoke the token anyway the next
        // time it's used. Mirrors iOS AuthService.logout().
        val refreshToken = tokenStore.current?.refreshToken
        if (refreshToken != null) {
            try {
                api.sendNoContent(
                    method = HttpMethod.Post,
                    path = "/auth/logout",
                    body = LogoutBody(refreshToken = refreshToken),
                    requiresAuth = false,
                )
            } catch (_: Throwable) {
                // Swallow — server-side revocation is a nice-to-have. Local
                // clear() below is the user-visible operation.
            }
        }
        tokenStore.clear()
    }

    override fun currentUser(): AuthUser? = tokenStore.current?.user
}
