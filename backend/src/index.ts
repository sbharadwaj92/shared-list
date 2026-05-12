import { buildApp } from './app.ts';
import { buildPushServiceFromEnv } from './features/push/service.ts';
import { BunEventPublisher } from './features/realtime/publisher.ts';
import { buildWsHandlers, upgradeWsRequest } from './features/realtime/ws.ts';
import { config } from './infra/config.ts';
import { db } from './infra/db.ts';
import { logger } from './infra/logger.ts';

// Phase 10 boot-time wiring.
//
// Three subsystems get constructed here that didn't exist before this
// phase:
//
//   1. A `BunEventPublisher` is constructed BEFORE we hand off to buildApp,
//      so mutation routes get a real publisher injected into their
//      construction. The publisher's underlying `Server` reference can't
//      exist yet (we're literally about to construct it), so we bind it
//      after Bun.serve returns.
//
//   2. The fetch handler intercepts `/ws` upgrades and routes everything
//      else to Hono. Keeping it in one place at the root means feature
//      routes don't need to know WS exists.
//
//   3. A `PushService` is constructed from env. If PUSH_ENABLED=false
//      (most dev setups) the service is a no-op disabled implementation.
//      Otherwise we boot pg-boss, register the worker, and start the
//      queue processor. The graceful-shutdown hook stops the queue
//      cleanly so in-flight retries aren't orphaned.
const publisher = new BunEventPublisher();
const app = buildApp(db, { eventPublisher: publisher });
const wsHandlers = buildWsHandlers(db);

const pushService = buildPushServiceFromEnv({
  db,
  enabled: config.PUSH_ENABLED,
  databaseUrl: config.DATABASE_URL,
  apns:
    config.APNS_TEAM_ID && config.APNS_KEY_ID && config.APNS_PRIVATE_KEY && config.APNS_BUNDLE_ID
      ? {
          teamId: config.APNS_TEAM_ID,
          keyId: config.APNS_KEY_ID,
          privateKeyPem: config.APNS_PRIVATE_KEY,
          bundleId: config.APNS_BUNDLE_ID,
          useSandbox: config.APNS_USE_SANDBOX,
        }
      : null,
  fcm:
    config.FCM_PROJECT_ID && config.FCM_SERVICE_ACCOUNT_JSON
      ? {
          projectId: config.FCM_PROJECT_ID,
          serviceAccountJson: config.FCM_SERVICE_ACCOUNT_JSON,
        }
      : null,
});

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
// real subscribers.
publisher.bind(server);

// Boot the push service. We don't `await` at module top-level (Bun supports
// top-level await, but mixing it with the rest of this file gets gnarly);
// instead fire-and-await inside an IIFE and let a startup failure crash
// the process loudly — push being half-up is worse than push being down.
void (async () => {
  try {
    await pushService.start();
  } catch (err) {
    logger.fatal({ err }, 'push service failed to start');
    process.exit(1);
  }
})();

// First log line on every boot. Includes both port and env so the operator can
// confirm "I'm running the version I think I'm running on the port I expect."
logger.info({ port: server.port, env: config.NODE_ENV }, 'backend listening');

// Graceful shutdown: when SIGINT (Ctrl-C) or SIGTERM (docker stop, kill, brew
// services restart) arrives, stop accepting new connections, let in-flight ones
// finish, and exit. Without this, an in-flight DB transaction can be cut mid-write
// when the process is killed.
const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'shutting down');
  // Stop the push worker FIRST so jobs don't get pulled while we're
  // tearing down. Best-effort — we don't block shutdown on a stuck queue.
  void pushService.stop().catch((err) => logger.warn({ err }, 'push service stop failed'));
  server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
