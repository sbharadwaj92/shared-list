package `in`.santosh_bharadwaj.sharedlist.core.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * Material 3 theme wrapper — the single root composable that every screen sits
 * under, providing the `MaterialTheme` color/typography/shape scope.
 *
 * Behavior:
 *   - On Android 12+ (we require 15) `dynamicColor = true` adopts the user's
 *     wallpaper-derived palette (Material You). This is the modern, expected
 *     Android default and a free win for system integration.
 *   - We still ship a static fallback color scheme so previews (which run
 *     without a Context for dynamic colors in some Studio versions) and unit
 *     tests render with stable colors.
 *
 * No custom typography or shapes for v1 — Material 3 defaults are good enough
 * for the auth flow. Extracted into core/ui so feature code never has to
 * import MaterialTheme directly; future tweaks happen in one place.
 */
@Composable
public fun SharedListTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        dynamicColor -> if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
