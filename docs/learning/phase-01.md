# Phase 1 — Repo + tooling bootstrap

## 1. Teach-back

Phase 1 created the empty room the next ~14 months of work will be done in. There is no application code yet — just the project's connective tissue: a git repo on GitHub, a layout that anticipates three codebases living side-by-side, and the local infrastructure that will eventually let a phone trust a backend running on a laptop over WiFi. None of it does anything user-visible. Most of it will not be touched again for months. The point of building it now is to fix the shape of the project before the shape becomes annoying to change.

The repo is a single monorepo (`backend/`, `ios/`, `android/` will live as siblings) rather than three separate repos. Three repos would mean three sets of CI, three places to land lockstep changes, and a constant temptation to skew them out of step. PLAN.md's central sequencing rule is **lockstep across all three platforms per feature** — the file layout enforces that rule by making a "skip Android this week" PR look weird on its face. Bun workspaces are declared at the root from day one even though only one TypeScript package (`backend/`) will ever live inside them; the cost of declaring `workspaces: ["backend"]` now is zero, and it removes a future migration if a second TS-shaped thing ever appears.

`lefthook.yml` is currently a stub — both `pre-commit` and `pre-push` have empty command lists. That's intentional: lefthook runs whatever commands you list at the moment a git event fires, and there is nothing meaningful to run at commit time until Phase 2 introduces Biome and `bun test`. A real hook would block commits over a missing tool that doesn't exist yet. The stub exists so Phase 2 can add commands without re-litigating the file's existence and without anyone needing to run `lefthook install` twice. Without lefthook, formatting and tests would only fail in CI — minutes after a push instead of seconds before. The local hook is a latency optimization for the feedback loop, not a quality gate (CI is the gate).

`mkcert` is the other thing worth understanding. The end goal is for an iPhone and an Android phone to talk to a Bun process on the M2 Max over `https://`. That requires a TLS certificate the phones trust. A self-signed certificate works in the bytes-on-the-wire sense but the phones reject it because no chain of trust leads back to a CA they recognize. mkcert solves this by generating a one-laptop-only root CA, putting it in the macOS System keychain, and then issuing leaf certs for `*.local` hostnames signed by that CA. Once the same root CA is also installed on the iPhone and Android, certs signed by it Just Work — with the same browser-style green padlock the phones expect, and without the per-app cert pinning ceremony a self-signed setup would force. The CA root lives at `~/Library/Application Support/mkcert/`; a leaf cert for `Santoshs-MacBook-Pro-48.local` will be issued in Phase 2 when Caddy starts terminating TLS in front of Hono.

The bootstrap also commits the four pre-execution governance docs (`PLAN.md`, `STATUS.md`, `LEARNING_PROTOCOL.md`, `CLAUDE.md`) and the empty `KNOWN_DEBT.md` table. These exist so a future me opening this repo cold knows where to look without asking. Phase 2 will be the first phase where "running code" exists — Postgres in Docker, Hono on host, `/health` returning JSON over TLS — and it depends on Phase 1 only as far as "the directory exists, the certs work, the repo accepts pushes."

## 2. Rejected alternatives

**Decision**: SSH remote rewritten to a dedicated `github.com-personal` host alias in `~/.ssh/config` so this repo's pushes use a key bound to its GitHub account.
**Rejected**: switching the global SSH default identity, or moving to HTTPS + `gh` token auth.
**Why**: the host-alias approach is local to this one repo via the remote URL, leaving every other remote on the machine untouched. HTTPS would have worked but mixes the auth model (token vs. key) across repos and would have meant editing global git credential helper config for one personal project.

**Decision**: Repository-local git identity set with `git config user.name/user.email`, scoped only to this repo.
**Rejected**: changing the machine-wide `~/.gitconfig` identity.
**Why**: repo-local config is the conventional way to own a personal repo's `git log` without modifying any global configuration. It scales — every personal repo on this machine should do the same.

## 3. Break-it session log

Skipped per `LEARNING_PROTOCOL.md` — Phase 1 outcome is too thin to break meaningfully. The closest thing was the SSH push attempt that failed against the work key; that surfaced the dual-account `~/.ssh/config` constraint and is documented under Rejected alternatives.
