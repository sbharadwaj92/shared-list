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
