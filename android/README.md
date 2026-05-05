# android/

Native Android client for shared-list. Kotlin 2.x, Compose, minSdk 35.

## First-time setup

```bash
# JDK 17+ on PATH (we use 21 LTS in CI; locally 17/18/19/20 all work).
java -version

# Open the project in Android Studio: File → Open → /android
# Studio will sync Gradle automatically.

# Or build from CLI:
cd android
./gradlew :app:assembleDebug
```

The Gradle wrapper at `android/gradlew` is the source of truth — every developer (and CI) gets Gradle 8.10.2. There is no global `gradle` install required.

## Running against the local backend

The backend hostname is `Santoshs-MacBook-Pro-48.local`, served via Caddy with mkcert TLS (PLAN.md L130). Android only trusts the mkcert root CA when it's installed on the device.

### Physical Samsung Galaxy S24 Ultra
1. Find the mkcert CA path: `mkcert -CAROOT`
2. Email or AirDrop `rootCA.pem` to the phone (Android Files / Gmail attachment).
3. Settings → Security and privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate → pick the file.
4. The phone resolves `Santoshs-MacBook-Pro-48.local` natively over the same Wi-Fi as the Mac (Bonjour/mDNS Just Works on modern Android).

### Android Emulator
The emulator routes traffic through a NAT and **may not resolve `.local` names** because it doesn't run a Bonjour responder. Two options if you hit this:

**Option A (preferred)**: install the mkcert CA into the emulator's user trust store the same way as a physical device, and rely on mDNS working through the emulator's bridge. Some images do, some don't.

**Option B (fallback)**: route to the host loopback alias and bypass mDNS entirely:
- `10.0.2.2:443` is the well-known emulator alias for the Mac's `localhost` (so the emulator hits Caddy on the host directly).
- Caddy's mkcert cert needs to also have a SAN for `10.0.2.2` if you go this route. Either regenerate the cert (`mkcert -install Santoshs-MacBook-Pro-48.local 10.0.2.2`) or accept the cert error in the emulator's WebView during a one-time browse.

If Option B is needed, override `AppContainer.DEFAULT_BASE_URL` in a debug-only build variant (TBD — Phase 6 ships with the literal hostname; we'll add the variant once we hit the empirical issue).

## Layout

- `app/src/main/java/in/santosh_bharadwaj/sharedlist/`
  - `app/` — `SharedListApplication`, `MainActivity`, `AppContainer`, `LocalAppContainer`
  - `core/auth/` — `TokenStore`, `AuthService`, auth DTOs
  - `core/networking/` — `ApiClient` (Ktor), error types
  - `core/storage/` — `SecureStorage` (EncryptedSharedPreferences wrapper) + in-memory test impl
  - `core/ui/` — `SharedListTheme` (Material 3)
  - `features/auth/` — `RootScreen`, `LoginFlowScreen`, `LoginFlowViewModel`, preview support
- `app/src/test/` — pure-JVM unit tests (no emulator)
- `gradle/libs.versions.toml` — version catalog
- `config/detekt/detekt.yml` — Detekt rules

## Common commands

```bash
# Quick local CI gauntlet (mirrors what GitHub Actions runs).
./gradlew detekt :app:testDebugUnitTest :app:assembleDebug

# Tests only.
./gradlew :app:testDebugUnitTest

# Just the lint (fast, runs without compiling the whole app).
./gradlew detekt

# Install on a connected device or running emulator.
./gradlew :app:installDebug
adb shell am start -n in.santosh_bharadwaj.sharedlist/.app.MainActivity
```
