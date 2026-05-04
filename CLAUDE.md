# Project: shared-list

A learning-focused, locally-hosted shared grocery/todo list app for ~3 users (the owner + a friend). Backend + iOS + Android, all built from scratch. **Depth of learning over speed to ship.**

This file is auto-loaded as context for every Claude Code session in this repo. It exists to point you at the right source-of-truth documents so you don't guess.

---

## Read this first, every session

In order, before any code action:

1. **`STATUS.md`** — single source of truth for "where am I right now." Has the "Right now" block (Last updated / Phase / Next action / Blockers), per-phase state, and session log. Always read this first to orient.
2. **`KNOWN_DEBT.md`** — open debt rows. Items here may be relevant to the current phase.
3. **`PLAN.md`** — the master plan. ~520 lines covering stack decisions, architecture, schema, sync protocol, push design, and 19 sequential phases with "Done" criteria. Authoritative for *what* gets built and *why*.
4. **`LEARNING_PROTOCOL.md`** — the learning practice. Per-phase teach-back template, rejected-alternatives note, optional break-it session. Has seeded prompts for every phase.

If a question is answered in any of those files, use that answer rather than asking the user or guessing.

---

## Project framing

- **Owner**: experienced frontend engineer (TypeScript / React) broadening into backend, native mobile, and DevOps fundamentals. Solo project, ~20 hrs/week, no deadline.
- **Constraint**: depth of learning over speed. The user has explicitly accepted that the first ~3 months produce no user-visible UI under the chosen sequencing.
- **Out of scope** (explicitly, see `PLAN.md` "What's explicitly NOT in this plan"): cloud infra, app store publishing, off-LAN access, database backups, undelete UI, BGAppRefreshTask. Don't propose these.
- **No off-ramp from sync engine work** — the sync engine is the central learning goal; if Phase 7 stalls, the project pauses rather than abandoning the goal.

---

## Repo structure

Currently pre-execution. As phases land:

- `backend/` — Bun + Hono + TypeScript + Drizzle (Phase 2+)
- `ios/` — Swift 6, SwiftUI, SwiftData (Phase 5+)
- `android/` — Kotlin 2.x, Compose, Room (Phase 6+)
- `.github/workflows/` — CI per platform, added per-phase as code lands (NOT all upfront)
- Root: `package.json` (Bun workspaces), `lefthook.yml`, `PLAN.md`, `STATUS.md`, `KNOWN_DEBT.md`, `LEARNING_PROTOCOL.md`, `README.md`, `CLAUDE.md` (this file)
- `docs/learning/phase-NN.md` — one per phase, per `LEARNING_PROTOCOL.md`
- `backend/docs/sync.md` (Phase 7), `ios/docs/sync.md` and `android/docs/sync.md` (Phase 9)

---

## Session workflow

### Starting a session

1. Read `STATUS.md` → identify current phase + next action.
2. Read `KNOWN_DEBT.md` → check if any debt is due before starting the next phase.
3. Skim the *current phase's section* in `PLAN.md` if context is needed.
4. Begin work on the next action.

### Ending a session

1. Tick any completed checkboxes in `STATUS.md`.
2. Update the "Right now" block (Last updated, Phase, Next action, Blockers).
3. Append one line to the "Session log" in `STATUS.md`: `YYYY-MM-DD — <what got done in 1 sentence>`.
4. Commit `STATUS.md` updates **separately** from code with messages like `status: Phase 4 — finished /refresh endpoint`. `git log STATUS.md` is the project diary.

### Phase completion

A phase is `DONE` only when:
- Every checkbox in its `STATUS.md` section is ticked.
- `docs/learning/phase-NN.md` exists with the three sections from `LEARNING_PROTOCOL.md` (teach-back, rejected alternatives, optional break-it log).
- The "Done" criteria in `PLAN.md` are met.

If you can't tick all boxes, the phase stays `IN PROGRESS`. Move unmet items to `KNOWN_DEBT.md` only with the user's agreement.

---

## Code style

Owner's standing preferences (also in their global `~/.claude/CLAUDE.md`):

