import { buildApp } from './app.ts';
import { BunEventPublisher } from './features/realtime/publisher.ts';
import { buildWsHandlers, upgradeWsRequest } from './features/realtime/ws.ts';
import { config } from './infra/config.ts';
import { db } from './infra/db.ts';
import { logger } from './infra/logger.ts';

// Phase 10 boot-time wiring.
//
// Three things now run inside this single `Bun.serve` call that used to be
// just `fetch: app.fetch`:
//
//   1. A `BunEventPublisher` is constructed BEFORE we hand off to buildApp,
//      so mutation routes get a real publisher injected into their
//      construction. The publisher's underlying `Server` reference can't
//      exist yet (we're literally about to construct it), so we bind it
//      in step 3 below.
//
//   2. The fetch handler intercepts `/ws` upgrades and routes everything
//      else to Hono. This pattern is `if (await upgradeWsRequest(...))
//      return; return app.fetch(...)` — keeping it in one place at the
//      root means feature routes don't need to know WS exists.
//
//   3. After `Bun.serve()` returns, we call `publisher.bind(server)` so
//      subsequent `publish()` calls land on the live server. There is a
//      vanishingly small window (microseconds) between the listen call
//      and the bind where a write would no-op-publish, but in practice the
//      first HTTP request can't arrive before bind completes because
//      we're still synchronous at this point.
const publisher = new BunEventPublisher();
const app = buildApp(db, { eventPublisher: publisher });
const wsHandlers = buildWsHandlers(db);

// Binding to 127.0.0.1 (loopback) instead of 0.0.0.0 is deliberate: the only
// thing on the network that should reach Bun is Caddy on the same host. Caddy
// terminates TLS and proxies to here. If we bound 0.0.0.0, the unencrypted
// HTTP server would be reachable from any device on the LAN — unsafe even for
// local dev. The phones reach us via Caddy at https://<host>.local, not direct.
const server = Bun.serve({
  port: config.PORT,
  hostname: '127.0.0.1',
  async fetch(req, srv) {
    // Hand WS upgrade requests off to the realtime handler. Three outcomes
    // — see WsUpgradeOutcome for the rationale on the discriminated shape.
    const outcome = await upgradeWsRequest(req, srv);
    switch (outcome.kind) {
      case 'upgraded':
        // Bun has already sent 101 Switching Protocols. Return undefined
        // to signal "response already on the wire."
        return undefined as unknown as Response;
      case 'response':
        // Either auth failed (401) or it wasn't actually a WS upgrade (400).
        return outcome.response;
      case 'not_ws':
        // Hono's `app.fetch` accepts `(req, env?, ctx?)`. We pass only the
        // request — the Bun server reference isn't a Cloudflare-style
        // `env`, and there's no `ExecutionContext` in Bun. Hono's request
        // handlers don't reach for either anyway.
        return app.fetch(req);
    }
  },
  websocket: wsHandlers,
});

// Wire the publisher to the live server now that it exists. From this point
// forward, mutation routes that call publisher.publish() will fan out to
// real subscribers. Before this line, publishes silently no-op (see
// BunEventPublisher.publish for the guard).
publisher.bind(server);

// First log line on every boot. Includes both port and env so the operator can
// confirm "I'm running the version I think I'm running on the port I expect."
logger.info({ port: server.port, env: config.NODE_ENV }, 'backend listening');

// Graceful shutdown: when SIGINT (Ctrl-C) or SIGTERM (docker stop, kill, brew
// services restart) arrives, stop accepting new connections, let in-flight ones
// finish, and exit. Without this, an in-flight DB transaction can be cut mid-write
// when the process is killed. Phase 2's /health doesn't touch the DB so the
// concrete risk is low here, but the pattern lives in index.ts so future phases
// inherit it for free.
const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'shutting down');
  server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
