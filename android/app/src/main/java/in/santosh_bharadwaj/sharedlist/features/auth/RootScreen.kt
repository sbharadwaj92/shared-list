package `in`.santosh_bharadwaj.sharedlist.features.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import `in`.santosh_bharadwaj.sharedlist.app.LocalAppContainer
import `in`.santosh_bharadwaj.sharedlist.core.ui.SharedListTheme
import kotlinx.coroutines.launch

/**
 * Root composable — switches on TokenStore's auth state.
 *
 * `null` token state → [LoginFlowScreen]; non-null → post-auth placeholder.
 * Mirrors iOS `RootView`. The StateFlow.collectAsStateWithLifecycle() call is
 * the Kotlin idiom for consuming a flow in a composable: it subscribes when
 * the composition enters the STARTED lifecycle state and cancels on STOPPED,
 * which means a backgrounded process doesn't keep the flow hot.
 *
 * Phase 6 only ships the auth surface; once we have lists (Phase 13), the
 * "logged in" branch becomes a TabView equivalent. For now it's a placeholder
 * that lets us verify the full login → logout → login cycle.
 */
@Composable
public fun RootScreen() {
    val container = LocalAppContainer.current
    if (container == null) {
        // Misconfigured preview / test harness — show a neutral spinner
        // rather than crashing. Real runtime always has a container.
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val tokens by container.tokenStore.state.collectAsStateWithLifecycle()
    if (tokens == null) {
        LoginFlowScreen()
    } else {
        AuthenticatedHomePlaceholder()
    }
}

/**
 * Placeholder for the post-login app surface. Replaced in Phase 13 by the
 * real ListsTabView. Kept here (not in its own file) because it's throwaway
 * scaffolding — exists only so we can verify the full auth cycle.
 */
@Composable
private fun AuthenticatedHomePlaceholder() {
    val container = LocalAppContainer.current ?: return
    val tokens by container.tokenStore.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var isSigningOut by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        Spacer(modifier = Modifier.height(48.dp))
        Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            modifier = Modifier.fillMaxWidth().height(64.dp),
            tint = SuccessGreen,
        )
        Spacer(modifier = Modifier.height(24.dp))

        val user = tokens?.user
        if (user != null) {
            Text(
                text = "Signed in as",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = user.displayName,
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                text = user.email,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(modifier = Modifier.weight(1f))

        Button(
            onClick = {
                isSigningOut = true
                scope.launch {
                    runCatching { container.auth.logout() }
                    isSigningOut = false
                }
            },
            enabled = !isSigningOut,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (isSigningOut) {
                CircularProgressIndicator(modifier = Modifier.height(20.dp))
            } else {
                Text("Sign Out")
            }
        }
        Spacer(modifier = Modifier.height(32.dp))
    }
}

// iOS uses SwiftUI's `.green` for the post-auth success indicator; on Android
// Material 3 doesn't expose a generic "success" color role, so we hardcode
// the iOS-equivalent system green to keep the visual parity. Pulled into a
// named constant so a future Material 3 success-role bump has a single edit
// site and Detekt stops calling it a magic number.
private val SuccessGreen: Color = Color(red = 0x34, green = 0xC7, blue = 0x59)

@Preview(name = "Logged out", showBackground = true)
@Composable
private fun RootScreenLoggedOutPreview() {
    val container = remember { PreviewSupport.loggedOutContainer() }
    androidx.compose.runtime.CompositionLocalProvider(LocalAppContainer provides container) {
        SharedListTheme(dynamicColor = false) {
            RootScreen()
        }
    }
}

@Preview(name = "Logged in", showBackground = true)
@Composable
private fun RootScreenLoggedInPreview() {
    val container = remember { PreviewSupport.loggedInContainer() }
    androidx.compose.runtime.CompositionLocalProvider(LocalAppContainer provides container) {
        SharedListTheme(dynamicColor = false) {
            RootScreen()
        }
    }
}
