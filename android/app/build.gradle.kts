// App module build file. This is where almost every Android-specific
// configuration lives — SDK levels, applicationId, signing, ProGuard rules,
// the dependency list, the explicit-API-mode opt-in.

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    // The `namespace` controls the R class package and the manifest merger.
    // It's separate from `applicationId` (the user-visible package) because
    // they CAN diverge — but PLAN.md uses one identifier so we mirror it here.
    // We use underscores instead of dashes because Java/Kotlin packages
    // disallow `-`. The applicationId can keep dashes; namespace cannot.
    namespace = "in.santosh_bharadwaj.sharedlist"
    compileSdk = 35

    defaultConfig {
        applicationId = "in.santosh_bharadwaj.sharedlist"
        minSdk = 35
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Compose enables @Composable preview rendering in the IDE only when
        // vectorDrawables.useSupportLibrary is true.
        vectorDrawables { useSupportLibrary = true }
    }

    buildTypes {
        debug {
            // Keep debug builds unobfuscated and unminified so stack traces
            // are readable. We're not shipping to the Play Store.
            isMinifyEnabled = false
        }
        release {
            // ProGuard / R8 only matter when we ship; for a learning project
            // where every install is local, leaving minification off keeps the
            // build deterministic. Flip this on later if we ever ship to Play.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // Java 17 source/target — the matching JDK for AGP 8.7+. JDK 21 also works
    // at runtime but the bytecode level here governs what language features
    // Kotlin can call into. Java 17 covers everything Compose needs.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Compose feature toggle. Enabling `compose = true` activates the K2
    // Compose Compiler plugin (applied via `kotlin-compose` plugin in the
    // plugins block). Without the plugin, this flag is a no-op.
    buildFeatures {
        compose = true
        buildConfig = false
    }

    // Pack the bare minimum into the APK. Excludes a metadata file that
    // multiple Kotlin libraries ship and which trips the manifest merger
    // with a duplicate-file error. Standard Android boilerplate.
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    // Tests run on the host JVM (no emulator) — fast, free, all our coverage
    // for Phase 6. Instrumented tests are deferred per PLAN.md L308.
    testOptions {
        unitTests {
            isReturnDefaultValues = true
            // Make Robolectric-free unit tests fail-fast when they accidentally
            // touch the Android framework classes (which return mock-defaults
            // by, well, default). We keep `isReturnDefaultValues = true` for
            // ergonomics on simple stubs.
        }
    }

    lint {
        // Don't abort the build on lint warnings during early scaffolding.
        // We'll tighten this once we have a baseline of clean code.
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = false
    }
}

// Kotlin compilation options. The `-Xexplicit-api=strict` flag is what gives
// us PLAN.md's "explicit API mode" — every public/internal declaration must
// state its visibility (no implicit `public`) and its return type (no
// inference for top-level signatures). Closest cultural mirror to Swift's
// `public` requirement.
//
// We deliberately do NOT pin a specific `jvmToolchain(...)` here. Reasoning:
//   - On developer machines we already pre-install OpenJDK (currently 20).
//   - On GitHub Actions, `actions/setup-java@v4` provides JDK 21 LTS.
//   - Asking Gradle for a specific toolchain (e.g. 17) would either require
//     every developer to also install JDK 17, or fall back to network-based
//     toolchain auto-provisioning. Both add friction for a learning project.
//   - The compileOptions sourceCompatibility/targetCompatibility = 17 above
//     pins the BYTECODE level, which is what Android cares about. The JVM
//     running the compiler can be any 17+.
kotlin {
    explicitApi()
    // Pin Kotlin's bytecode target to 17 to match the Java toolchain above.
    // Without this, Kotlin defaults to "whatever JVM is running Gradle"
    // (locally that's JDK 20), which AGP rejects with an "inconsistent JVM
    // target" error because the Java compile is pinned to 17.
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // AndroidX core + lifecycle.
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    // Compose BOM: importing it as a `platform` BOM means every individual
    // androidx.compose.* artifact below resolves to the matching version
    // baked into the BOM. The BOM is also added to androidTest classpath
    // separately so test artifacts match.
    implementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(platform(libs.androidx.compose.bom))

    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)

    // Compose previews & runtime tooling — debug-only so they don't ship in
    // a release APK. `ui-test-manifest` writes a debug-only manifest used by
    // androidx.compose.ui.test.junit4.
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    // Networking.
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation(libs.ktor.client.logging)

    // Serialization runtime.
    implementation(libs.kotlinx.serialization.json)

    // Coroutines.
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    // Encrypted SharedPreferences for refresh-token storage.
    implementation(libs.androidx.security.crypto)

    // Tests.
    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)
}
