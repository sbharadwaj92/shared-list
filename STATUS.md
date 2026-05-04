# Project Status

Single source of truth for "where am I right now" across sessions and devices. Read this first at session start; update at session end.

The "Right now" block at the top is the session handoff. The "Phases" block below tracks each phase's state and remaining checkboxes against its `PLAN.md` "Done" criteria. The "Session log" at the bottom is an optional one-line-per-session diary.

---

## Right now

**Last updated**: 2026-05-04
**Phase**: Phase 4 DONE — ready to begin Phase 5 (iOS auth)
**Next action**: create Xcode project (`SharedList`, iOS 26 min, Swift 6 strict concurrency), folder structure, custom `KeychainStore` wrapper, `TokenStore`, `APIClient` with auth header injection + 401 → single-flight refresh → retry, `AppContainer` (manual DI), `RootView` + `LoginFlowView`, Swift Testing unit tests + previews, iOS GitHub Actions workflow at end of phase
**Blockers**: none

---

## Phases

States: `NOT STARTED`, `IN PROGRESS (started YYYY-MM-DD)`, `BLOCKED — <reason>`, `DONE YYYY-MM-DD`

Checkboxes mirror each phase's "Done" criteria from `PLAN.md`. Tick them as you go. A phase is `DONE` only when all boxes are checked AND `docs/learning/phase-NN.md` is committed (per `LEARNING_PROTOCOL.md`).

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

#### Phase 5 — iOS auth — NOT STARTED
- [ ] Xcode project (`SharedList`, iOS 26 min, Swift 6 strict concurrency)
- [ ] Folder structure (App/Features/Core/Resources/)
- [ ] Custom `KeychainStore` wrapper
- [ ] `TokenStore` for access/refresh storage and rotation
- [ ] `APIClient` with auth header injection + 401 → single-flight refresh → retry
- [ ] `AppContainer` with `apiClient`, `tokenStore`, `auth`
- [ ] `RootView` + `LoginFlowView` (signup, login, logout)
- [ ] Swift Testing unit tests; previews for every view
- [ ] Sign up + log in + log out works on Simulator and physical iPhone
- [ ] Refresh token survives app restart
- [ ] iOS GitHub Actions workflow added
- [ ] iOS CI green on real build
- [ ] `docs/learning/phase-05.md` written

#### Phase 6 — Android auth — NOT STARTED
- [ ] Android Studio project (`SharedList`, minSdk 35, Kotlin 2.x, Compose)
- [ ] Gradle Kotlin DSL + version catalogs
- [ ] Detekt + explicit API mode
- [ ] Custom `EncryptedSharedPreferences` wrapper
- [ ] `TokenStore` mirroring iOS
- [ ] `ApiClient` (Ktor) with auth header + 401 single-flight refresh interceptor
- [ ] `AppContainer` via `CompositionLocal`
- [ ] Root composable + login flow with `StateFlow<UiState>`
- [ ] JUnit unit tests
- [ ] Auth flows working on Emulator + S24 Ultra
- [ ] Refresh token survives app restart
- [ ] Android GitHub Actions workflow added; CI green
- [ ] `docs/learning/phase-06.md` written

### Sync foundation block (Phases 7–9)

#### Phase 7 — Backend sync protocol + iOS sync engine in tandem — NOT STARTED
- [ ] Backend: `?since=` endpoints for lists, items, list_members
- [ ] Backend: `If-Match` conditional writes (409 on mismatch)
- [ ] Backend: idempotent `POST` (UUID v7 + `ON CONFLICT DO NOTHING`)
- [ ] iOS: SwiftData `@Model` types + `ModelContainer`
- [ ] iOS: `NetworkMonitor` (`NWPathMonitor`-backed `@Observable`)
- [ ] iOS: `SyncEngine` with mutation queue, drainer, reconciliation, LWW
- [ ] Sync engine tests against real Testcontainers Hono server
- [ ] Full offline-mutate / reconnect / reconcile / tombstone-converge cycle proven
- [ ] `backend/docs/sync.md` documents the protocol
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
```

---

## Discipline rules

1. **Last action of every session**: update the "Right now" block (Last updated, Phase, Next action, Blockers). Tick any boxes completed this session. Append one line to "Session log."
2. **First action of every session** (and first thing Claude reads at session start): this file, then `KNOWN_DEBT.md`. Don't start coding until you've re-oriented.
3. **Commit `STATUS.md` updates separately** with messages like `status: Phase 4 — finished /refresh endpoint`. `git log STATUS.md` then becomes a true project diary independent of code commits.
4. **Phase state transitions** are explicit: `NOT STARTED` → `IN PROGRESS (started YYYY-MM-DD)` → `DONE YYYY-MM-DD`. Use `BLOCKED — <reason>` if stuck on something external. Don't leave a phase in `IN PROGRESS` for weeks without movement — promote the unmet items into `KNOWN_DEBT.md` and demote the phase back if necessary.
5. **A phase is not `DONE`** until every checkbox is ticked AND `docs/learning/phase-NN.md` exists. Half-done phases stay `IN PROGRESS` with the unmet boxes visible.
