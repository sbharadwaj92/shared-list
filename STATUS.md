# Project Status

Single source of truth for "where am I right now" across sessions and devices. Read this first at session start; update at session end.

The "Right now" block at the top is the session handoff. The "Phases" block below tracks each phase's state and remaining checkboxes against its `PLAN.md` "Done" criteria. The "Session log" at the bottom is an optional one-line-per-session diary.

---

## Right now

**Last updated**: 2026-05-05
**Phase**: Phase 7 IN PROGRESS (started 2026-05-05) — slices A + B merged (PRs #8, #9); ready to start slice C.1 (backend writes)
**Next action**: begin **slice C.1** — backend write side. Branch off main as `phase-07-backend-writes`. Scope:

- `POST /lists` — idempotent via UUID v7 + `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING *`. Actor becomes the `owner` member automatically (one transaction).
- `POST /lists/:id/items` — same idempotency story; auth requires active membership of the list.
- `PATCH /lists/:id` — update `name`. Conditional via `If-Match: <updatedAt-ISO8601>` header. 409 on mismatch with the current row (carries the latest `updated_at` so the client can re-fetch and merge).
- `PATCH /items/:id` — update `text` / `position` / `checkedAt`. Same `If-Match` semantics.
- `DELETE /lists/:id` — soft-delete (set `deleted_at`); requires `role = 'owner'`; cascade soft-delete to items in the same transaction so each gets its own `updated_at` bump for the `?since=` feed (see PLAN.md L177).
- `DELETE /items/:id` — soft-delete; requires active membership of the list.

All endpoints behind `requireAuth`. Add new repo helpers (insert / softDelete / conditionalUpdate) co-located with their resource. Update `backend/docs/sync.md` with the slice-C-landed sections (currently marked pending). Integration tests pin: idempotent-POST returns the existing row on retry; If-Match 409 path; cross-user 403/404; cascade soft-delete for lists.

After C.1 merges, **slice C.2** lands the iOS `MutationQueueEntry` `@Model` + optimistic-apply path; **slice C.3** lands the drainer + 409-→-reconcile + real-backend Testcontainers integration test (the cycle slice B deferred). Slice D wraps with tombstone fuzz + `docs/learning/phase-07.md`.

Phase 7 is the central learning goal of this project; PLAN.md is explicit there's no off-ramp if it stalls.
**Blockers**: none

---

## Phases

States: `NOT STARTED`, `IN PROGRESS (started YYYY-MM-DD)`, `BLOCKED — <reason>`, `DONE YYYY-MM-DD`

Checkboxes mirror each phase's "Done" criteria from `PLAN.md`. Tick them as you go. A phase is `DONE` only when all boxes are checked AND `docs/learning/phase-NN.md` is committed (per `LEARNING_PROTOCOL.md`).

**Implicit Done criterion for every phase**: bring-up docs (`backend/README.md`, `ios/README.md`, `android/README.md`) still describe a working cold-machine setup for any platform this phase changed. If the phase touched `docker-compose.yml`, `Caddyfile`, build scripts, env vars, or installed dependencies, the README of the affected platform must be updated in the same PR. Don't tick the phase until you've mentally walked a fresh checkout through the README's bring-up steps and they'd succeed. Doc drift is what made this rule necessary in the first place — see commit history of `backend/README.md` for context.

### Foundation block (Phases 1–3)

#### Phase 1 — Repo + tooling bootstrap — DONE 2026-05-04
- [x] monorepo at `~/Projects/shared-list/` with Bun workspaces, lefthook, .gitignore, README
- [x] `KNOWN_DEBT.md`, `STATUS.md`, `LEARNING_PROTOCOL.md`, `CLAUDE.md` committed at root
- [x] `docs/learning/` directory with placeholder `phase-01.md`
- [x] pushed to public GitHub as `shared-list` (https://github.com/sbharadwaj92/shared-list)
- [x] Caddy + mkcert installed; local CA in macOS trust store
- [x] `docs/learning/phase-01.md` written per learning protocol

#### Phase 2 — Backend skeleton — DONE 2026-05-04
- [x] `backend/` with Bun + Hono + TypeScript
- [x] `docker-compose.yml` running Postgres 17 + Mailpit
- [x] Typed config module (Zod-validated env)
- [x] Pino logger setup with request-ID middleware
- [x] `/health` endpoint
- [x] Drizzle Kit configured
- [x] Biome + Lefthook hooks running
- [x] `bun run dev` returns `{ok: true}` on `https://Santoshs-MacBook-Pro-48.local/health` over TLS
- [x] backend CI workflow added under `.github/workflows/backend.yml`
- [x] `docs/learning/phase-02.md` written

#### Phase 3 — Backend schema + migrations — DONE 2026-05-04
- [x] Drizzle schema for `users`, `lists`, `list_members`, `items`, `device_tokens`, `list_invites`, `refresh_tokens`
- [x] UUID v7 PKs, `updated_at` triggers, `deleted_at` columns, indexes on FKs and `updated_at`
- [x] First migration generated and applied; verified with `psql`
- [x] Repo-layer helpers (`activeLists()`, `activeItems()`) compiled and unit-tested
- [x] Tests pass via `bun test` against Testcontainers Postgres
- [x] `docs/learning/phase-03.md` written

### Auth block (Phases 4–6)

#### Phase 4 — Backend auth — DONE 2026-05-04
- [x] `POST /auth/signup`, `/login`, `/refresh`, `/logout`
- [x] `Bun.password` with argon2id
- [x] `jose` JWT signing
- [x] Refresh token table + rotation + reuse detection (revoke-all)
- [x] Refresh tokens hashed at rest (sha256)
- [x] `requireAuth` middleware verifies access tokens
- [x] Zod schemas + `@hono/zod-openapi` + `/swagger-ui`
- [x] `hono-rate-limiter` on auth endpoints
- [x] Integration tests against Testcontainers
- [x] Reuse-detection verified: used refresh token invalidates user's tokens
- [x] `docs/learning/phase-04.md` written

#### Phase 5 — iOS auth — DONE 2026-05-05
- [x] Xcode project (`SharedList`, iOS 26 min, Swift 6 strict concurrency) — generated via XcodeGen from `ios/project.yml`; `SharedList.xcodeproj` is gitignored
- [x] Folder structure (App/Features/Core/Resources/)
- [x] Custom `KeychainStore` wrapper
- [x] `TokenStore` for access/refresh storage and rotation
- [x] `APIClient` with auth header injection + 401 → single-flight refresh → retry
- [x] `AppContainer` with `apiClient`, `tokenStore`, `auth`
- [x] `RootView` + `LoginFlowView` (signup, login, logout)
- [x] Swift Testing unit tests; previews for every view (18 tests across 4 suites passing locally on iPhone 17 Pro Max sim)
- [x] Sign up + log in + log out works on Simulator and physical iPhone (verified on iPhone 15 Pro Max 2026-05-05 against the local backend)
- [x] Refresh token survives app restart (verified on iPhone 15 Pro Max 2026-05-05)
- [x] iOS GitHub Actions workflow added (`.github/workflows/ios.yml`)
- [x] iOS CI green on real build (PR #6 — `xcodebuild test` 3m10s on macos-15, `lint + typecheck + test` 43s on ubuntu-latest)
- [x] `docs/learning/phase-05.md` written

#### Phase 6 — Android auth — DONE 2026-05-05
- [x] Android Studio project (`SharedList`, minSdk 35, Kotlin 2.x, Compose) — hand-written Gradle scaffolding (no Studio wizard); applicationId `in.santosh_bharadwaj.sharedlist` (underscore because Java packages disallow `-`)
- [x] Gradle Kotlin DSL + version catalogs (`gradle/libs.versions.toml`)
- [x] Detekt + explicit API mode — config tuned for Compose idioms (PascalCase composables, package underscores, intentional broad-exception catches in I/O paths with documented rationale)
- [x] Custom `EncryptedSharedPreferences` wrapper (`SecureStorage` interface + real impl + `InMemorySecureStorage` for tests; mirrors iOS `KeychainStoring`)
- [x] `TokenStore` mirroring iOS — `StateFlow<Tokens?>` with atomic `update { copy(...) }` semantics; mutex-guarded I/O writes
- [x] `ApiClient` (Ktor + OkHttp) with auth header + 401 single-flight refresh interceptor — `Mutex` + `CompletableDeferred<Boolean>` two-phase locking; never-clear-inFlight pattern survives any scheduler (CI bug surfaced + fixed)
- [x] `AppContainer` via `CompositionLocal` — manual DI mirroring iOS, `LocalAppContainer` provider
- [x] Root composable + login flow with `StateFlow<UiState>` — single immutable `LoginUiState`, stateless `LoginFlowContent` for previews, `RootScreen` switches on token state
- [x] JUnit unit tests — 15/15 passing (5 InMemorySecureStorage, 5 TokenStore, 5 ApiClient incl. concurrent-401 → single-refresh case)
- [x] Auth flows working on Emulator (Pixel 9 Pro XL / API 35 / Google APIs) + S24 Ultra (verified 2026-05-05): signup → post-auth → sign out → login → force-quit + relaunch → still authenticated
- [x] Refresh token survives app restart (verified on both via the force-quit + relaunch test)
- [x] Android GitHub Actions workflow added (`.github/workflows/android.yml`) — Linux-only `detekt + testDebugUnitTest + assembleDebug`, instrumented tests deferred per PLAN.md L308; CI green on real GitHub runner
- [x] iOS `RefreshCoordinator` ported back with the same single-flight hardening (entry-with-isFinished pattern); 18/18 iOS tests still passing
- [x] `docs/learning/phase-06.md` written

### Sync foundation block (Phases 7–9)

#### Phase 7 — Backend sync protocol + iOS sync engine in tandem — IN PROGRESS (started 2026-05-05)
- [x] Backend: `?since=` endpoints for lists, items, list_members
- [ ] Backend: `If-Match` conditional writes (409 on mismatch)
- [ ] Backend: idempotent `POST` (UUID v7 + `ON CONFLICT DO NOTHING`)
- [x] iOS: SwiftData `@Model` types + `ModelContainer` *(`UserModel`, `ListModel`, `ItemModel`, `MemberModel`, `SyncCursor`; `MutationQueueEntry` deferred to slice C)*
- [x] iOS: `NetworkMonitor` (`NWPathMonitor`-backed `@Observable`)
- [ ] iOS: `SyncEngine` with mutation queue, drainer, reconciliation, LWW *(slice B landed read-only reconciliation only — no mutation queue, no drainer, no LWW; those land in slice C)*
- [ ] Sync engine tests against real Testcontainers Hono server *(slice B uses scripted `MockSession` against shared DTO types; the wire contract is pinned by backend integration tests. Real-backend test path lands in slice C when there's a mutate→reconnect→reconcile cycle to actually exercise.)*
- [ ] Full offline-mutate / reconnect / reconcile / tombstone-converge cycle proven *(slice B proves only the reconcile + tombstone half — offline-mutate path is slice C)*
- [ ] `backend/docs/sync.md` documents the protocol *(slice A landed: cursor model + read-side endpoints; If-Match + idempotent POST sections pending in slice C)*
- [ ] `docs/learning/phase-07.md` written

#### Phase 8 — Android persistence + sync engine — NOT STARTED
- [ ] Room entities matching SwiftData models
- [ ] `ConnectivityManager` + `NetworkCallback` `NetworkMonitor`
- [ ] `SyncEngine` mirroring iOS design
- [ ] JUnit tests covering same scenarios as iOS
- [ ] Same Testcontainers backend pattern
- [ ] `docs/learning/phase-08.md` written

#### Phase 9 — Cross-platform sync verification — NOT STARTED
- [ ] Test harness drives both engines against real backend
- [ ] Scenario (a): A creates → B sees after `?since=`
- [ ] Scenario (b): A offline-mutates → reconnects → B sees result
- [ ] Scenario (c): concurrent edits resolve LWW consistently
- [ ] Scenario (d): tombstones flow correctly during 90-day window
- [ ] `ios/docs/sync.md` and `android/docs/sync.md` documented
- [ ] `docs/learning/phase-09.md` written

### Realtime foundation block (Phases 10–12)

#### Phase 10 — Backend WebSocket server + push infrastructure — NOT STARTED
- [ ] Bun-native WS handler under `/ws`
- [ ] Per-user socket map + per-socket subscription set
- [ ] Typed messages: subscribe / unsubscribe / event
- [ ] WS auth via `?token=<jwt>` query string at upgrade
- [ ] Mutation endpoints publish events to subscribed sockets
- [ ] APNs sandbox HTTP/2 with `.p8` key
- [ ] FCM HTTP v1 API with service account JSON, `priority: high`
- [ ] pg-boss job queue for delivery
- [ ] `POST /devices` registers (user, platform, token)
- [ ] WS works via `wscat`
- [ ] APNs sandbox + FCM dev pushes verified via Apple/Google consoles
- [ ] `docs/learning/phase-10.md` written

#### Phase 11 — iOS WebSocket + push receiver — NOT STARTED
- [ ] `WebSocketManager` wrapping `URLSessionWebSocketTask`
- [ ] Connect, subscribe/unsubscribe, exponential backoff reconnect, heartbeat
- [ ] Resubscribe on reconnect; pull `?since=` before resubscribe
- [ ] Dispatch events to `SyncEngine`
- [ ] `@UIApplicationDelegateAdaptor` AppDelegate for APNs token
- [ ] POST device token to backend
- [ ] Silent push handler triggers sync, posts local notification
- [ ] App connects to WS on login, receives test events
- [ ] `docs/learning/phase-11.md` written

#### Phase 12 — Android WebSocket + push receiver — NOT STARTED
- [ ] `WebSocketManager` wrapping Ktor Client WebSocket
- [ ] Same lifecycle/reconnect/heartbeat semantics as iOS
- [ ] `FirebaseMessagingService.onNewToken` POSTs to backend
- [ ] `onMessageReceived` triggers sync + posts local notification
- [ ] App connects to WS on login, receives test events
- [ ] `docs/learning/phase-12.md` written

### CRUD + UI block (Phases 13–16)

#### Phase 13 — Lists CRUD on backend + iOS + Android — NOT STARTED
- [ ] Backend: GET/POST/PATCH/DELETE for lists; all publish WS events
- [ ] iOS: `ListsTabView`, `ListsView`, `CreateListSheet`
- [ ] iOS: ViewModels read SwiftData (sync-engine-driven), mutations via SyncEngine
- [ ] Android: mirror with `LazyColumn`, Material 3, Compose ViewModels
- [ ] Both apps show, create, rename, delete lists
- [ ] Cross-device propagation in real time via WS (or reconciliation if WS dropped)
- [ ] `docs/learning/phase-13.md` written

#### Phase 14 — Items CRUD on backend + iOS + Android — NOT STARTED
- [ ] Backend: GET/POST/PATCH/DELETE for items
- [ ] iOS: `ListDetailView` with add, check/uncheck, delete-swipe, integer-position reorder
- [ ] Android: mirror with `LazyColumn`, Material 3 swipe-to-dismiss, drag-to-reorder
- [ ] Both apps support full item lifecycle
- [ ] Two devices on same list see each other's changes within 1–2 seconds via WS
- [ ] Reorder glitch under concurrent edit documented (acceptable)
- [ ] `docs/learning/phase-14.md` written

#### Phase 15 — Sharing flow on backend + iOS + Android — NOT STARTED
- [ ] Backend: `POST /lists/:id/invites` returns 8-char code (24h, single-use)
- [ ] Backend: `POST /invites/:code/accept` adds caller as `editor`
- [ ] Backend: rate limit on `/invites/:code/accept` (30/min/IP)
- [ ] iOS: "Share list" with copy-to-clipboard
- [ ] iOS: "Join list" screen accepts code
- [ ] Android: mirror
- [ ] Generate-share-join-add-member flow works end-to-end
- [ ] `docs/learning/phase-15.md` written

#### Phase 16 — In-context push permission + notification UX — NOT STARTED
- [ ] iOS: `UNUserNotificationCenter.requestAuthorization` on first shared-list create/join
- [ ] iOS: Settings toggle as fallback
- [ ] Android: `POST_NOTIFICATIONS` runtime permission with rationale
- [ ] Android: settings deep-link after two denies
- [ ] Backend: enqueue push to all member device tokens (excluding actor) on shared-list mutations
- [ ] Both devices receive push when the other modifies a shared list
- [ ] Backgrounded apps receive notification
- [ ] `docs/learning/phase-16.md` written

### Polish + level-up block (Phases 17–19)

#### Phase 17 — Settings + profile — NOT STARTED
- [ ] iOS Settings tab: profile, change password, sign out, notification toggle, About
- [ ] Android Settings tab: same
- [ ] Backend: `POST /auth/change-password` (if not already there)
- [ ] Sign-out clears Keychain / EncryptedSharedPreferences and transitions auth state
- [ ] `docs/learning/phase-17.md` written

#### Phase 18 — Sync hardening + edge cases — NOT STARTED
- [ ] Fuzz harness for rapid create-delete-create, simultaneous edits, edits-on-deleted, lists-deleted-while-editing
- [ ] "Last synced X ago" indicator in UI
- [ ] Exponential backoff with jitter + max-delay cap
- [ ] Structured logs for sync events (`Logger.sync` iOS, `Sync` Logcat tag Android)
- [ ] Documented edge case scenarios all converge correctly
- [ ] `docs/learning/phase-18.md` written

#### Phase 19 — Optional level-ups — NOT STARTED
Open-ended. Pick one (or more):
- [ ] iOS local SPM modularization
- [ ] Generated API clients (`swift-openapi-generator` / `openapi-generator`)
- [ ] Biometric Keychain gating
- [ ] Containerize the backend
- [ ] OpenTelemetry across stack
- [ ] Item-level fractional indexing
- [ ] Backend dev/prod multi-env
- [ ] Circle back to cloud infra
- [ ] `docs/learning/phase-19.md` written for whichever was picked

---

## Session log

One line per session. Append at session end. Format: `YYYY-MM-DD — <what got done in 1 sentence>`. Treat this as a project diary; future-you will thank present-you when reconstructing why a decision was made.

```
2026-05-04 — Phase 1 complete: monorepo scaffolded, pushed to github.com/sbharadwaj92/shared-list, mkcert + Caddy + lefthook ready, learning doc written.
2026-05-04 — Phase 2 complete: backend skeleton (Bun + Hono + Pino + Zod config + Drizzle + Biome), docker-compose (Postgres 17 + Mailpit), Caddy under brew services with mkcert TLS, /health works end-to-end, backend CI workflow + real lefthook hooks live.
2026-05-04 — Phase 3 complete: 7-table Drizzle schema (UUID v7 PKs, updated_at triggers via hand-written 0001 migration, soft-delete on lists/items/list_members), repo helpers (activeLists/activeItems/activeMembership), Testcontainers-backed integration tests (14 passing) covering soft-delete, trigger, FK cascade, and case-insensitive email uniqueness.
2026-05-04 — Phase 4 complete: backend auth (signup/login/refresh/logout/me) with argon2id, jose HS256 JWTs, refresh-token rotation + reuse detection (sha256 hashes, revoke-all on replay), requireAuth middleware, @hono/zod-openapi + Swagger UI at /swagger-ui, hono-rate-limiter, 45 tests passing (10 service + 10 integration + 1 rate-limit + 4 password + 6 token + others), zod bumped to v4 for compat. Break-it: replayed refresh-token over real TLS, confirmed revoke-all on multi-device.
2026-05-04 — Phase 5 code complete: ios/ scaffolded via XcodeGen (project.yml, .gitignore, README), custom KeychainStore over Security.framework + InMemoryKeychainStore for tests, @MainActor @Observable TokenStore, APIClient with single-flight refresh via RefreshCoordinator actor, AppContainer manual DI, RootView + LoginFlowView with previews, 18 Swift Testing tests passing (5 APIClient incl. concurrent-refresh-collapses-to-one, 5 KeychainStore real, 3 InMemory, 5 TokenStore), .github/workflows/ios.yml on macos-15, docs/learning/phase-05.md written. Backend fix landed in same PR: Zod validation errors now use the standard {error:{code,message,requestId}} envelope via OpenAPIHono defaultHook (validation-hook.ts + 4 unit tests + strengthened integration tests, 49/49 backend tests pass).
2026-05-05 — Phase 5 verified end-to-end on physical iPhone 15 Pro Max against local backend: signup (201) → post-auth screen, sign out → login screen, log in (200) → post-auth screen, force-quit + relaunch → post-auth screen (refresh-token survives restart). PR #6 opened with three commits (iOS scaffold, backend Zod-envelope fix, login-validator user-enumeration fix); all CI green (backend 43s, iOS 3m10s). Awaiting merge.
2026-05-05 — Phase 5 DONE: PR #6 rebase-merged (commits cf0701d…1beabcd on main). Final scope: 7 commits — iOS scaffold, two backend fixes (validation envelope + login user-enumeration leak), STATUS bookkeeping, actions/checkout v4→v5 hygiene. 51/51 backend tests, 18/18 iOS tests, both CI workflows green on real GitHub runners.
2026-05-05 — Phase 6 DONE: Android auth scaffold (hand-written Gradle, no Studio wizard) mirroring iOS Phase 5 layer-by-layer — SecureStorage (EncryptedSharedPreferences) / TokenStore (StateFlow) / Ktor ApiClient with single-flight 401 refresh / DefaultAuthService / AppContainer via CompositionLocal / RootScreen + LoginFlowScreen with StateFlow<LoginUiState>. 15/15 JUnit tests; Detekt clean. Android CI green. The 401-refresh path went through three iterations (defer-clear → never-clear-with-isCompleted → compare-and-retry) before settling on the OkHttp-Authenticator-style "compare access token at request-build time vs current; only call runRefresh if they match" pattern; same fix ported back to iOS so RefreshCoordinator is now scheduler-agnostic on both platforms. Auth flows verified on Pixel 9 Pro XL / API 35 emulator AND physical S24 Ultra (signup → post-auth → sign out → login → force-quit + relaunch → still authenticated). Polish iterations: in-button progress spinner overflow (size(20.dp) instead of height(20.dp)), LoginUiState reset on auth success (privacy — password field stayed populated across sign-out before this). Backend Caddy SAN regenerated to include 10.0.2.2 (emulator alias for host loopback); BACKEND_BASE_URL now BuildConfig-driven with a local.properties override so device-switching is one gitignored line, debug-only network_security_config.xml opts into the user trust store so EncryptedSharedPreferences-installed mkcert CAs are trusted (Android 7+ default rejects user CAs). PR #7 with 12 commits, 3 CI workflows green (Android + backend + iOS).
2026-05-05 — Phase 7 slice A code-complete: backend `?since=` read feed for lists/items/list_members. New /sync feature subapp with three OpenAPIHono routes, three DTO Zod schemas, 9 HTTP integration tests pinning the wire contract. New repo helpers (listsSince/itemsSince/membersSince) with 10 unit tests pinning SQL semantics (tombstones flow, membership-scoped, strict `>` cursor, cross-user privacy, post-revocation scoping). Cursor design: server returns `serverTime` (DB now() truncated to ms, captured BEFORE the SELECT) and clients echo it back as `since` — server clock is the only one that defines truth, no client clock skew can leak into the protocol. Found a precision bug under test: pg `now()` is microseconds, JS/Swift/Kotlin Date is ms, so the JS-Date roundtrip lossiness made `>` filtering re-stream the at-the-cursor row; fixed with migration 0002 that swaps the trigger to `date_trunc('milliseconds', now())` AND fires on INSERT (was UPDATE-only) so column defaults can't sneak microseconds in. backend/docs/sync.md drafted with cursor model, three endpoints, recommended reconciliation algorithm, slice C/D placeholders. 70/70 backend tests pass (51 → 70). Two commits: migration 0002 + sync feature. PR #8 rebase-merged.
2026-05-05 — Phase 7 slice B code-complete: iOS read-side sync engine. Five new SwiftData `@Model` types (UserModel, ListModel, ItemModel, MemberModel, SyncCursor) + a `ModelConfiguration` in AppContainer; in-memory variant for previews/tests. `NetworkMonitor` wraps `NWPathMonitor` as `@Observable @MainActor` with `NetworkMonitoring` protocol seam + `MockNetworkMonitor` for tests. `SyncEngine` does full-pull reconciliation in lists → items → members order, persisting per-resource `serverTime` cursors and applying tombstone-aware upserts: list/item tombstones drop the local row; self-revocation (own member row tombstoned) sweeps the entire list — items, other members, the list itself. SyncDTOs.swift mirrors the backend Zod schemas with a `checked` → `checkedAt` rename for naming-consistency at the call site. SharedListApp kicks off an initial reconcile post-bootstrap if a session is loaded. Made `AuthServicing` `AnyObject`-constrained so the SyncEngine's `currentUserId` closure can capture `auth` weakly without a retain cycle. 8 new Swift Testing tests script the three feeds via `MockSession` and assert: feed order, upsert correctness, list/item tombstone removal, self-revocation sweep (incl. cleanup of items + other-member rows that were never tombstoned themselves), cursor persistence + round-trip on second pull, offline no-op, unauthenticated throws. 26/26 iOS tests pass (18 → 26). Build succeeds for iOS 26 simulator. PLAN.md note: real-Testcontainers test path deferred to slice C, where there's an offline-mutate cycle to actually exercise — the backend's HTTP integration tests pin the wire contract slice B consumes against shared DTO types.
```

---

## Discipline rules

1. **Last action of every session**: update the "Right now" block (Last updated, Phase, Next action, Blockers). Tick any boxes completed this session. Append one line to "Session log."
2. **First action of every session** (and first thing Claude reads at session start): this file, then `KNOWN_DEBT.md`. Don't start coding until you've re-oriented.
3. **Commit `STATUS.md` updates separately** with messages like `status: Phase 4 — finished /refresh endpoint`. `git log STATUS.md` then becomes a true project diary independent of code commits.
4. **Phase state transitions** are explicit: `NOT STARTED` → `IN PROGRESS (started YYYY-MM-DD)` → `DONE YYYY-MM-DD`. Use `BLOCKED — <reason>` if stuck on something external. Don't leave a phase in `IN PROGRESS` for weeks without movement — promote the unmet items into `KNOWN_DEBT.md` and demote the phase back if necessary.
5. **A phase is not `DONE`** until every checkbox is ticked AND `docs/learning/phase-NN.md` exists. Half-done phases stay `IN PROGRESS` with the unmet boxes visible.
