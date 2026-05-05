# ios/

Native iOS client for shared-list. Swift 6, SwiftUI, iOS 26 minimum.

The Xcode project is generated from `project.yml` via [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `SharedList.xcodeproj` is gitignored. See `project.yml` for why.

## First-time setup

```bash
brew install xcodegen
cd ios
xcodegen generate
open SharedList.xcodeproj
```

Set the **DEVELOPMENT_TEAM** field in Xcode (Signing & Capabilities) the first time you open the project. The team ID isn't checked into `project.yml` because it's machine-/account-specific.

## Running against the local backend

The backend hostname is `Santoshs-MacBook-Pro-48.local`, served via Caddy with mkcert TLS. iOS only trusts mkcert certs when the mkcert root CA is installed on the device:

- **Simulator**: trusts the host machine's keychain automatically — no extra step.
- **Physical iPhone**:
  1. Find the mkcert CA path: `mkcert -CAROOT`.
  2. AirDrop or email `rootCA.pem` to the phone.
  3. Settings → Profile Downloaded → Install.
  4. Settings → General → About → Certificate Trust Settings → toggle on for the mkcert CA.

Without this, every request fails with a TLS handshake error.

## Layout

- `App/` — `@main` app entry, `AppContainer` (manual DI root)
- `Core/Keychain/` — `KeychainStore` wrapper around `Security.framework`
- `Core/Networking/` — `APIClient`, error types, `URLSession` config
- `Core/Auth/` — `TokenStore`, `AuthService`, auth DTOs
- `Features/Auth/` — `RootView`, `LoginFlowView`, view models
- `Resources/` — `Info.plist`, asset catalogs (added when icons exist)

## Tests

```bash
cd ios
xcodegen generate
xcodebuild test -scheme SharedList -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'
```

### Drainer integration tests (env-gated)

`SharedListTests/DrainerIntegrationTests.swift` exercises the slice-C.3 drainer against a real running backend (Postgres + Hono). To keep `xcodebuild test` fast for the unit suite, the integration tests skip silently when `BACKEND_URL` is not set in the environment.

To run them locally:

```bash
# Terminal 1 — start the backend (this brings up Postgres + Bun via the
# instructions in backend/README.md)
cd backend
docker compose up -d
bun run dev
```

```bash
# Terminal 2 — run the iOS suite with BACKEND_URL pointing at the live
# backend. The tests sign up a fresh user per run so re-runs don't 409.
cd ios
xcodegen generate
BACKEND_URL=https://Santoshs-MacBook-Pro-48.local \
  xcodebuild test \
  -scheme SharedList \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=latest' \
  -only-testing:SharedListTests/DrainerIntegration
```

Why env-gated and not Testcontainers-from-Swift: PLAN.md L380 only requires "real backend", not "test self-bootstraps the backend." Booting Bun + Postgres from `Process` calls in Swift adds CI fragility (DOCKER_HOST detection, Bun install path, port collisions, lifecycle on test crash) for no correctness gain — a real backend at a URL is just as "real" whether the test launched it or not. The trade-off is a slightly more involved CI workflow (it boots the backend in a step before running `xcodebuild test`), which is what `.github/workflows/ios-integration.yml` does.

The CI workflow runs the backend on **plain HTTP at `localhost:3000`** (no Caddy in CI) — the iOS Info.plist has localhost / 127.0.0.1 ATS exceptions that allow insecure HTTP on those hosts only. That's deliberate: installing mkcert + Caddy on a GitHub macOS runner for one integration test is significantly more setup than a scoped ATS exception, and loopback traffic never leaves the runner so the security weakening is theoretical. Production never points iOS at localhost.

For local runs you have both options: hit the full Caddy-fronted HTTPS URL (`https://Santoshs-MacBook-Pro-48.local`) as shown above, or hit Bun directly over plain HTTP (`http://localhost:3000`) if you don't want to set up mkcert. Both work because of the same ATS exceptions.
