# Project Status

Single source of truth for "where am I right now" across sessions and devices. Read this first at session start; update at session end.

The "Right now" block at the top is the session handoff. The "Phases" block below tracks each phase's state and remaining checkboxes against its `PLAN.md` "Done" criteria. The "Session log" at the bottom is an optional one-line-per-session diary.

---

## Right now

**Last updated**: 2026-05-05
**Phase**: **Phase 9 DONE 2026-05-05** (PR #15 rebase-merged: commits 536c1c0…2343816 on main); ready to start Phase 10
**Next action**: begin **Phase 10** — backend WebSocket server + push infrastructure. The wire protocol is now genuinely frozen on both sides (verified by Phase 9's cross-platform harness, which runs 8 scenario pairs end-to-end through both platforms' real engines). Phase 10 builds on top: a Bun-native WebSocket handler under `/ws` with per-user socket maps + per-socket subscription sets, typed messages (subscribe / unsubscribe / event), JWT-via-query-string auth at upgrade time, and mutation endpoints publishing events to subscribed sockets. Plus push infrastructure: APNs sandbox via `.p8` key (HTTP/2), FCM HTTP v1 with service account JSON, pg-boss job queue for delivery, `POST /devices` registration. Per PLAN.md L391: still no UI yet. Verification is `wscat` for WS + Apple/Google consoles for push delivery to a test token.

Phase 9 ground rules carry forward: any future protocol change needs to update `backend/docs/sync.md`, the read/write integration tests, both platform sync engines, and the cross-platform harness in lockstep. The harness is the load-bearing artifact that catches "I changed the wire format and only one platform follows the new shape." WebSocket events in Phase 10 are not part of the sync protocol per se (they're a freshness signal that triggers `?since=` reconciliation), but the event payload shape needs the same kind of cross-platform discipline — Phase 11's iOS WS receiver and Phase 12's Android WS receiver should consume the same event JSON without per-platform special-casing.
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

#### Phase 7 — Backend sync protocol + iOS sync engine in tandem — DONE 2026-05-05
- [x] Backend: `?since=` endpoints for lists, items, list_members
- [x] Backend: `If-Match` conditional writes (409 on mismatch) *(slice C.1 — lists + items)*
- [x] Backend: idempotent `POST` (UUID v7 + `ON CONFLICT DO NOTHING`) *(slice C.1 — `POST /lists` and `POST /lists/:id/items`)*
- [x] iOS: SwiftData `@Model` types + `ModelContainer` *(`UserModel`, `ListModel`, `ItemModel`, `MemberModel`, `SyncCursor`, `MutationQueueEntry` — last one added in slice C.2)*
- [x] iOS: `NetworkMonitor` (`NWPathMonitor`-backed `@Observable`)
- [x] iOS: `SyncEngine` with mutation queue, drainer, reconciliation, LWW *(slice B read-side reconciler; C.2 mutation queue + optimistic-apply; C.3 drainer + 409→reconcile→retry-once. LWW guard exposed as internal `upsertListLWW`/`upsertItemLWW` so the drainer's 409 path applies the server's `latest` row through the same merge logic the reconciler uses.)*
- [x] Sync engine tests against real Testcontainers Hono server *(env-gated `DrainerIntegrationTests` runs against a real backend when `BACKEND_URL` is set; the slice-D `ios-integration` workflow boots Postgres + Bun on the macOS-15 runner and runs the integration suite. Picked env-gated over Process-based Testcontainers-from-Swift per PLAN.md L380.)*
- [x] Full offline-mutate / reconnect / reconcile / tombstone-converge cycle proven *(slice C.3 `offlineMutateThenReconnectDrains` integration test; slice D's `SyncFuzzTests` (4 hostile scenarios) widen the surface — rapid create-delete-create, simultaneous-edits chained-If-Match, edit-on-server-deleted, list-delete-while-items-have-pending-mutations.)*
- [x] `backend/docs/sync.md` documents the protocol *(slices A + C.1 landed: cursor model + read-side endpoints + write side. Status table tracks remaining slices.)*
- [x] `docs/learning/phase-07.md` written

#### Phase 8 — Android persistence + sync engine — DONE 2026-05-05
- [x] Room entities matching SwiftData models *(`UserEntity`, `ListEntity`, `ItemEntity`, `MemberEntity`, `SyncCursorEntity`, `MutationQueueEntity` — composite PK on `MemberEntity` is cleaner than the iOS pipe-joined-string workaround thanks to Room's native support)*
- [x] `ConnectivityManager` + `NetworkCallback` `NetworkMonitor` *(`StateFlow<Boolean>` exposed via `NetworkMonitoring`; `FakeNetworkMonitor` for tests)*
- [x] `SyncEngine` mirroring iOS design *(read-side reconciler in lists → items → members order; LWW upsert; self-revocation sweep wrapped in `database.withTransaction`; `internal upsertListLww`/`upsertItemLww` for the Drainer's 409 path)*
- [x] JUnit tests covering same scenarios as iOS *(55 total: 5 `JsonCodersTest`, 8 `SyncEngineTest`, 11 `MutatorTest`, 11 `DrainerTest`, 4 `SyncFuzzTest`, 2 env-gated `DrainerIntegrationTest`, plus 14 carry-over auth tests; Robolectric for the Room-touching ones, pure JUnit for the rest)*
- [x] Same env-gated backend pattern *(`DrainerIntegrationTest` uses `assumeTrue(BACKEND_URL != null)`; CI deferred per Phase 19 polish — same convention as iOS)*
- [x] `docs/learning/phase-08.md` written

#### Phase 9 — Cross-platform sync verification — DONE 2026-05-05
- [x] Test harness drives both engines against real backend *(`scripts/cross-platform-sync.sh` orchestrates iOS + Android env-gated suites against one backend; 8 scenario pairs × ~10min full run; verified locally 2026-05-05 with 8/8 PASS)*
- [x] Scenario (a): A creates → B sees after `?since=` *(both directions: iOS-A/Android-B AND Android-A/iOS-B)*
- [x] Scenario (b): A offline-mutates → reconnects → B sees result *(both directions)*
- [x] Scenario (c): concurrent edits resolve LWW consistently *(both directions; three-step convergence assertion: act-platform renames, observer renames, act-platform reconcile-only refresh, both end on the LWW winner)*
- [x] Scenario (d): tombstones flow correctly during 90-day window *(both directions; surfaced + fixed a test-bug where the assertion expected upsert-with-deletedAt rather than delete-the-row, which is the actual contract on both platforms)*
- [x] `ios/docs/sync.md` and `android/docs/sync.md` documented *(architectural overview — the seven-file map, layer diagram, two-rows-one-save invariant, optimistic local-apply, mutation queue, drainer 409 dance, self-revocation sweep, test seams; Android doc cross-references iOS as the design reference + calls out the intentional divergences)*
- [x] `docs/learning/phase-09.md` written *(harness-shape decision; three implementation gotchas — Swift Testing `()` syntax, Gradle stdout-via-XML, scenario-D contract; scenarioC three-step convergence; five rejected alternatives; break-it scenario reasoned through)*

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
2026-05-05 — **Phase 7 DONE**: slice D PR #13 rebase-merged (commits 6f3aaf2…994e2ea on main). Phase header in STATUS flipped to `DONE 2026-05-05`. End-to-end integration tests verified locally against the live backend (`createListRoundTripsThroughBackend` + `offlineMutateThenReconnectDrains` both green, ~0.16s each, hit `http://localhost:3000` via the simctl `launchctl setenv` env-var injection trick). Full Phase 7 deliverable: backend `?since=` read feed + `If-Match` conditional writes + idempotent POST + soft-delete cascade; iOS sync engine with read-side reconciler + persistent mutation queue + drainer + 409-→-reconcile-→-retry-once + LWW upsert; ms-precision wire-protocol bug fixed; tombstone fuzz; learning doc. Test counts: backend 92, iOS 54, all green. Phase 8 (Android persistence + sync engine) opens — mirror-work against a now-frozen wire protocol.
2026-05-05 — Phase 7 slice D code-complete: the wrap. 4 new `SyncFuzzTests` covering hostile scenarios (rapid create-delete-create, simultaneous-edits-chained-If-Match, edit-on-server-deleted, list-delete-while-items-have-pending-mutations). The simultaneous-edits scenario surfaced a real wire-protocol bug: Foundation's `JSONEncoder.dateEncodingStrategy = .iso8601` is second-precision (drops millis on encode) AND `Date.formatted(.iso8601...)` silently TRUNCATES the fractional component (so `9000.001999...` renders as `02:30:00.001` instead of `02:30:00.002`). Two distinct bugs in two layers; both would have caused 409 storms in production once two Mutator calls happened within a millisecond. Fixed via a new `JSONCoders` module exposing `makeEncoder()` / `makeDecoder()` that share an `ISO8601DateFormatter` with `.withFractionalSeconds`; replaced every callsite in APIClient / Mutator / Drainer / SyncEngine. CI integration workflow attempted: `.github/workflows/ios-integration.yml` booted Postgres via Colima + docker compose on macOS-15. **Hit a wall**: GitHub's hosted macOS runners don't support nested virtualization (no `VZ.framework` / no `HVF`), Colima can't boot its VM, Docker → Postgres → backend bring-up fails. Workflow file removed rather than left as a permanent red ✗ on every PR. The five fix paths (self-hosted macOS runner, split-runner tunneling, embedded `pglite`, paid Mac CI, leave-as-manual-pre-merge) were enumerated; user picked leave-as-manual. Convention documented in `ios/README.md`: run `BACKEND_URL=… xcodebuild test ...` locally before merging anything that changes the wire shape. The `localhost` / `127.0.0.1` ATS exceptions in iOS Info.plist stay (useful for plain-HTTP local runs without mkcert + Caddy). Revisit CI in Phase 19 polish. `docs/learning/phase-07.md` written: ~1500-word teach-back covering cursor model + read-feed + write side + iOS sync engine + LWW; 4 rejected alternatives (server-vouched cursor, 409-vs-412, UUID v4 shortcut, env-gated tests, SwiftData mutation queue); 3 break-it scenarios. iOS test count 50 → 54, all green.
2026-05-05 — Phase 7 slice C.3 DONE: PR #12 rebase-merged (commits 444232f + a7f8edd on main). iOS drainer + 409 reconcile + env-gated integration test live. Slice D (tombstone fuzz + integration CI workflow + phase-07.md learning doc) unblocked.
2026-05-05 — Phase 7 slice C.3 code-complete: iOS drainer. New `Drainer` class on `@MainActor` polls pending `MutationQueueEntry` rows in `createdAt` order, decodes per-opType payload, sends via the new `APIClient.sendRaw(method:path:body:extraHeaders:)` (returns `(data, status)` without throwing on non-2xx so 409 with body can be handled as a valid response shape). Serial drain via `isDraining` flag; `kick()` coalesces multiple triggers (Mutator post-save, NetworkMonitor.isOnline change, scenePhase = .active foreground). 409 → reconcile + retry-once: applies server's `latest` row through the existing SyncEngine LWW upsert (now `internal`-access `upsertListLWW`/`upsertItemLWW`), re-reads the merged local row, sends one retry with the new If-Match. Repeated 409 marks `failed` ("concurrent edits"). 404 on PATCH/DELETE removes the row (idempotent). 403 → failed. 5xx + network → re-queue with retryCount++. Stale `inFlight` rows reset to `pending` on Drainer init. Per-tick stop on requeue avoids spinning. Two-phase wiring (`mutator.attachDrainer(drainer)`) breaks the construction cycle. 11 new `DrainerTests` against MockSession + 2 env-gated `DrainerIntegrationTests` (skip silently when `BACKEND_URL` unset; PLAN.md L380's "real backend" requirement satisfied without booting Bun + Testcontainers from Swift). CI workflow that boots backend on macOS-15 runner deferred to slice D — needs an /etc/hosts shim or ATS exception toggle for the mkcert hostname; coupling that with the C.3 code review would double the slice. iOS test count 37 → 50, all green; xcodebuild clean for iPhone 17 Pro Max sim. `ios/README.md` documents the local invocation.
2026-05-05 — Phase 7 slice C.2 DONE: PR #11 rebase-merged (commits 6112306 + d67ff21 on main). iOS optimistic-apply + persistent mutation queue live; slice C.3 drainer unblocked.
2026-05-05 — Phase 7 slice C.2 code-complete: iOS optimistic-apply + persistent mutation queue. New `MutationQueueEntry` `@Model` (id/opType/targetId/payload-JSON/createdAt/status/retryCount/lastError) registered in the SwiftData container alongside the slice-B types. `Mutator` class on `@MainActor` exposes the six writes (`createList`/`renameList`/`deleteList`/`createItem`/`patchItem`/`deleteItem`); each method does the local-row apply and the queue append in ONE `context.save()` so we can't end up with "local applied but never queued" silent loss. Local `updatedAt` pre-stamped to `clock.now()` (LWW-friendly); rename/patch payloads carry the PRIOR `updatedAt` as `ifMatch` (the value the server still has on disk). `deleteList` cascades local soft-delete to items but enqueues ONE entry — the server cascades on its side. `createItem` auto-picks `position = max+1024`. Three-state `OptionalChange<Date>` for `PatchItemPayload.checked` lets the wire JSON distinguish "leave alone" (key absent), "explicit clear" (literal `null`), and timestamp. Test seams: `Clock` and `UUIDGenerating` protocols injected so tests use `FixedClock`+`SequenceUUIDGenerator` for exact assertions. Known shortcut: client UUIDs are v4 (Foundation) for now — backend `ON CONFLICT (id)` doesn't validate version bits so idempotency works; v7 generator is a Phase-19 polish per PLAN.md L47. 11 new `MutatorTests` cover atomic write, LWW pre-stamp, idempotency-id reuse, cascade + single queue entry, prior-cursor `ifMatch`, empty-PATCH error, three-state `checked` encoding, no-op on missing target. iOS test count 26 → 37, all green; xcodebuild clean for iPhone 17 Pro Max sim.
2026-05-05 — Phase 7 slice C.1 DONE: PR #10 rebase-merged (commits 1ce8b38 + f10620d on main). Backend write side live; iOS slice C.2 unblocked.
2026-05-05 — Phase 7 slice C.1 code-complete: backend write side. New `POST /lists` (idempotent via client UUID v7 + ON CONFLICT DO NOTHING; transactionally creates owner-membership row), `POST /lists/:id/items`, `PATCH /lists/:id` and `PATCH /items/:id` (If-Match conditional update; 409 with `{error, latest: …DTO}` body on mismatch — picked 409 over RFC 7232's 412 per PLAN.md L62), `DELETE /lists/:id` (owner-only, cascades soft-delete to items in same transaction with each item's `updated_at` bumped via `date_trunc('milliseconds', now())` so the `?since=` items feed surfaces every tombstone), `DELETE /items/:id`. Two new feature subapps (`lists/routes.ts`, `items/routes.ts`) plus six new repo helpers; DTO converters extracted to `sync/dto.ts` so write responses share the wire shape with the read feed. `backend/docs/sync.md` gains a "Write side (slice C.1)" section + Status table refresh. 22 new HTTP integration tests (11 lists + 11 items) pin: idempotent-retry shape (different name on retry returns the original row at 200), If-Match 200/409 with `latest`, owner-only DELETE + items-cascade with `updated_at` bump, cross-user 403, soft-deleted-id collision 409, empty-PATCH 400. Hono detail: header validation needs a real Zod object schema (not a hand-typed parameter object) or the `safeParseAsync` runtime check explodes. Drizzle/postgres detail: lookups inside a `db.transaction(async (tx) => …)` MUST go through `tx`, not the outer `db`, or they deadlock against the test pool's `max: 1`. Backend test count 70 → 92, all green; biome + tsc clean.
2026-05-05 — Phase 7 slice B code-complete: iOS read-side sync engine. Five new SwiftData `@Model` types (UserModel, ListModel, ItemModel, MemberModel, SyncCursor) + a `ModelConfiguration` in AppContainer; in-memory variant for previews/tests. `NetworkMonitor` wraps `NWPathMonitor` as `@Observable @MainActor` with `NetworkMonitoring` protocol seam + `MockNetworkMonitor` for tests. `SyncEngine` does full-pull reconciliation in lists → items → members order, persisting per-resource `serverTime` cursors and applying tombstone-aware upserts: list/item tombstones drop the local row; self-revocation (own member row tombstoned) sweeps the entire list — items, other members, the list itself. SyncDTOs.swift mirrors the backend Zod schemas with a `checked` → `checkedAt` rename for naming-consistency at the call site. SharedListApp kicks off an initial reconcile post-bootstrap if a session is loaded. Made `AuthServicing` `AnyObject`-constrained so the SyncEngine's `currentUserId` closure can capture `auth` weakly without a retain cycle. 8 new Swift Testing tests script the three feeds via `MockSession` and assert: feed order, upsert correctness, list/item tombstone removal, self-revocation sweep (incl. cleanup of items + other-member rows that were never tombstoned themselves), cursor persistence + round-trip on second pull, offline no-op, unauthenticated throws. 26/26 iOS tests pass (18 → 26). Build succeeds for iOS 26 simulator. PLAN.md note: real-Testcontainers test path deferred to slice C, where there's an offline-mutate cycle to actually exercise — the backend's HTTP integration tests pin the wire contract slice B consumes against shared DTO types.
2026-05-05 — Phase 8 code-complete (single PR per owner request). Android sync engine mirrors iOS Phase 7 layer-by-layer: Room entities (`UserEntity`/`ListEntity`/`ItemEntity`/`MemberEntity`/`SyncCursorEntity`/`MutationQueueEntity`; composite PK on members is cleaner than iOS's pipe-joined-string workaround), `JsonCoders.kt` with explicit `InstantIso8601MillisSerializer` (fixed-3-digit fractional, lenient parse) — load-bearing front-loaded fix to dodge the kotlinx-serialization equivalent of the iOS slice-D Foundation-default bug, `NetworkMonitor` wrapping `ConnectivityManager.NetworkCallback` as `StateFlow<Boolean>` with `FakeNetworkMonitor` test double, `SyncEngine` (read-side reconciler in lists → items → members order, LWW upsert, self-revocation sweep wrapped in `database.withTransaction`), `Mutator` (atomic local-apply + queue-append in one Room transaction; pre-stamps `updatedAt` to `clock.now()`; captures prior `updatedAt` as `If-Match`; cascades soft-delete on `deleteList` but enqueues ONE entry; three-state `CheckedAtChange` for the wire `checked` field hand-encoded via `JsonElement` to preserve absent/null/timestamp distinction), `Drainer` (serial drain via `Mutex` + `isDraining`; per-tick stop on requeue; 2xx/401/404/403/5xx/network status handling; 409 → `SyncEngine.upsertListLww`/`upsertItemLww` + retry-once with rebuilt body from local truth; stale `inFlight` reset on init via `queueDao.resetStaleInFlight()`). 55 tests: 5 `JsonCodersTest`, 8 `SyncEngineTest`, 11 `MutatorTest`, 11 `DrainerTest`, 4 `SyncFuzzTest` (rapid-create-delete-create / simultaneous-edits-with-chained-If-Match / edit-on-server-deleted / list-deleted-while-items-have-pending-mutations), 2 env-gated `DrainerIntegrationTest`, plus carry-over auth tests. Robolectric 4.14 needed for Room-touching tests (Room's `inMemoryDatabaseBuilder` requires a Context); pure JUnit for `JsonCodersTest` and pre-existing tests. Three Kotlin-specific subtleties surfaced: (1) under `runTest`+`TestScope`, kicked drain coroutines yield between Mutator calls and eat queue entries before fuzz assertions can read them — fix is to deliberately NOT `attachDrainer` in fuzz fixtures (production wires it; `DrainerTest` covers the attached path through unit-scoped scenarios); (2) `Instant.toString()` truncates trailing zero fractional digits the same way Foundation's `.iso8601` strategy does — the `JsonCodersTest.writesExactlyThreeFractionalDigitsEvenForZero` assertion guards against regression; (3) Room `@Transaction` cross-DAO orchestration goes through the database-level `withTransaction { }` extension rather than abstract DAO classes (the latter doesn't compose cleanly across multiple `@Dao` interfaces). PR ready; CI integration deferred to Phase 19 polish per same convention as iOS.
2026-05-05 — Phase 8 integration tests verified locally: 2/2 passing against `bun run dev` on `http://localhost:3000`. Two follow-up fixes pushed to PR #14 before merge: (1) `DrainerIntegrationTest.makeEnvironment` was wiring `mutator.attachDrainer(drainer)`, which raced the test's explicit `tick()` from `runTest`'s TestScope (Mutator's auto-kick launches into Drainer's own `Dispatchers.IO`; both serialize through the mutex but the explicit tick returned early when the kicked tick was mid-request, queue assertion ran before the drain finished). Same `attachDrainer`-free pattern as `SyncFuzzTest`. (2) Documented `BACKEND_URL=http://localhost:3000` (not the Caddy mDNS hostname) — the JVM's truststore doesn't trust mkcert by default, so HTTPS to `Santoshs-MacBook-Pro-48.local` fails with PKIX path building errors; HTTP loopback bypasses TLS for the local unit-test process. Also documented the 3/hour/IP signup rate-limit gotcha (restart `bun run dev` to reset). The `attachDrainer`-in-tests bug is the same one that would have surfaced in production usage if the integration suite hadn't run; saved memory `feedback_run_integration_tests.md` so future phases run env-gated tests up front rather than punting to "manual pre-merge."
2026-05-05 — **Phase 8 DONE**: PR #14 rebase-merged (commits 66f7921 + 86f1a3b + 567b7aa on main). Phase header in STATUS flipped to `DONE 2026-05-05`. Final: 55 Android tests (53 pass + 2 env-gated skip on CI; 2/2 of those 2 pass locally against the live backend); detekt + assemble + unit-tests CI green on real GitHub runner. `docs/learning/phase-08.md` ~1500 words covering Room vs SwiftData, kotlinx.serialization Instant trap, StateFlow vs Observable, runTest yield semantics, single-PR vs slice cadence; 5 rejected alternatives; 2 break-it scenarios. Phase 9 (cross-platform sync verification) opens — both platforms now ride the same wire contract; harness shape is open.
2026-05-05 — **Phase 9 DONE**: PR #15 rebase-merged (commits 536c1c0 + 8d50195 + d10efc5 + aa46bb3 + 2343816 on main). Phase header in STATUS flipped to `DONE 2026-05-05`. Final: 8/8 cross-platform scenarios PASS in both directions verified locally pre-merge; CI green on all three workflows after one Robolectric Maven-fetch flake on first Android run that cleared on retry (transient infra issue, not a code issue). Test counts on main: backend 92, iOS 63, Android 63 (53+8 cross-platform-skip+2 integration-skip). Phase 10 (backend WebSocket server + push infrastructure) opens — first Phase since 2 to add genuinely new backend surface (WS handler, push module, pg-boss queue, /devices endpoint).
2026-05-05 — Phase 9 code-complete on `phase-09-cross-platform-sync` branch. Decisions made up front: harness shape Option 2 (shell driver invokes each platform's env-gated test suite for one role per scenario; 4 scenarios × 2 directions = 8 pairs); same-user / two-device pattern (PLAN.md L386's scenarios don't require different users; multi-user sharing tests belong to Phase 15); permanent generous rate-limit bump on backend (signup 3/h→10/h, login 5/m→30/m, refresh unchanged) updated in `rate-limits.ts` + `rate-limits.test.ts` + PLAN.md L81 in lockstep; single PR per phase. New `CrossPlatformConvergenceTest{s}` suite per platform (9 tests each: setup_seedFreshList + 4 scenarios × 2 roles + scenarioC_reconcileOnly), env-gated on `BACKEND_URL` + `CROSS_PLATFORM_USER_EMAIL` + `CROSS_PLATFORM_USER_PASSWORD` + `CROSS_PLATFORM_ROLE`. Harness `scripts/cross-platform-sync.sh` (~400 lines bash) parses test stdout via `CROSS_PLATFORM_RESULT[KEY]=VALUE` markers; iOS uses `xcrun simctl spawn launchctl setenv` for env injection, Android uses gradle's env-prefix; Android stdout extracted from `app/build/test-results/.../<system-out>` because gradle suppresses `println` from tests by default. **Verified locally: 8/8 scenarios PASS in both directions** against `bun run dev` on `http://localhost:3000`. Three implementation gotchas surfaced + fixed: (1) Swift Testing requires `()` trailing parens in `-only-testing` identifiers — without them xcodebuild silently runs zero tests AND reports the suite as passed; (2) gradle's test stdout suppression — RESULT lines live in JUnit XML's `<system-out>`, not the gradle log; (3) scenarioD assertion bug — initial expectation was "tombstone = upsert with deletedAt set," actual contract is "delete the local row entirely" (`deleteLocalItem` / `itemDao.deleteById`). All caught + corrected in this session. scenarioC's three-step convergence assertion (act renames + drains → observer renames + drains → act reconcile-only refresh → both end with same canonical name) is what eventual consistency looks like under a sequential test driver. `ios/docs/sync.md` + `android/docs/sync.md` written (architectural overviews, ~600 lines combined). `docs/learning/phase-09.md` ~1500 words covering harness shape, three gotchas, scenarioC convergence shape, why the wire-format contract carries most of the cross-platform parity weight; 5 rejected alternatives; break-it scenario (offline-delete vs online-PATCH conflict — DELETE is unconditional in current protocol so PATCH gets silently lost; documented for Phase 18 hardening). Test counts: backend 92 (rate-limit test loop adjusted to 10/11), iOS 63 (54+9 cross-platform pass-with-nothing without env), Android 53 + 2 integration-skip + 8 cross-platform-skip = 63. PR ready.
```

---

## Discipline rules

1. **Last action of every session**: update the "Right now" block (Last updated, Phase, Next action, Blockers). Tick any boxes completed this session. Append one line to "Session log."
2. **First action of every session** (and first thing Claude reads at session start): this file, then `KNOWN_DEBT.md`. Don't start coding until you've re-oriented.
3. **Commit `STATUS.md` updates separately** with messages like `status: Phase 4 — finished /refresh endpoint`. `git log STATUS.md` then becomes a true project diary independent of code commits.
4. **Phase state transitions** are explicit: `NOT STARTED` → `IN PROGRESS (started YYYY-MM-DD)` → `DONE YYYY-MM-DD`. Use `BLOCKED — <reason>` if stuck on something external. Don't leave a phase in `IN PROGRESS` for weeks without movement — promote the unmet items into `KNOWN_DEBT.md` and demote the phase back if necessary.
5. **A phase is not `DONE`** until every checkbox is ticked AND `docs/learning/phase-NN.md` exists. Half-done phases stay `IN PROGRESS` with the unmet boxes visible.
