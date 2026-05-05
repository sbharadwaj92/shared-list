package `in`.santosh_bharadwaj.sharedlist.features.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import `in`.santosh_bharadwaj.sharedlist.core.auth.AuthService
import `in`.santosh_bharadwaj.sharedlist.core.networking.ApiError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Login mode toggle — segmented button at the top of [LoginFlowScreen].
 * Two-state enum kept as a feature-local type; small, no other consumers.
 */
public enum class LoginMode {
    LOGIN,
    SIGNUP,
}

/**
 * Single immutable UiState for the login screen — PLAN.md L240's pattern.
 * Composable reads this whole record via `collectAsStateWithLifecycle()`;
 * partial updates happen via [MutableStateFlow.update] in the ViewModel.
 *
 * `canSubmit` is computed from the other fields rather than tracked separately
 * so it can never disagree with the input state.
 */
public data class LoginUiState(
    val mode: LoginMode = LoginMode.LOGIN,
    val email: String = "",
    val password: String = "",
    val displayName: String = "",
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null,
) {
    public val canSubmit: Boolean
        get() {
            if (email.trim().isEmpty() || password.isEmpty()) return false
            if (mode == LoginMode.SIGNUP && displayName.trim().isEmpty()) return false
            return true
        }
}

/**
 * ViewModel for [LoginFlowScreen]. Exposes [state] as `StateFlow<LoginUiState>`
 * (PLAN.md L241). All mutations go through `_state.update { copy(...) }` to
 * stay atomic — two coroutines can't half-overwrite each other's edits.
 *
 * Mirrors iOS `LoginFlowView`'s embedded state + `submit()` logic. We split
 * UI/state out of the composable here because Android's ViewModel survives
 * configuration changes (rotation, theme switch) and process death; SwiftUI's
 * `@State` doesn't have an equivalent restoration story so iOS keeps state
 * in the View — different platform, different idiom.
 */
public class LoginFlowViewModel(
    private val auth: AuthService,
) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    public val state: StateFlow<LoginUiState> = _state.asStateFlow()

    public fun setMode(mode: LoginMode) {
        _state.update { it.copy(mode = mode, errorMessage = null) }
    }

    public fun setEmail(value: String) {
        _state.update { it.copy(email = value) }
    }

    public fun setPassword(value: String) {
        _state.update { it.copy(password = value) }
    }

    public fun setDisplayName(value: String) {
        _state.update { it.copy(displayName = value) }
    }

    public fun submit() {
        val current = _state.value
        if (!current.canSubmit || current.isSubmitting) return
        _state.update { it.copy(isSubmitting = true, errorMessage = null) }
        viewModelScope.launch {
            val result = runCatching {
                when (current.mode) {
                    LoginMode.LOGIN -> auth.login(
                        email = current.email.trim(),
                        password = current.password,
                    )
                    LoginMode.SIGNUP -> auth.signup(
                        email = current.email.trim(),
                        password = current.password,
                        displayName = current.displayName.trim(),
                    )
                }
            }
            _state.update {
                it.copy(
                    isSubmitting = false,
                    errorMessage = result.exceptionOrNull()?.let(::displayMessage),
                )
            }
            // On success, TokenStore now holds non-null tokens; RootScreen
            // observes that and switches to the post-auth surface
            // automatically. No navigation call needed.
        }
    }

    private fun displayMessage(error: Throwable): String = when (error) {
        is ApiError.Server -> "[${error.status}] ${error.errorMessage}"
        is ApiError.NotAuthenticated -> "Not authenticated."
        is ApiError.Decoding -> "Couldn't read server response: ${error.detail}"
        is ApiError.Transport -> "Network error: ${error.detail}"
        is ApiError.RefreshFailed -> "Session expired. Please log in again."
        else -> "Unexpected error: ${error.message ?: error::class.simpleName}"
    }

    public companion object {
        /**
         * Factory used by `viewModel(factory = ...)` in the composable. Manual
         * factory because we don't use Hilt (PLAN.md mandates manual DI). The
         * AppContainer reaches into here to inject the AuthService instance.
         */
        public fun factory(auth: AuthService): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    require(modelClass.isAssignableFrom(LoginFlowViewModel::class.java))
                    return LoginFlowViewModel(auth) as T
                }
            }
    }
}
