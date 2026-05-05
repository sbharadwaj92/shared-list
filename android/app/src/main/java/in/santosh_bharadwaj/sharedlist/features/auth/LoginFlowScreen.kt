package `in`.santosh_bharadwaj.sharedlist.features.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import `in`.santosh_bharadwaj.sharedlist.R
import `in`.santosh_bharadwaj.sharedlist.app.LocalAppContainer
import `in`.santosh_bharadwaj.sharedlist.core.ui.SharedListTheme

/**
 * Login + signup flow. Two-mode segmented button switches between the two; the
 * underlying state lives in [LoginFlowViewModel] as a single immutable
 * [LoginUiState] data class — PLAN.md L240's "single immutable *UiState data
 * class per screen" pattern.
 *
 * Mirrors iOS `LoginFlowView`. Field-level validation is deliberately
 * minimal (any non-empty input enables submit) — the backend is the source of
 * truth for password / email rules; mirroring its constraints client-side
 * means two copies that drift. Backend rejection messages are surfaced
 * verbatim from the typed [in.santosh_bharadwaj.sharedlist.core.networking.ApiError.Server].
 */
@Composable
public fun LoginFlowScreen() {
    val container = LocalAppContainer.current ?: return
    val viewModel: LoginFlowViewModel = viewModel(
        factory = LoginFlowViewModel.factory(container.auth),
    )
    LoginFlowContent(
        state = viewModel.state.collectAsStateWithLifecycle().value,
        onModeChange = viewModel::setMode,
        onEmailChange = viewModel::setEmail,
        onPasswordChange = viewModel::setPassword,
        onDisplayNameChange = viewModel::setDisplayName,
        onSubmit = viewModel::submit,
    )
}

/**
 * Stateless content composable — gets every piece of state via parameters so
 * `@Preview` (which doesn't have a real ViewModel) and unit tests can render
 * it without standing up the full ViewModel scope. Idiomatic Compose pattern.
 */
@Composable
private fun LoginFlowContent(
    state: LoginUiState,
    onModeChange: (LoginMode) -> Unit,
    onEmailChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onDisplayNameChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Top,
    ) {
        Spacer(modifier = Modifier.height(48.dp))
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.displaySmall,
        )
        Spacer(modifier = Modifier.height(24.dp))

        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            LoginMode.entries.forEachIndexed { index, mode ->
                SegmentedButton(
                    selected = state.mode == mode,
                    onClick = { onModeChange(mode) },
                    shape = SegmentedButtonDefaults.itemShape(
                        index = index,
                        count = LoginMode.entries.size,
                    ),
                ) {
                    Text(
                        text = when (mode) {
                            LoginMode.LOGIN -> stringResource(R.string.auth_mode_login)
                            LoginMode.SIGNUP -> stringResource(R.string.auth_mode_signup)
                        },
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = state.email,
            onValueChange = onEmailChange,
            label = { Text(stringResource(R.string.auth_field_email)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedTextField(
            value = state.password,
            onValueChange = onPasswordChange,
            label = { Text(stringResource(R.string.auth_field_password)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        if (state.mode == LoginMode.SIGNUP) {
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = state.displayName,
                onValueChange = onDisplayNameChange,
                label = { Text(stringResource(R.string.auth_field_display_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (state.errorMessage != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = state.errorMessage,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))
        Button(
            onClick = onSubmit,
            enabled = state.canSubmit && !state.isSubmitting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.isSubmitting) {
                CircularProgressIndicator(modifier = Modifier.height(20.dp))
            } else {
                Text(
                    text = when (state.mode) {
                        LoginMode.LOGIN -> stringResource(R.string.auth_mode_login)
                        LoginMode.SIGNUP -> stringResource(R.string.auth_mode_signup)
                    },
                )
            }
        }
    }
}

@Preview(name = "Login mode (empty)", showBackground = true)
@Composable
private fun LoginFlowLoginModePreview() {
    SharedListTheme(dynamicColor = false) {
        LoginFlowContent(
            state = LoginUiState(),
            onModeChange = {}, onEmailChange = {}, onPasswordChange = {},
            onDisplayNameChange = {}, onSubmit = {},
        )
    }
}

@Preview(name = "Signup mode (filled)", showBackground = true)
@Composable
private fun LoginFlowSignupFilledPreview() {
    SharedListTheme(dynamicColor = false) {
        LoginFlowContent(
            state = LoginUiState(
                mode = LoginMode.SIGNUP,
                email = "alice@example.com",
                password = "correct horse battery staple",
                displayName = "Alice",
            ),
            onModeChange = {}, onEmailChange = {}, onPasswordChange = {},
            onDisplayNameChange = {}, onSubmit = {},
        )
    }
}

@Preview(name = "Login mode (error)", showBackground = true)
@Composable
private fun LoginFlowErrorPreview() {
    SharedListTheme(dynamicColor = false) {
        LoginFlowContent(
            state = LoginUiState(
                email = "alice@example.com",
                password = "wrongpw",
                errorMessage = "[401] invalid email or password",
            ),
            onModeChange = {}, onEmailChange = {}, onPasswordChange = {},
            onDisplayNameChange = {}, onSubmit = {},
        )
    }
}
