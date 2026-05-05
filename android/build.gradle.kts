// Root project build file. Plugins are declared here with `apply false` so the
// classpath versions are pinned in one place; sub-modules then `apply` them via
// `plugins { alias(libs.plugins.foo) }` in their own build files.
//
// Detekt is applied at the root because we run it across all modules from one
// CLI invocation (`./gradlew detekt`).

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.detekt)
}

// Apply Detekt to every Kotlin module. The `subprojects { }` block runs once
// per child project after settings.gradle.kts has registered them.
subprojects {
    apply(plugin = rootProject.libs.plugins.detekt.get().pluginId)

    detekt {
        // Single config file at the repo root keeps rules consistent across
        // any future modules. The file ships baseline-mode disabled so new
        // findings fail the build immediately rather than accumulating debt.
        config.setFrom(rootProject.files("config/detekt/detekt.yml"))
        buildUponDefaultConfig = true
        // Run on the JVM main + test source sets. Detekt auto-picks up
        // src/{main,test,androidTest}/kotlin via the Kotlin plugin's
        // SourceSetContainer.
        autoCorrect = false
    }

    dependencies {
        // The "formatting" ruleset wraps ktlint as a Detekt extension — running
        // both linters via a single CLI saves a step in the dev loop and CI.
        add("detektPlugins", rootProject.libs.detekt.formatting)
    }
}
