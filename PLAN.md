# Shared List App — Stack, Architecture & Implementation Phasing

## Context

The owner is an experienced frontend engineer (React/TS) broadening into backend, native mobile, and DevOps fundamentals. They have 20 hrs/week and no deadline; the goal is **depth of learning over speed to ship**. Cloud infra and store publishing were **explicitly dropped from scope** (decision made mid-conversation when EKS cost/complexity was overwhelming the core learning goals). The app is a **shared grocery/todo list** for ~3 users (self + friend), running entirely on the owner's M2 Max with phones connecting over local WiFi.

Devices: iPhone 15 Pro Max (latest iOS) + Samsung Galaxy S24 Ultra (latest Android). Both flagship, both on latest OS — justifies "latest only" platform philosophy.

This plan captures every stack and architecture decision and the implementation phasing in a single source of truth. No code has been written yet. Phasing assumes the user's stated preferences: **lockstep across all three codebases per feature**, **sync engine and WebSockets + push built as foundations before CRUD UI**, and **~19 phases of 1–3 weeks each**. The user explicitly accepted that the first ~3 months produce no user-visible UI under this approach.

---

## Project shape

- **Local path**: `~/Projects/shared-list/` on the user's M2 Max (Projects directory is the user's standard location for git repos).
- **Repo**: One public GitHub monorepo. Top-level: `backend/`, `ios/`, `android/`, plus root config (`package.json` for Bun workspaces, `lefthook.yml`, `.github/workflows/`, `README.md`).
- **Workspaces**: Bun workspaces enabled at root from day one (`workspaces: ["backend", ...]`) even though only one TS package today — user opted in for future-proofing.
- **Branching**: GitHub Flow — `main` always shippable, short-lived feature branches, PRs into `main`, branch protection requires passing CI.
- **CI**: GitHub Actions, three workflows (backend, iOS, Android). Public repo unlocks free macOS runners. Backend job runs on Linux with Postgres service container; iOS job on macOS runner with Xcode + xcodebuild; Android job on Linux with Gradle. Instrumented Android tests deferred to local-only. **iOS and Android workflows are added in Phases 5 and 6** when those projects exist; Phase 1 only sets up backend CI scaffolding.

---

## Operational realities

This is a local-only app. The following are accepted, not bugs to be fixed:

- **Mac asleep / lid closed**: backend is unreachable. Apps show offline indicator, queue mutations locally, and reconcile when the Mac is awake again. No `caffeinate` workaround — the offline path must work anyway.
- **Phone on cellular (away from home)**: same as above. App is read-only against cached data; mutations queue. `.local` mDNS only resolves on the home LAN; this is acceptable.
- **WiFi roaming / IP changes**: `.local` hostname insulates against IP changes on the same LAN. No-op.
- **Mac off entirely**: equivalent to extended offline. Sync engine handles it.
- **Two devices for the same user signed in simultaneously** (e.g. Simulator + iPhone): each install is independent — own SwiftData/Room store, own mutation queue. They converge via WS + reconciliation, just like two different users would. May briefly show different state.

---

## Backend stack

### Runtime + framework
- **Bun** (not Node) — modern DX, native TS, built-in test runner, fast on M2 Max
- **Hono** (not Fastify/Express/Elysia) — first-class Bun support, modern TS-first, small surface area
- **Postgres 17** in Docker (`postgres:17-alpine` image), via `docker-compose.yml`
- **Backend runs on host** via `bun --watch` for fastest iteration (rejected "everything in Docker" after considering iteration friction)
- **Caddy on host** via Homebrew for local TLS reverse proxy

### Data layer
- **Drizzle ORM** with `drizzle-orm/bun-sql` driver (using `Bun.sql` native Postgres client; fall back to `postgres.js` only if Drizzle integration has rough edges)
- **Drizzle Kit** for migrations (auto-generated SQL from schema diffs; always read before applying)
- **UUID v7** primary keys via `Bun.randomUUIDv7()` — mobile-friendly (clients generate offline) + time-ordered for Postgres index locality
- **Soft delete + 90-day purge**: every user-deletable table has `deleted_at TIMESTAMPTZ NULL`. All reads filtered via repo-layer helpers (`activeItems()` etc.); raw `db.select().from(items)` only allowed in the purge job. Cascade soft-delete in same transaction (deleting a list also stamps items). pg-boss cron runs daily, hard-deletes rows with `deleted_at < NOW() - INTERVAL '90 days'`.

### Schema (v1)
Tables: `users`, `lists`, `list_members`, `items`, `device_tokens`, `list_invites`, `refresh_tokens`. All UUID v7 PKs. `list_members.role` enum: `owner | editor` (add `viewer` later). `items.position` integer (revisit fractional indexing if drag-to-reorder UX demands). Every entity gets `updated_at TIMESTAMPTZ` set via trigger on every write — this is the lamport-ish clock for last-write-wins conflict resolution in the iOS and Android sync engines.

