# shared-list

A locally-hosted shared grocery/todo list app for ~3 users. Backend + iOS + Android, built from scratch as a learning project. **Depth of learning over speed to ship.**

## Status

Pre-execution → Phase 1 (repo + tooling bootstrap). See [`STATUS.md`](./STATUS.md) for the live state.

## Source-of-truth docs

| File | Purpose |
| ---- | ------- |
| [`STATUS.md`](./STATUS.md) | Where I am right now. Read first every session. |
| [`PLAN.md`](./PLAN.md) | The master plan — stack, architecture, schema, sync protocol, 19 phases. |
| [`LEARNING_PROTOCOL.md`](./LEARNING_PROTOCOL.md) | The per-phase teach-back / rejected-alternatives / break-it practice. |
| [`KNOWN_DEBT.md`](./KNOWN_DEBT.md) | "Done" criteria that slipped past their phase boundary. |
| [`CLAUDE.md`](./CLAUDE.md) | Auto-loaded context for Claude Code sessions. |
| `docs/learning/phase-NN.md` | Per-phase learning artifacts. |

## Stack (high-level)

- **Backend**: Bun + Hono + TypeScript + Drizzle + Postgres 17, behind Caddy + mkcert TLS on the LAN.
- **iOS**: Swift 6 strict concurrency, SwiftUI, SwiftData, MVVM with `@Observable`. iOS 26 minimum.
- **Android**: Kotlin 2.x explicit-API mode, Compose, Room, MVVM with `StateFlow<UiState>`. minSdk 35.
- All three speak a hand-rolled offline-first sync protocol (UUID v7 PKs, `?since=` reconciliation, `If-Match` conditional writes, soft-delete tombstones).
- Native push: APNs sandbox + FCM HTTP v1, fan-out from Bun via pg-boss.

See [`PLAN.md`](./PLAN.md) for the full rationale.

## Bring-up

Per-platform READMEs are the single source of truth. Don't duplicate commands here — they drift.

| Component | Doc |
| --- | --- |
| Backend (Postgres + Caddy + Bun) | [`backend/README.md`](./backend/README.md) |
| iOS app | [`ios/README.md`](./ios/README.md) |
| Android app | [`android/README.md`](./android/README.md) |

## Scope guard

- Local-only. No cloud. No app store.
- 2–3 users. Backend runs on owner's M2 Max. Phones connect over home WiFi.
- See `PLAN.md` → "What's explicitly NOT in this plan" before proposing anything beyond LAN.
