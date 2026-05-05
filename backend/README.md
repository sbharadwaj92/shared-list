# backend/

Bun + Hono + TypeScript + Drizzle, behind Caddy + mkcert TLS on the LAN. Postgres 17 (data) + Mailpit (dev SMTP) in Docker. Single source of truth for backend bring-up — every other doc that mentions backend commands links here.

## Architecture

Three long-lived processes that all need to be running for end-to-end requests to work:

```
┌──────────────────────────────────────────────────────────┐
│ 1. Caddy — TLS reverse proxy on :443                     │  brew services
│    Santoshs-MacBook-Pro-48.local + 10.0.2.2 → 127.0.0.1  │  (launchd)
└──────────────────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│ 2. Bun + Hono app — HTTP server on :3000                 │  bun run dev
│    /health, /auth/*, OpenAPI at /swagger-ui              │  (foreground)
└──────────────────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│ 3. Postgres 17 (:5432) + Mailpit SMTP (:1025) / UI :8025 │  docker compose
└──────────────────────────────────────────────────────────┘
```

Each layer is independent. If only one is missing, requests fail in different ways:

- **No Postgres** → Bun crashes on startup or returns 500 on auth endpoints.
- **No Bun** → Caddy returns 502 Bad Gateway.
- **No Caddy** → `curl https://...local/health` connection-refuses; `curl http://localhost:3000/health` still works.

## Daily bring-up (cold machine → working backend)

In order. Each command is idempotent — safe to re-run if the layer is already up.

```bash
# 1. Database + mail catcher (containerized, persistent across sessions).
docker compose -f /Users/santoshbharadwaj/Projects/shared-list/backend/docker-compose.yml up -d

# 2. Caddy — managed by macOS launchd. Started this once during Phase 1
#    setup and it persists across reboots. You usually don't need to run
#    this; it's already up. Verify with `brew services list | grep caddy`.
brew services start caddy

# 3. Bun app — foreground, needs a dedicated terminal. This is the layer
#    that actually restarts most often during development; the other two
#    stay up for weeks at a time.
cd /Users/santoshbharadwaj/Projects/shared-list/backend && bun run dev
```

## Status check

If something seems broken, work top-down:

```bash
# Layer 1: containers
docker compose -f /Users/santoshbharadwaj/Projects/shared-list/backend/docker-compose.yml ps
# Want: shared-list-postgres-1 ... Up; shared-list-mailpit-1 ... Up

# Layer 2: Caddy
brew services list | grep caddy
# Want: caddy started

# Layer 3: Bun app (without Caddy in the path)
curl -s http://localhost:3000/health
# Want: {"ok":true}

# Full stack (TLS, mDNS, Caddy → Bun → DB)
curl -sk https://Santoshs-MacBook-Pro-48.local/health
# Want: {"ok":true}
```

The `-k` skips TLS verification — fine for the health check. Real clients (iOS / Android) trust the mkcert root CA explicitly.

## Tests

```bash
cd /Users/santoshbharadwaj/Projects/shared-list/backend
bun test
```

Tests use Testcontainers and stand up their **own** Postgres in a sibling container — they neither read nor write the main `docker-compose.yml` Postgres. Safe to run while the dev DB has data in it.

## Database migrations

Drizzle migrations live in `backend/drizzle/`. Schema source-of-truth in `backend/src/db/schema.ts`.

```bash
cd /Users/santoshbharadwaj/Projects/shared-list/backend

# Generate a migration from a schema diff (writes a new SQL file under drizzle/)
bun run db:generate

# Apply pending migrations to the running Postgres
bun run db:migrate

# Open Drizzle Studio (web UI for browsing rows) at http://localhost:4983
bun run db:studio
```

## Shutdown (rare)

You almost never need this — Caddy runs under launchd and Postgres has no resource pressure on idle.

```bash
# Stop Bun: Ctrl-C in its terminal.

# Stop Caddy:
brew services stop caddy

# Stop Postgres + Mailpit (data persists in named docker volumes):
docker compose -f /Users/santoshbharadwaj/Projects/shared-list/backend/docker-compose.yml down
# DO NOT add `-v` — that flag also wipes the Postgres volume, which means
# every user / list / item we've created so far gets nuked. CLAUDE.md hard
# rule explicitly forbids `docker compose down -v` without confirmation.
```

## TLS / certs

Caddy serves with a mkcert-issued cert under `backend/certs/dev.crt` (gitignored — machine-local). The cert SAN list:

- `Santoshs-MacBook-Pro-48.local` — primary mDNS hostname for physical devices
- `localhost` — host-local testing
- `127.0.0.1` — host-local IPv4
- `10.0.2.2` — Android Emulator alias for the host loopback

If you regenerate the cert (e.g. expired), keep that exact SAN list:

```bash
cd backend/certs
mkcert -cert-file dev.crt -key-file dev.key \
  Santoshs-MacBook-Pro-48.local localhost 127.0.0.1 10.0.2.2
brew services restart caddy
```

The `mkcert -install` step (only needed once per machine, in Phase 1) drops the mkcert root CA into the macOS / iOS Simulator trust stores. Physical devices need it installed manually — see `ios/README.md` and `android/README.md` for the per-platform steps.

## Caddyfile location and editing

The Caddyfile read by `brew services start caddy` is `/opt/homebrew/etc/Caddyfile`, which is a symlink to `backend/Caddyfile` (set up once during Phase 1). So:

- Edit `backend/Caddyfile` — that's the file under version control.
- Run `brew services restart caddy` for changes to take effect.

Logs land in `/opt/homebrew/var/log/caddy.log`.

## See also

- `docker-compose.yml` — Postgres + Mailpit container definitions.
- `Caddyfile` — TLS reverse proxy config.
- `src/config.ts` — Zod-validated env loading; `.env.example` shows the keys.
- `src/db/schema.ts` — Drizzle schema (single source of truth for tables).
- `src/features/*/` — feature-grouped: routes, schemas, service, repo, tests.
- `PLAN.md` (repo root) — architectural rationale, sync protocol, phase plan.