- **TypeScript**: never `any`; prefer `unknown`. Named exports, not default. Explicit error handling — no silent catches.
- **Comments**: explain *why*, not *what*. Named constants over magic numbers.
- **Immutability**: prefer `const`, `readonly`.
- **No `console.log`** in committed code. Never commit `.env` or secrets.
- **Tests**: unit tests co-located (`Foo.test.ts` next to `Foo.ts`); E2E in `e2e/`. Descriptive test names. Coverage on business logic, not 100% chase.
- **Communication style**: detailed reasoning, trade-offs, alternatives before implementing. Walk through investigation steps when debugging. Skip filler.

Stack-specific (see `PLAN.md` for the full set):

- **Backend**: Bun + Hono + Drizzle + Zod + Pino. Biome for lint+format. Lefthook for git hooks. `bun test` for tests, Testcontainers for integration. UUID v7 PKs everywhere.
- **iOS**: Swift 6 strict concurrency, MVVM with `@Observable`, manual DI via `AppContainer`, SwiftData, `URLSession` (no Alamofire), Swift Testing.
- **Android**: Kotlin 2.x with explicit API mode, MVVM with `StateFlow<UiState>`, manual DI via `CompositionLocal`, Room, Ktor Client (no Hilt/Koin), JUnit.

---

## Hard rules

- **NON-NEGOTIABLE: never reference the owner's employer or personal/work identifiers in any committed file, commit message, doc, learning artifact, or git metadata.** This means no employer name, no work usernames or aliases, no work email, no company-specific hostnames, no internal project codenames. The owner's professional context exists for *agent reasoning only* — it must not leak into project artifacts. If role/experience context is genuinely load-bearing for prose, use neutral phrasing ("experienced frontend engineer", "broadening into backend") and stop there. When in doubt, omit. This applies in advance to *every* file you create or edit; don't write contamination and rely on a later pass to scrub it.
- **Don't deviate from `PLAN.md`** without explicit user agreement. The plan was carefully reviewed; surprise architectural changes are not welcome. Suggest, don't unilaterally implement.
- **Don't skip the learning protocol** to "save time." It is part of every phase's Done criteria.
- **Don't push to `main`**. GitHub Flow: feature branches, PRs, branch protection.
- **Don't bypass git hooks** (`--no-verify`, `--no-gpg-sign`, etc). If a hook fails, fix the underlying issue.
- **Don't `git push --force` on shared branches** without confirmation.
- **Don't commit secrets** — `.env`, `.p8` keys, `google-services.json`, service account JSONs. Verify `.gitignore` before any commit that touches config.
- **Don't run destructive operations** (drop DB, `rm -rf`, `docker compose down -v`, `git reset --hard`) without confirmation. The Postgres data is intentionally without backups; nuking the volume is a real loss of in-progress test data.
- **Don't add unrequested features, refactors, or abstractions.** A bug fix doesn't need surrounding cleanup. Three similar lines is better than a premature abstraction.
- **Don't add `console.log`, debugger statements, or commented-out code** to committed work.
- **Don't add error handling for impossible cases** — only validate at system boundaries.

---

## Things to ask the user about

- **Phase boundaries**: do not start Phase N+1 without confirming Phase N is `DONE` in `STATUS.md`.
- **Adding to `KNOWN_DEBT.md`**: any new debt entry needs user agreement on the fix-by date.
- **Cloud / store-publishing / off-LAN proposals**: explicitly out of scope; if the user seems to want one, confirm before changing the plan.
- **Library swaps not in `PLAN.md`** (e.g., switching from postgres.js to bun-sql or vice versa): the plan documents the rationale; deviations need a conversation.

---

## Useful one-liners (when execution begins)

These will become real once Phase 2+ exist. Ignore until then:

```bash
# Start backend dev loop (Phase 2+)
docker compose -f backend/docker-compose.yml up -d
caddy run --config backend/Caddyfile  # separate terminal
cd backend && bun run dev

# Health check
curl https://Santoshs-MacBook-Pro-48.local/health

# Run backend tests
cd backend && bun test

# Run sync engine tests (Phase 7+ on iOS, Phase 8+ on Android)
xcodebuild test -scheme SharedListTests
./gradlew test
```

---

## When in doubt

The hierarchy is: **the user's stated request > `PLAN.md` > `STATUS.md` for state > `KNOWN_DEBT.md` for outstanding work > `LEARNING_PROTOCOL.md` for the learning practice > this file**. Anything you can answer from those files, answer from those files. Anything you can't, ask the user.
