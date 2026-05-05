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

The backend is served via Caddy with mkcert TLS (PLAN.md L130). The cert covers two SANs:
- `Santoshs-MacBook-Pro-48.local` — for physical devices (Bonjour/mDNS resolves it natively over Wi-Fi).
- `10.0.2.2` — the well-known Android Emulator alias for the host's loopback (the emulator's NAT doesn't run a Bonjour responder, so `.local` doesn't resolve there).

### Picking the right URL

The debug build's `BACKEND_BASE_URL` defaults to `https://10.0.2.2` so the emulator just works on a fresh clone. To target a physical device instead, copy `local.properties.example` to `local.properties` and uncomment the override:

```
BACKEND_BASE_URL=https://Santoshs-MacBook-Pro-48.local
```

`local.properties` is gitignored — every developer can have a different override without touching committed code or CI. Switch back to the emulator by commenting the line out (or deleting the file). Release builds always use the `.local` hostname (irrelevant for v1 since we don't ship release builds).

### Trust the mkcert root CA on the device

Android doesn't trust your mkcert root by default. Install it once per device:

```bash
# Find the mkcert CA path:
mkcert -CAROOT
# That gives you a directory containing rootCA.pem.

# Push it to the device's Downloads folder via ADB (works for both
# emulator and physical):
adb -s <SERIAL> push "$(mkcert -CAROOT)/rootCA.pem" /sdcard/Download/
```

Then on the device: **Settings → Security and privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate → "Install anyway" → Browse → Downloads → rootCA.pem**.

Debug builds also opt into the user trust store via `src/debug/res/xml/network_security_config.xml`. Without that opt-in, Android 7+ apps would reject the user-installed CA at TLS handshake time.

### Same Wi-Fi network

For physical devices, the phone and Mac MUST be on the same Wi-Fi network without "AP isolation" / "guest network" restrictions. Sanity check from the phone's browser:
- Open Chrome → `https://Santoshs-MacBook-Pro-48.local/health` → expect `{"ok":true}` with a green padlock.
- If the padlock shows a warning, the mkcert root CA isn't trusted — re-do the cert install above.
- If "DNS_PROBE_FINISHED_NXDOMAIN", the phone can't reach the Mac via Bonjour — check the network setup.

## Layout

- `app/src/main/java/in/santosh_bharadwaj/sharedlist/`
  - `app/` — `SharedListApplication`, `MainActivity`, `AppContainer`, `LocalAppContainer`
  - `core/auth/` — `TokenStore`, `AuthService`, auth DTOs
  - `core/networking/` — `ApiClient` (Ktor), `JsonCoders` (the wire-format `Json` instance + `Instant` serializer), error types
  - `core/storage/` — `SecureStorage` (EncryptedSharedPreferences wrapper) + in-memory test impl
  - `core/sync/` — `SyncDatabase` (Room), entities + DAOs, `SyncEngine` (read-side reconciler), `Mutator` (writes + queue), `Drainer` (queue → HTTP), `NetworkMonitor`, sync DTOs
  - `core/ui/` — `SharedListTheme` (Material 3)
  - `features/auth/` — `RootScreen`, `LoginFlowScreen`, `LoginFlowViewModel`, preview support
- `app/src/test/` — pure-JVM unit tests (Robolectric for the Room-touching ones; `SyncFuzzTest` and `DrainerIntegrationTest` for the sync stack)
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

## Sync engine integration tests

`DrainerIntegrationTest` is **env-gated** against the live backend. The test class calls `assumeTrue(BACKEND_URL != null)`, so a plain `./gradlew testDebugUnitTest` skips it silently — `gradle` reports it as "skipped", not "failed".

To run it before merging anything that changes the wire shape:

```bash
# Terminal 1 — start the backend.
cd backend
bun run dev   # or: docker compose up -d

# Terminal 2 — run the integration tests against it.
cd android
BACKEND_URL=https://Santoshs-MacBook-Pro-48.local \
  ./gradlew :app:testDebugUnitTest --tests '*DrainerIntegrationTest*'
```

The tests sign up a fresh user per run (unique email suffix) so they're isolated from each other. They cover:
- `createListRoundTripsThroughBackend` — POST → drain → reconcile → canonical row appears locally.
- `offlineMutateThenReconnectDrains` — Mutator enqueues while offline, drainer is no-op, going online + ticking flushes the queue.

CI runs are deferred — same convention as iOS, see commit history for the "leave-as-manual-pre-merge" decision rationale (GitHub's macOS runners couldn't nest-virtualize for Postgres; we kept the convention symmetric on Android even though Linux runners technically could). Revisit in Phase 19 polish.