**Authorization rules** (enforced at handler level, not DB):
- `DELETE /lists/:id` requires the caller's `list_members.role = 'owner'`. Soft-delete cascades to items in the same transaction.
- Members of a deleted list see the tombstone on next sync; the list disappears from their UI.
- No `leave list` endpoint in v1 (members can't self-remove). Owner-deletion is the only way a list goes away.
- No undelete UI in v1. Soft-delete + 90-day window is purely for sync convergence; from the user's perspective, delete is final.

### Sync protocol (to support offline-first iOS + Android clients)
- Mutation endpoints return full canonical entity (not bare `200 OK`)
- `GET /<resource>?since=<timestamp>` endpoints return entities (including soft-deleted) with `updated_at > since`
- Optional `If-Match: <updated_at>` header for conditional writes (returns 409 on mismatch)
- Soft-deleted rows act as tombstones during 90-day window — clients see `deleted_at` and remove from local view
- **Idempotency**: client-generated UUID v7 on `POST` so retries don't double-create. Server uses `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING *`; the canonical row is returned either way.
- **WS reconnect recovery**: on every WS reconnect, the client first calls `?since=<lastSync>` for each subscribed resource type, applies tombstones + updates, then resubscribes. WS events are then layered on top. WS is best-effort; correctness lives in the `since` endpoints.

### Auth
- Roll-own JWT with `jose` library (no Cognito, no Auth0)
- **Bun.password** with **argon2id** for password hashing
- **Access token**: signed JWT, 15 min TTL, stateless
- **Refresh token**: opaque random string, stored in DB with `(user_id, token_hash, expires_at, used_at)`, single-use (rotates on each `POST /auth/refresh`). Hash at rest (sha256) so a DB compromise doesn't yield bearer tokens.
- **Reuse detection**: when a refresh token with `used_at IS NOT NULL` is presented, delete *all* `refresh_tokens` rows for that `user_id`. Active access tokens (15 min) remain valid until expiry — no token blocklist needed at this scale. User is forced to re-login on all devices within 15 min.
- **Single-flight refresh on the client**: APIClients (iOS + Android) coordinate concurrent 401s — the first 401 starts a refresh, all subsequent 401s await the same in-flight refresh promise and retry with the new access token. Without this, parallel requests trigger reuse-detection panic.
- Mobile stores refresh token in OS-secure storage (Keychain / Android Keystore); access token in memory only.

### API surface
- **REST** (not GraphQL, not tRPC)
- **Zod** for validation via `@hono/zod-validator`; use `drizzle-zod` to derive schemas from Drizzle tables (no double-defining)
- **OpenAPI** auto-generated via `@hono/zod-openapi` (`createRoute({...})`); Swagger UI served at a route
- **Error handling**: throw exceptions, central `app.onError()`, `HTTPException` for known HTTP errors (e.g. `throw new HTTPException(404, {message: 'list not found'})`); unknown errors → generic 500 with logging + sanitized response
- **Rate limiting**: `hono-rate-limiter` with in-memory store. Login 5/min/IP, signup 3/hour/IP, refresh 60/min/IP, invite-accept 30/min/IP. In-memory is fine because backend runs as a single Bun process under `bun --watch`.
- **CORS**: skipped (native mobile clients don't enforce CORS; Swagger UI is same-origin)

### Async work
- **pg-boss** for background jobs (Postgres-backed queue) — used for push notification delivery, scheduled cleanup (90-day purge), other periodic work
- **WebSockets** (Bun-native via `Bun.serve`'s `websocket` handler) — single connection per user, with explicit subscribe/unsubscribe messages over the connection. Server-side: `user_id → socket` map + per-socket subscription set. Typed messages like `{type: 'subscribe', listId: '...'}`. Built after polling is working as a focused WebSocket-learning step.
- **WebSocket auth**: client connects to `wss://host/ws?token=<access-jwt>`. Server validates the JWT during the upgrade handshake; rejects upgrade on invalid/expired. Token in query string is acceptable for this single-process local backend (no shared-host log leak risk). Client reconnects with the latest access token (single-flight refresh handles expiry mid-session).

### Push notifications
- **APNs (iOS) + FCM (Android) directly from Bun backend** — no abstraction layer
- APNs: HTTP/2 with `.p8` auth key, sign JWTs per request, **sandbox endpoint only** (free Apple ID limitation). Note: sandbox tokens are distinct from prod; this means no "real" APNs path until paid Apple Dev — accepted.
- FCM: HTTP v1 API with OAuth 2 tokens from service account JSON
- Both have free dev modes, no money required
- **Pattern: silent push → client syncs → client posts local notification.** Backend sends content-available APNs / data-only FCM with `priority: high` (FCM) so messages bypass Doze on Android. Payload is minimal — just enough for the client to know what to fetch (e.g. `{listId, eventType}`). Client wakes, calls `?since=<lastSync>`, then constructs and posts a local notification with the right human-readable text. This keeps backend out of UI/i18n concerns.
- `device_tokens` table: `(user_id, platform, token, last_seen_at)` — one user can have multiple devices. Each device's install is independent; their tokens don't conflict.

### Email
- **Mailpit** Docker container (fake SMTP at `localhost:1025`, web UI at `localhost:8025`) + **nodemailer**
- Used only for password reset (sharing uses join codes, not email invites)

### Sharing flow
- **Join code** (not email invite, not deep link) — backend generates 8-char code, user shares out-of-band (WhatsApp, iMessage, voice), recipient types into "join list" screen
- `list_invites` table: `(code PK, list_id, created_by, created_at, expires_at, used_at, used_by)`. Codes expire after 24h or first use.
- Rate limit `POST /invites/:code/accept` at 30 req/min/IP via `hono-rate-limiter` (same pattern as auth endpoints). 8-char base32 = 40 bits; rate limiting makes guessing untenable even if entropy alone is borderline.
- No deep linking → no Universal Links / `apple-app-site-association` complexity

### Project structure
- Hybrid feature-based: `src/features/<domain>/` (auth, users, lists, items) for business logic, `src/infra/` (db, logger, middleware) for cross-cutting
- Tests co-located with code

### Env config
- Typed config module — Zod-validated `process.env` parsed once at startup, exported as typed `config` object
- Bun reads `.env` automatically (no `dotenv` import)
- Missing/malformed env vars fail loudly at boot, not at runtime

### Logging + observability
- **Pino** for everything (no separate Hono `logger()` middleware), all logs in one JSON format
- **Request ID middleware**: generate UUID per request (or accept inbound `X-Request-ID`), attach Pino child logger with `{reqId, method, path}` to context, every log within request carries the reqId, echo back in response header
- OpenTelemetry deferred to optional later phase

### Testing
- **`bun test`** (Bun's built-in, Jest-compatible API) — zero setup
- **Testcontainers** for integration tests requiring Postgres — real container per suite, torn down after

### Local TLS / hostname
- **Caddy** reverse proxy on host (Homebrew) + **mkcert** for trusted local certs
- Caddy listens on 443, terminates TLS, proxies to Hono on port 3000
- mkcert local CA installed in Mac + iOS Simulator + iPhone + Android Emulator + physical Android trust stores
- **Hostname**: Mac's `.local` mDNS name (e.g., `Santoshs-MacBook-Pro-48.local`) — works across all devices on same WiFi, IP changes don't break anything
- Known gotcha: Android Emulator may need workaround for `.local` (no native Bonjour) — fall back to host alias or `10.0.2.2` if hit

### Lint + format + hooks
- **Biome** (single tool — formatter + linter + import sorter)
- **Lefthook** for git pre-commit hooks (parallel execution, no Node deps; runs Biome + `bun test`)

---

## iOS stack

### Foundations
- **Minimum iOS version**: iOS 26 (only target is user's iPhone)
- **Tooling**: Xcode 26.x, Swift 6
- **Swift 6 strict concurrency** enabled — accept early friction with `@MainActor`, `Sendable`, `nonisolated`
- **Project type**: standard `.xcodeproj` (not Swift Package as app)
- **Dependency manager**: Swift Package Manager only (no CocoaPods, no Carthage)

### Code organization
- Single app target with folder-based hybrid structure for v1
- Folders: `App/`, `Features/{Auth, Lists, ListDetail, Settings}/`, `Core/{Networking, Storage, Auth, UI}/`, `Resources/`
- Test targets: `SharedListTests/`, `SharedListUITests/`
- Planned later refactor to local SPM packages per feature (after monolith friction is felt) — itself a learning exercise

### Architecture
- **MVVM with `@Observable`** (Swift Macro, iOS 17+) — Apple's current recommended pattern, maps to user's React mental model
- View models are pure `@Observable` classes injected into views via `@State`-initialized-in-`init`
- Pure-Swift view models are unit-testable without SwiftUI

### Dependency injection
- Single `@Observable` `AppContainer` class holding all services (`apiClient`, `tokenStore`, `syncEngine`, `networkMonitor`, etc.)
- Constructed once at app root, injected via `.environment(container)`
- Views grab via `@Environment(AppContainer.self)` and pass to view model `init`s
- No singletons, no third-party DI framework — trivially mockable in tests/previews

### Navigation
- **`TabView`** at root with two tabs (`Lists`, `Settings`)
- Each tab has its own **`NavigationStack`** with **value-based navigation** via `.navigationDestination(for:)` (push values like `ListID`, views resolved by type)
- Per-tab back stacks preserved across tab switches
- Programmatic navigation via `path.append(...)`
- No coordinator pattern (UIKit-era, obsoleted by value-based NavigationStack)

### App entry / auth gating
- **Single `RootView`** switches on `AuthState.status`:
  - `loading` → `SplashView` (during initial Keychain refresh-token check)
  - `signedOut` → `LoginFlowView`
  - `signedIn(User)` → `MainTabView`
- `AuthState` is `@Observable`, lives in `AppContainer`
- Logout transitions back automatically; no anonymous browsing

### Networking
- **`URLSession` + `Codable` + thin custom `APIClient` wrapper** for v1
- `APIClient` centralizes: base URL, auth header injection, 401 → token refresh, JSON encode/decode, error mapping
- **No Alamofire**
- **Planned later exercise**: regenerate API client via Apple's `swift-openapi-generator` from backend's OpenAPI spec to compare hand-written vs generated approaches

### Persistence (on-device)
- **SwiftData** (`@Model` macro, iOS 17+) — replaces Core Data for new projects
- Caches lists/items locally; screens load instantly with stale data, refresh in background
- Auth tokens in **Keychain** (separate from SwiftData)
- User preferences in **UserDefaults** (theme, last-opened list, etc.)
- Schema versioning via `VersionedSchema` types when migrations needed

### Sync engine (the big one)
- **Offline-first with persistent write queue** — most ambitious single decision
- Every mutation: (1) applies to SwiftData immediately for instant UI, (2) appends to durable local mutation queue (`id, op_type, target_id, payload, created_at, status, retry_count`), (3) drained in background when online via `NWPathMonitor`, (4) reconciled on app launch / foreground via full server pull
- **Conflict resolution**: last-write-wins with server `updated_at` timestamp (simplest correct strategy for a list app)
- **Idempotency**: client-generated UUID v7 PKs (already chosen) provide retry safety
- **Tombstones**: existing soft-delete `deleted_at` + 90-day server retention (already chosen) — soft-deleted rows flow to clients during retention window
- User accepted ~2-3 weeks dedicated sync work + ~1 week backend protocol work
- Aware that production apps often use sync engines (CloudKit / Replicache / ElectricSQL); building from scratch is the learning version

### Network reachability
- **`NWPathMonitor`** (Network framework) for proactive online/offline detection — drives sync queue draining
- Combined with try-the-request-and-fail fallback for "online but API unreachable" cases (captive portal, DNS, Mac off)
- Failed API calls re-queue with exponential backoff
- Single `@Observable` `NetworkMonitor` exposed app-wide

### Push notifications
- **`UserNotifications` framework** (`UNUserNotificationCenter`)
- **Permission requested in-context** when user first creates/joins a shared list ("get notified when this list changes?"); fallback toggle in Settings
- SwiftUI app uses `@UIApplicationDelegateAdaptor` with minimal AppDelegate to receive `didRegisterForRemoteNotificationsWithDeviceToken: Data`
- On token receipt: send to backend `POST /devices` with `{platform: "ios", token, last_seen_at}`
- **Sandbox APNs only** (`api.sandbox.push.apple.com`) — free Apple ID = sandbox only

### WebSocket client
- **`URLSessionWebSocketTask`** (Apple-native, iOS 13+, async/await) — same `URLSession` carries HTTP and WS, auth header consistent
- Hand-built `WebSocketManager` (no Starscream): connection lifecycle, exponential backoff reconnection, heartbeat/ping for dead-connection detection, resubscribe on reconnect (server forgets subs on disconnect), message dispatch via SyncEngine, close on background / reopen on foreground

### Testing
- **Swift Testing** (`@Test` macros, `#expect(...)`) for unit tests — view models, sync engine, networking, repos
- **Minimal XCTest UI tests** for critical-path smoke (login flow, create list) — kept small
- **No** ViewInspector, **no** snapshot testing in v1
- iOS device install: **free Apple ID, 7-day reinstall cycle** accepted (no $99 Apple Developer Program)

---

## Android stack

### Foundations
- **SDK levels**: `minSdk = 35`, `compileSdk = 35` (or 36 if available), `targetSdk = 35` — Android 15, what S24 Ultra runs. Mirrors "latest only" iOS philosophy.
- **Kotlin 2.x** with strict null safety
- **Build system**: Gradle **Kotlin DSL** (`build.gradle.kts`) + **version catalogs** (`gradle/libs.versions.toml`)
- **Strictness opt-ins**: **Detekt** (coroutine ruleset) + **explicit API mode** (`-Xexplicit-api=strict`) — closest cultural mirror to Swift 6 strict concurrency

### Code organization
- Single app module with hybrid feature/core packages
- Packages: `features/{auth, lists, listDetail, settings}/`, `core/{networking, storage, auth, ui}/`
- Tests in standard Android `src/test/` (unit) and `src/androidTest/` (instrumented)

### Architecture
- **MVVM** with `ViewModel` + `StateFlow<UiState>` (single immutable `*UiState` data class per screen)
- ViewModels expose `val uiState: StateFlow<UiState>` from a private `MutableStateFlow`
- Composables collect via `collectAsStateWithLifecycle()`
- Room queries (`Flow<...>`) bridged to StateFlow via `stateIn(viewModelScope, started = WhileSubscribed(5_000), ...)`
- Mirrors iOS single-source-of-truth `@Observable` pattern; pure-JVM testable

### Dependency injection
- **Manual `AppContainer`** mirroring iOS — exposed via Compose `CompositionLocal` (analog of `@Environment(AppContainer.self)`)
- ViewModels take dependencies via constructor; factory pulls from container
- No Hilt, no Koin, no kotlin-inject

### Navigation
- **Compose Nav 2.8+ Type-Safe Navigation** with `@Serializable` route classes
- `sealed interface Route` with `@Serializable object/data class` cases
- Two `NavHost`s (one per tab) under a Material 3 `NavigationBar`
- Mirrors iOS per-tab `NavigationStack` + value-based navigation

### App entry / auth gating
- Single root composable switches on `AuthState.status` (loading / signedOut / signedIn) — direct mirror of iOS `RootView`

### Networking
- **Ktor Client** + thin `ApiClient` wrapper + `kotlinx.serialization`
- Wrapper centralizes base URL, auth header injection, 401 → token refresh, JSON encode/decode, error mapping
- Planned later exercise: regenerate via `openapi-generator` from backend's OpenAPI spec

### Persistence (on-device)
- **Room** (Android's modern SQLite ORM) — analogous role to iOS SwiftData
- Caches lists/items locally for instant load + background refresh
- Tokens in **EncryptedSharedPreferences** (custom wrapper) — mirrors iOS Keychain choice
- User preferences in DataStore (theme, last-opened list)

### Sync engine
- **Mirrors iOS exactly** — offline-first persistent write queue (Room-backed), last-write-wins via server `updated_at` timestamp, idempotency via client-generated UUID v7 PKs, soft-delete tombstones flow during 90-day retention window

### Network reachability
- **`ConnectivityManager`** + `NetworkCallback` for proactive online/offline detection
- Try-the-request-and-fail fallback for "online but API unreachable" cases
- Failed API calls re-queue with exponential backoff

### Push notifications
- **Firebase BoM + `firebase-messaging` only** (minimum viable Firebase footprint)
- `FirebaseMessagingService` implements `onNewToken(token)` (POST to backend `/devices`) and `onMessageReceived(message)` (parse + display)
- `google-services.json` from Firebase console, in `.gitignore`
- Backend still uses FCM HTTP v1 API directly with service-account-JSON OAuth

### Notification permission (Android 13+)
- `POST_NOTIFICATIONS` requested **in-context** when user first creates/joins a shared list (mirrors iOS)
- `ActivityResultContracts.RequestPermission()` in Compose
- Check `shouldShowRequestPermissionRationale()` before requesting
- After two denies, direct user to system Settings
- Fallback toggle in app Settings screen

### WebSocket client
- **Ktor Client WebSocket** (same Ktor instance as HTTP — auth/cookies/config consistent)
- Hand-built `WebSocketManager` wrapper: connection lifecycle, exponential backoff reconnection, heartbeat ping/pong, resubscribe-on-reconnect, message dispatch via SyncEngine
- Direct mirror of iOS `WebSocketManager` design

### Logging
- **`android.util.Log` directly** with thin per-category wrapper (`Logger.networking`, `Logger.sync`, `Logger.auth` as `Tag` objects)
- Mirrors iOS `OSLog`/`Logger` pattern; filter by tag in Logcat

### Errors
- **`Result<T>`** for expected outcomes + sealed `*Error` hierarchies (e.g. `AuthError`, `SyncError`) for high-stakes paths
- Closest analog to iOS throwing + typed throws (Kotlin has no typed throws)

### Testing
- **JUnit** for unit tests (ViewModels, sync engine, networking, repos)
- **Minimal Compose UI tests** for critical-path smoke (login flow, create list)
- Instrumented Android tests deferred to local-only (not in CI)

### Previews
- **`@Preview`** on every composable using **in-memory Room DB** + mock `AppContainer`
- Direct mirror of iOS SwiftUI Previews approach

### Design system
- Light tokens (Spacing, Palette objects) + organic component extraction (3+ uses → extract)
- Lean on **Material 3** (typography, color roles)

### Internationalization
- **`strings.xml`** from day one, **English only** for now
- Adding a second language later is just a translation pass

### Accessibility
- **Free wins only** — Material 3 typography + color roles
- No explicit `contentDescription` on icon-only buttons in v1

### App icon / branding
- Deferred — Android Studio placeholder

### Build variants
- Default `debug` + `release` build types only (no `staging`, no product flavors)
- `release` reuses debug keystore (never publishing)
- Kept primarily to occasionally test R8-minified output

### Naming
- **Application ID**: `in.santosh_bharadwaj.sharedlist` (underscore — Java packages disallow hyphens)
- **App display name**: `SharedList`

---

## Implementation phasing

Twenty phases across ~10–14 months at 20 hrs/week. Each phase is 1–2 weeks of focused work with a clear "done" criterion. Phases are **strictly sequential** — each builds on the previous one's outputs.

**Sequencing principles** (per user decisions):
- **Lockstep across backend + iOS + Android** for any feature that touches all three. We do not build a feature on one platform and then come back to it on others later.
- **Sync engine and realtime infrastructure are foundational** — built before any CRUD UI exists.
- **First ~3 months produce no user-visible UI.** Visible app starts forming around Phase 10–11.
- **End of every phase is verifiable.** Each phase has explicit "done" criteria you can demo to yourself.

### Foundation block (Phases 1–3) — repo, tooling, backend skeleton

#### Phase 1 — Repo + tooling bootstrap (1 week)
Create monorepo at `~/Projects/shared-list/`. Inside: root `package.json` with Bun workspaces, `lefthook.yml`, `.gitignore`, `README.md`, `KNOWN_DEBT.md` (empty, populated per the slippage protocol), `STATUS.md` (already drafted pre-execution — commit as-is; update the "Right now" block as work begins), `LEARNING_PROTOCOL.md` (already drafted pre-execution — commit as-is), `CLAUDE.md` (already drafted pre-execution — commit as-is; this is the auto-loaded context for Claude Code sessions), and `docs/learning/` directory with a placeholder `phase-01.md` to be filled at end of this phase. Push to GitHub as a public repo named `shared-list`. Install Caddy + mkcert on host (Homebrew), generate local CA, install in macOS trust store. **No iOS or Android CI workflows yet** — those are added in Phases 5 and 6 when the projects exist. Backend CI workflow is also deferred to Phase 2 when there is real code to test (no-op CI gives false confidence). **Done:** Repo pushed to public GitHub. mkcert root cert installed. `KNOWN_DEBT.md`, `STATUS.md`, `LEARNING_PROTOCOL.md`, and `CLAUDE.md` committed. `docs/learning/phase-01.md` written per the protocol. `STATUS.md` Phase 1 marked DONE with date.

#### Phase 2 — Backend skeleton (1 week)
`backend/` with Bun + Hono + TypeScript. `docker-compose.yml` running Postgres 17 + Mailpit. Typed config module (Zod-validated env). Pino logger setup. Request-ID middleware. `/health` endpoint. Drizzle Kit configured. Biome + Lefthook hooks running. **Done:** `bun run dev` starts a server returning `{ok: true}` on `https://Santoshs-MacBook-Pro-48.local/health` (via Caddy + mkcert TLS), with structured logs and request IDs.

#### Phase 3 — Backend schema + migrations (1 week)
Drizzle schema for all v1 tables: `users`, `lists`, `list_members`, `items`, `device_tokens`, `list_invites`. UUID v7 PKs. `updated_at TIMESTAMPTZ` triggers on every table. `deleted_at` columns. Indexes on FKs and `updated_at`. Generate first migration, apply, verify with `psql`. Repo-layer helpers (`activeLists()`, `activeItems()`) that always filter `deleted_at IS NULL`. **Done:** Schema applied to Postgres, repo-layer helpers compiled and unit-tested via `bun test` against a Testcontainers Postgres.

### Auth block (Phases 4–6) — backend + iOS + Android in lockstep

#### Phase 4 — Backend auth (1–2 weeks)
`POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`. `Bun.password` with argon2id. `jose` for JWT signing. Refresh token table + rotation + reuse detection. `requireAuth` middleware that verifies access tokens. Zod request/response schemas. `@hono/zod-openapi` setup with `/swagger-ui`. `hono-rate-limiter` on auth endpoints (in-memory). Integration tests against Testcontainers. **Done:** Full auth flow works via `curl` against the local backend with TLS. Swagger UI shows the auth endpoints. Reuse of a used refresh token invalidates the user's tokens.

#### Phase 5 — iOS auth (1–2 weeks)
Create Xcode project (`SharedList`, bundle `in.santosh-bharadwaj.sharedlist`, iOS 26 min, Swift 6 strict concurrency). Folder structure (`App/Features/Core/Resources/`). Custom `KeychainStore` wrapper around `Security.framework`. `TokenStore` for access/refresh storage and rotation. `APIClient` with auth header injection, 401 → single-flight refresh → retry. `AppContainer` with `apiClient`, `tokenStore`, `auth`. `RootView` + `LoginFlowView` (signup, login, logout). Swift Testing for unit tests. Previews for every view. Add the iOS GitHub Actions workflow under `.github/workflows/ios.yml` at end of phase — workflow now has real code to test. **Done:** Sign up + log in + log out works on iOS Simulator and physical iPhone against the local backend. Refresh token survives app restart (read from Keychain). iOS CI green on a real build.

#### Phase 6 — Android auth (1–2 weeks)
Create Android Studio project (`SharedList`, applicationId `in.santosh_bharadwaj.sharedlist`, minSdk 35, Kotlin 2.x, Compose). Gradle Kotlin DSL + version catalogs. Detekt + explicit API mode. Package structure mirroring iOS. Custom EncryptedSharedPreferences wrapper. `TokenStore` mirroring iOS. `ApiClient` with Ktor + auth header plugin + 401 single-flight refresh interceptor. `AppContainer` via `CompositionLocal`. Root composable + login flow with `StateFlow<UiState>`. JUnit unit tests. Add the Android GitHub Actions workflow under `.github/workflows/android.yml` at end of phase. **Done:** Same auth flows working on Android Emulator + S24 Ultra. Refresh token survives app restart. Android CI green.

### Sync foundation block (Phases 7–9) — backend protocol co-designed with iOS, then mirrored on Android

#### Phase 7 — Backend sync protocol + iOS sync engine in tandem (3 weeks)
**Co-designed**: backend's `since` endpoints, conditional writes, idempotent inserts, and tombstone semantics evolve in parallel with the iOS sync engine that consumes them. Backend changes are made when iOS hits real friction — not speculatively. This avoids 2 weeks of iOS work against a protocol designed in a vacuum.
- Backend: `GET /lists?since=<ISO8601>`, `GET /items?since=`, `GET /list_members?since=` (returns entities with `updated_at > since`, including soft-deleted). `If-Match: <updated_at>` conditional writes on update endpoints (409 on mismatch). Idempotent `POST` (UUID v7 client-side, `INSERT ... ON CONFLICT DO NOTHING RETURNING *`). Document the protocol incrementally in `backend/docs/sync.md`.
- iOS: SwiftData `@Model` types (`UserModel`, `ListModel`, `ItemModel`, `MemberModel`, `MutationQueueEntry`). `ModelContainer` setup. `NetworkMonitor` (`NWPathMonitor`-backed `@Observable`). `SyncEngine` class: write queue (mutation log table), drainer (network-aware), reconciliation (full pull on launch + foreground), last-write-wins comparison via `updated_at`.
- Sync engine unit-tested against a real Testcontainers-backed Hono server (not a mock). Fuzz scenarios: queue ordering, idempotency on retry, conflict resolution, offline mutate → reconnect → reconcile, tombstone convergence.
- No UI changes yet — engine is exercised via Swift Testing harnesses.
- **Done:** iOS sync engine does the full offline-mutate / reconnect / reconcile / tombstone-converge cycle against the real backend. Backend's `?since=` and `If-Match` semantics are validated by an actual consumer. Protocol is now frozen for Android.

#### Phase 8 — Android persistence + sync engine (2 weeks)
Mirror Phase 7 on Android against the **now-validated** protocol. Room entities matching SwiftData models. `ConnectivityManager` + `NetworkCallback` `NetworkMonitor`. `SyncEngine` mirroring iOS design. JUnit tests covering the same scenarios as iOS, against the same Testcontainers backend pattern. Backend protocol is fixed at this point — no co-evolution. **Done:** Android tests prove same offline/online cycles work. Both clients now have a working sync engine with no UI on top.

#### Phase 9 — Cross-platform sync verification (1 week)
Drive both engines from a test harness (CLI-style on each platform, or unit tests with a real backend) that proves: (a) device A creates an item → device B sees it after `?since=` reconciliation; (b) device A goes offline, mutates, comes back online → device B sees the result; (c) concurrent edits from both devices resolve last-write-wins consistently; (d) tombstones flow correctly during the 90-day window. Document the sync engine design in `ios/docs/sync.md` and `android/docs/sync.md`. **Done:** Two devices' sync engines provably converge under the test scenarios.

### Realtime foundation block (Phases 10–12) — WebSocket + push infrastructure (still no CRUD UI yet)

#### Phase 10 — Backend WebSocket server + push infrastructure (1–2 weeks)
Bun-native WebSocket handler under `/ws`. Per-user socket map + per-socket subscription set. Typed messages: `{type: 'subscribe', listId}`, `{type: 'unsubscribe', listId}`, `{type: 'event', payload: {entity, action, data}}`. Mutation endpoints publish events to subscribed sockets. Push notification module: APNs HTTP/2 with `.p8` key (sandbox endpoint), FCM HTTP v1 API with service account JSON. pg-boss job queue for delivery. `POST /devices` registers (user, platform, token). On any list mutation, enqueue push delivery to subscribed-but-disconnected users' device tokens. **Done:** WebSocket connection works via `wscat`. APNs sandbox + FCM dev pushes deliverable to a test token (verified via Apple/Google consoles).

#### Phase 11 — iOS WebSocket + push receiver (1–2 weeks)
`WebSocketManager` wrapping `URLSessionWebSocketTask`: connect, subscribe/unsubscribe, exponential backoff reconnect, heartbeat ping/pong, resubscribe on reconnect, dispatch events to `SyncEngine`. `@UIApplicationDelegateAdaptor` AppDelegate for `didRegisterForRemoteNotificationsWithDeviceToken`. POST device token to backend. Notification handler displays alerts via `UserNotifications`. Permission request still deferred (no in-context trigger exists yet). **Done:** iOS app connects to WS on login, receives test events, registers APNs sandbox token with backend.

#### Phase 12 — Android WebSocket + push receiver (1–2 weeks)
Mirror Phase 11. `WebSocketManager` wrapping Ktor Client WebSocket. `FirebaseMessagingService` for `onNewToken` + `onMessageReceived`. Backend device registration. `NotificationManager` for displaying received pushes. **Done:** Android app connects to WS on login, receives test events, registers FCM token with backend.

### CRUD + UI block (Phases 13–16) — visible app starts here, ~month 4

#### Phase 13 — Lists CRUD on backend + iOS + Android (2 weeks)
Backend: `GET /lists`, `POST /lists`, `PATCH /lists/:id`, `DELETE /lists/:id` (soft). All publish WS events. iOS: `ListsTabView` (TabView root, NavigationStack), `ListsView` showing all lists user is a member of, `CreateListSheet`. ViewModels read from SwiftData (driven by sync engine), mutations go through SyncEngine. Android: mirror with `LazyColumn`, Material 3 components, Compose ViewModels. **Done:** Both apps show, create, rename, delete lists. Changes propagate cross-device in real time via WS (or via reconciliation pull if WS dropped).

#### Phase 14 — Items CRUD on backend + iOS + Android (2 weeks)
Backend: `GET /lists/:id/items`, `POST /lists/:id/items`, `PATCH /items/:id`, `DELETE /items/:id`. iOS: `ListDetailView` with item list, add field, check/uncheck, delete swipe, reorder via `position` int. Android: mirror with `LazyColumn`, Material 3 swipe-to-dismiss, drag-to-reorder. **Done:** Both apps support full item lifecycle. Two devices on same list see each other's changes within 1–2 seconds via WS.

#### Phase 15 — Sharing flow on backend + iOS + Android (1–2 weeks)
Backend: `POST /lists/:id/invites` returns 8-char code (24h expiry, single-use), `POST /invites/:code/accept` adds caller as `editor`. iOS: "Share list" button shows code with copy-to-clipboard. "Join list" screen accepts code and adds user. Android: mirror. **Done:** User A generates code, sends out-of-band, user B types it in, B is added as member, both see the list.

#### Phase 16 — In-context push permission + notification UX (1 week)
iOS: When user creates or joins a shared list, prompt `UNUserNotificationCenter.requestAuthorization`. Settings toggle as fallback. Android: same flow with `POST_NOTIFICATIONS` runtime permission, rationale check, settings deep-link after two denies. Backend: when an item is added/checked/deleted on a shared list, enqueue push to all member device tokens (excluding the actor). **Done:** Both devices get a push notification when the other modifies a shared list. Backgrounded apps receive the notification.

### Polish + level-up block (Phases 17–19) — refinement, ~months 9–12

#### Phase 17 — Settings + profile (1 week)
Settings tab on both platforms: profile (display email, change password via existing backend endpoint), sign out (clears Keychain/EncryptedSharedPreferences, transitions auth state), notification toggle, "About" screen. Backend: `POST /auth/change-password` if not already there. **Done:** Both apps have functional Settings tab.

#### Phase 18 — Sync hardening + edge cases (1–2 weeks)
Fuzz the sync engine: rapid create-delete-create cycles, simultaneous edits from both devices, edits on items deleted from another device, lists deleted while another device is editing. Add proper "stale data" indicator in UI ("last synced X ago"). Improve exponential backoff (jitter, max delay caps). Add structured logs for sync events. **Done:** Documented edge case scenarios all converge correctly. Sync events grep-able via `Logger.sync` (iOS) and `Sync` Logcat tag (Android).

#### Phase 19 — Optional level-ups (open-ended, 2+ weeks each)
Pick whichever interests you most. Not required for "v1 done" but each is a meaningful additional learning area:
- **iOS local SPM modularization** — refactor monolith into per-feature SPM packages
- **Generated API clients** — `swift-openapi-generator` for iOS, `openapi-generator` for Android, replace hand-written `APIClient`s and compare
- **Biometric Keychain gating** — Face ID / Touch ID + Android BiometricPrompt to access tokens
- **Containerize the backend** — write a real `Dockerfile`, multi-stage build, push to a local registry; not used for daily dev but a Docker learning artifact
- **OpenTelemetry** — structured tracing across backend, iOS, Android
- **Item-level fractional indexing** — replace integer `position` with fractional indices for true conflict-free drag reorders
- **Backend dev/prod multi-env even though local-only** — exercise the multi-env Terraform-equivalent workflow with separate Postgres databases + Hono instances
- **Circle back to cloud infra** — revisit the cloud decision now that the app exists locally

---

## Phase verification cadence

After each phase, run an explicit verification (specific to that phase's "Done" criteria, listed above). The default expectation is: do not start the next phase until the current phase's "Done" verification passes.

### Learning protocol

A separate `LEARNING_PROTOCOL.md` at repo root governs the learning practice: per-phase teach-back doc, rejected-alternatives note, and an optional break-it session. The protocol is cross-cutting — it applies to every phase. See that file for the template and per-phase seeded prompts.

### Status protocol

`STATUS.md` at repo root is the single source of truth for "where am I right now" across sessions and devices. It contains a "Right now" block (Last updated / Phase / Next action / Blockers), a per-phase state list (`NOT STARTED` / `IN PROGRESS (started YYYY-MM-DD)` / `BLOCKED — <reason>` / `DONE YYYY-MM-DD`) with the same checkboxes as the phase Done criteria here, and an append-only session log. Read it first at session start; update it last at session end. Commit status updates separately from code so `git log STATUS.md` is a project diary.

### Slippage protocol

Real life will cause some "Done" criteria to slip. Strict gating ("don't start N+1 until N is fully Done") will cause stalls or quiet abandonment of the rule. Instead:

- Maintain `KNOWN_DEBT.md` at repo root (created in Phase 1). Each unmet criterion gets a row: `| Phase | Criterion | Date logged | Why deferred | Fix-by | Status |`.
- Allow Phase N+1 to start with logged debt — but **the fix-by date is not optional**. If a Phase 5 debt item is logged with fix-by = end of Phase 7, it must be addressed before Phase 8 starts (or re-logged with a new fix-by + reason, like a bug ticket).
- Review `KNOWN_DEBT.md` at the start of every phase. Items older than 2 phases without movement → demote to a real GitHub issue and accept they're not getting fixed.
- This is a learning project — the goal is honest accounting, not heroics.

### Bring-up docs are part of every phase's Done criteria

Each phase ships at least one runnable platform (backend, iOS, or Android). Whatever platforms a phase touched, that platform's README (`backend/README.md`, `ios/README.md`, `android/README.md`) must still describe a working cold-machine setup at the end of the phase. Don't tick a phase as Done until the README of the affected platform has been read top-to-bottom against the changes in the PR — and updated where they drifted. Cold-machine bring-up is the smoke test for documentation; if a hypothetical fresh checkout couldn't follow the README to a working setup, the phase isn't actually Done.

The READMEs are also the **single source of truth** for bring-up commands. Don't repeat them in the root `README.md`, in `CLAUDE.md`, or in commit messages. Three synced copies of bring-up commands always drift; one canonical doc with pointers from elsewhere doesn't.

**Estimated calendar timeline at 20 hrs/week with realistic 30% slack for debugging, distractions, and life:**
- Phases 1–3 (Foundation): ~3–4 weeks
- Phases 4–6 (Auth): ~4–6 weeks
- Phases 7–9 (Sync foundation, with backend+iOS co-design): ~6–8 weeks
- Phases 10–12 (Realtime foundation): ~4–6 weeks
- Phases 13–16 (CRUD + UI): ~6–8 weeks
- Phases 17–18 (Polish): ~2–3 weeks
- **Subtotal: ~25–35 weeks (~6–9 months) for the core 18 phases**
- Phase 19 (level-ups): open-ended, pick what interests you

Realistic expectation: **8–12 months to "fully working app on both devices, both users testing each other's changes, push notifications, real sync, no UI bugs."** Phase 19 extensions can stretch indefinitely.

---

## Critical files / artifacts to be created (when execution starts)

This plan precedes any file creation. When implementation begins, the first concrete artifacts will be:

- `package.json` (root, Bun workspaces declaration)
- `backend/package.json`, `backend/tsconfig.json`, `backend/biome.json`
- `backend/docker-compose.yml` (Postgres + Mailpit)
- `backend/Caddyfile` (reverse proxy config)
- `backend/.env.example`, `.gitignore`
- `backend/src/server.ts` (Hono entry)
- `backend/src/infra/{db,logger,config}.ts`
- `backend/drizzle/schema.ts` (the Drizzle schema covering all v1 tables)
- `lefthook.yml` (root)
- `.github/workflows/backend.yml` (Phase 2), `.github/workflows/ios.yml` (Phase 5), `.github/workflows/android.yml` (Phase 6) — added per-phase as code lands, not all upfront
- `ios/SharedList.xcodeproj` (created via Xcode UI initially)
- `android/` (created via Android Studio initially)
- `README.md` describing the project, the bootstrapping steps, and links to per-folder READMEs
- `KNOWN_DEBT.md` (created in Phase 1, populated per the slippage protocol)
- `STATUS.md` (drafted pre-execution; auto-tracks phase state and session log across sessions)
- `LEARNING_PROTOCOL.md` (drafted pre-execution; governs per-phase learning practice)
- `CLAUDE.md` (drafted pre-execution; auto-loaded context for Claude Code sessions, points future agents at the source-of-truth files)
- `docs/learning/phase-NN.md` (one per phase, per `LEARNING_PROTOCOL.md`)
- `backend/docs/sync.md` (Phase 7 deliverable — the sync protocol contract)
- `ios/docs/sync.md` and `android/docs/sync.md` (Phase 9 deliverable — sync engine designs)

No file existed when this plan was written; everything starts greenfield.

---

## Verification (when execution starts)

End-to-end verification will be phase-specific (and phasing is the next conversation), but the eventual full-stack verification path is:

1. From repo root: `docker compose -f backend/docker-compose.yml up -d` brings up Postgres + Mailpit
2. `caddy run --config backend/Caddyfile` (separate terminal) runs local TLS
3. `cd backend && bun install && bun run db:migrate && bun run dev` starts the backend
4. `curl https://Santoshs-MacBook-Pro-48.local/health` from the Mac returns `{ok: true}` over TLS
5. iOS app built in Xcode, run on Simulator → can sign up, log in, create a list, add items
6. Same on physical iPhone (7-day reinstall cycle for personal-Apple-ID provisioning)
7. Same on Android Emulator and physical Android
8. Two devices logged in as different users → user A creates list, shares code → user B joins → user B's app shows the list (eventually consistent via polling, then near-instant via WebSocket)
9. Both users add/check items → changes appear on the other device within seconds
10. Backend log lines for a single request can be grep'd via the request ID
11. Airplane-mode on a device → mutations queue locally, UI stays responsive → re-enable network → queue drains, server state converges
12. Push notifications fire on device token registration + on cross-user item changes (verified in APNs sandbox / FCM dev console)

---

## What's explicitly NOT in this plan

- **Cloud / AWS infra** — explicitly out of scope.
- **App store publishing** — explicitly out of scope. iOS uses free Apple ID with 7-day reinstall cycle; Android sideloads APK to S24 Ultra indefinitely.
- **CI/CD deploy pipelines** — only test/build CI is in scope (no deploy targets exist).
- **Real PII or production data** — this is a learning project; treat all data as disposable.
- **Off-LAN access** — phone on cellular cannot reach the Mac. App is read-only (cached) until back on home WiFi. No Tailscale, no Cloudflare Tunnel.
- **Database backups** — none. Postgres data is disposable; if you nuke the volume, recreate. Only added if a Phase 19 level-up.
- **iOS background refresh (`BGAppRefreshTask`)** — silent push handles wake-for-sync. No periodic background fetch.
- **Undelete UI** — soft-delete is sync-protocol-internal. Users see delete as final.
- **Item drag-to-reorder correctness under concurrent edits** — Phase 14 ships integer `position` with last-write-wins. Concurrent reorders may glitch (items swap unexpectedly). Realistic for a 2-3 user app. Fractional indexing remains a Phase 19 level-up if it becomes annoying in practice.
- **Off-ramp from sync engine work** — there isn't one. Sync engine is the central learning goal; if Phase 7 stalls, the project pauses indefinitely rather than abandoning the goal.
- **Any code** — no files have been written. This plan is the blueprint; execution begins on user approval.
