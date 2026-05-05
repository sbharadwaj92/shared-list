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

### Drainer integration tests (env-gated, manual)

`SharedListTests/DrainerIntegrationTests.swift` exercises the slice-C.3 drainer against a real running backend (Postgres + Hono). To keep `xcodebuild test` fast for the unit suite, the integration tests skip silently when `BACKEND_URL` is not set in the environment.

**These tests do NOT run in CI.** Slice D's first attempt was a workflow that booted Postgres via Colima on a GitHub `macos-15` runner, but GitHub's hosted macOS runners don't support nested virtualization (no `VZ.framework` / no `HVF`), so Colima can't boot its VM, no Docker, no Postgres, no backend. The chain isn't fixable from inside a workflow; it needs either a self-hosted macOS runner, a split-runner tunneling setup, or an embedded-Postgres swap. Treated as a Phase-19-polish open question — the unit suite + the backend's own Testcontainers tests cover the wire contract, so this isn't a coverage hole, just an inability to gate PRs on a real-network round-trip in CI.

**Run them locally before merging anything that changes the wire shape** (backend route changes, DTO field renames, new mutation types). The convention: run the integration suite locally, paste the test summary into the PR body, then merge.

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
  -only-testing:SharedListTests/DrainerIntegrationTests
```

You can also hit Bun directly over plain HTTP (`http://localhost:3000`) without going through Caddy + mkcert — the iOS Info.plist has scoped `localhost` / `127.0.0.1` ATS exceptions allowing insecure HTTP on those hosts only. Useful when you don't want to set up mkcert on a fresh machine.

Why env-gated and not Testcontainers-from-Swift: PLAN.md L380 only requires "real backend", not "test self-bootstraps the backend." Booting Bun + Postgres from `Process` calls in Swift adds CI fragility (DOCKER_HOST detection, Bun install path, port collisions, lifecycle on test crash) for no correctness gain — a real backend at a URL is just as "real" whether the test launched it or not.
