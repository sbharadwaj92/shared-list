import { buildApp } from './app.ts';
import { config } from './infra/config.ts';
import { logger } from './infra/logger.ts';

const app = buildApp();

// Binding to 127.0.0.1 (loopback) instead of 0.0.0.0 is deliberate: the only
// thing on the network that should reach Bun is Caddy on the same host. Caddy
// terminates TLS and proxies to here. If we bound 0.0.0.0, the unencrypted
// HTTP server would be reachable from any device on the LAN — unsafe even for
// local dev. The phones reach us via Caddy at https://<host>.local, not direct.
const server = Bun.serve({
  port: config.PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
});

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
