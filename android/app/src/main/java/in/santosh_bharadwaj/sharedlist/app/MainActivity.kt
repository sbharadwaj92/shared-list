package `in`.santosh_bharadwaj.sharedlist.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import `in`.santosh_bharadwaj.sharedlist.core.ui.SharedListTheme
import `in`.santosh_bharadwaj.sharedlist.features.auth.RootScreen

/**
 * The single Activity in the app — Compose-first. Every screen is a composable
 * within this activity's content tree; navigation is handled by Compose Nav
 * (added properly in Phase 13 when there are multiple destinations). For
 * Phase 6 the tree is simply RootScreen, which switches on auth state.
 *
 * `enableEdgeToEdge()` opts into the modern Android 15 system-bar handling so
 * Compose content draws under the status/navigation bars and we manage insets
 * via `WindowInsets.safeDrawing`. Required-style for Android 15 / S24 Ultra.
 *
 * AppContainer is sourced from the SharedListApplication instance and
 * threaded down via `CompositionLocalProvider`. Composables read it via
 * `LocalAppContainer.current`. Mirrors iOS `Environment(\.appContainer)`.
 */
public class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val appContainer = (application as SharedListApplication).container

        setContent {
            CompositionLocalProvider(LocalAppContainer provides appContainer) {
                SharedListTheme {
                    RootScreen()
                }
            }
        }
    }
}
