import { buildApp } from './app.ts';
import { config } from './infra/config.ts';
import { logger } from './infra/logger.ts';

const app = buildApp();

const server = Bun.serve({
  port: config.PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
});

logger.info({ port: server.port, env: config.NODE_ENV }, 'backend listening');

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'shutting down');
  server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
