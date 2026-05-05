// settings.gradle.kts — the FIRST file Gradle reads. Two responsibilities:
//   1. Plugin & dependency repository configuration (where Gradle pulls things
//      from). Done up here so every project module inherits it without each
//      build.gradle.kts repeating itself.
//   2. The list of included modules. We have a single `:app` module today;
//      future modularization (`:core:networking`, `:core:storage`, etc — the
//      Phase 19 level-up) just adds `include(...)` lines.
//
// The version catalog file (gradle/libs.versions.toml) is auto-discovered by
// Gradle 8.x — no `versionCatalogs { }` block needed.

pluginManagement {
    repositories {
        // Google's Maven repo for AGP and other com.android.* plugins.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // FAIL_ON_PROJECT_REPOS means a sub-module can't add its own `repositories { }`
    // block. Keeping resolution centralized here avoids "this works on my machine
    // because my module pulls from a different repo" surprises.
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SharedList"
include(":app")
