// App module build file. This is where almost every Android-specific
// configuration lives — SDK levels, applicationId, signing, ProGuard rules,
// the dependency list, the explicit-API-mode opt-in.

import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Read an optional `BACKEND_BASE_URL` override from `android/local.properties`.
//
// Why: the Android Emulator and physical devices need DIFFERENT backend URLs
// for the same `debug` variant (the emulator's NAT can't resolve .local mDNS,
// but routes 10.0.2.2 → host loopback; physical devices resolve .local
// natively over Bonjour). Hardcoding a single literal forces a
// build.gradle.kts edit (and a commit, if you forget to revert) every time
// you switch between emulator and phone.
//
// Solution: `local.properties` is the standard Gradle place for machine-
// specific config (it's where `sdk.dir` already lives) and is gitignored. A
// developer drops a single line in there:
//
//     BACKEND_BASE_URL=https://Santoshs-MacBook-Pro-48.local
//
// to target the physical device. Omit the line and the build defaults to
// `https://10.0.2.2` for the emulator. Either way the override never reaches
// CI or other developers' checkouts.
//
// `Properties().load(...)` is the JDK's stdlib parser for the .properties
// format Java/Gradle have used forever. We catch the missing-file case
// because a fresh clone won't have local.properties until first sync.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val backendBaseUrlDebug: String = localProperties.getProperty("BACKEND_BASE_URL", "https://10.0.2.2")
val backendBaseUrlRelease: String = "https://Santoshs-MacBook-Pro-48.local"

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
            // Backend URL: defaults to https://10.0.2.2 (emulator). Override
            // via `BACKEND_BASE_URL=...` in `android/local.properties` to
            // target a physical device on the same Wi-Fi. See the
            // localProperties block at the top of this file for rationale.
            buildConfigField("String", "BACKEND_BASE_URL", "\"$backendBaseUrlDebug\"")
        }
        release {
            // ProGuard / R8 only matter when we ship; for a learning project
            // where every install is local, leaving minification off keeps the
            // build deterministic. Flip this on later if we ever ship to Play.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "BACKEND_BASE_URL", "\"$backendBaseUrlRelease\"")
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
    // plugins block). Without the plugin, this flag is a no-op. We also
    // enable `buildConfig` so the `buildConfigField(...)` calls in the
    // buildTypes block emit a generated `BuildConfig` class with our
    // BACKEND_BASE_URL constant; AGP 8.x defaults this off.
    buildFeatures {
        compose = true
        buildConfig = true
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
    // for Phase 6+. Instrumented tests are deferred per PLAN.md L308.
    testOptions {
        unitTests {
            isReturnDefaultValues = true
            // Robolectric (Phase 8) needs the Android resources in the test
            // classpath so it can spin up a fake Context. Cheap to enable
            // for all unit tests — pure-JVM tests don't load the resources.
            isIncludeAndroidResources = true
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

    // Room — local-first cache for sync engine (Phase 8). The compiler runs via
    // KSP and generates DAO implementations at compile time; the runtime lib is
    // what the generated code calls into; the ktx artifact adds suspend-aware
    // DAO support and Flow return types.
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // Tests.
    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.androidx.room.testing)
    // Robolectric runs Android-framework code on the host JVM. Required
    // for the sync stack's Room tests (Room's database builder needs a
    // Context, which the bare JUnit runner can't provide).
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}
