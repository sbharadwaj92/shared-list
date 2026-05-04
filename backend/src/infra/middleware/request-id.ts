import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import { logger } from '../logger.ts';

const REQUEST_ID_HEADER = 'X-Request-ID';
const MAX_INBOUND_ID_LENGTH = 128;

export type RequestIdVariables = {
  requestId: string;
  logger: Logger;
};

const isAcceptableInboundId = (value: string | undefined): value is string => {
  if (!value) return false;
  if (value.length === 0 || value.length > MAX_INBOUND_ID_LENGTH) return false;
  // Restrict to printable ASCII excluding whitespace; keeps logs grep-safe.
  return /^[\x21-\x7E]+$/.test(value);
};

export const requestId = (): MiddlewareHandler<{ Variables: RequestIdVariables }> => {
  return async (c, next) => {
    const inbound = c.req.header(REQUEST_ID_HEADER);
    const reqId = isAcceptableInboundId(inbound) ? inbound : crypto.randomUUID();

    const child = logger.child({
      reqId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    });

    c.set('requestId', reqId);
    c.set('logger', child);
    c.header(REQUEST_ID_HEADER, reqId);

    const start = performance.now();
    child.info('request received');
    await next();
    const durationMs = Math.round(performance.now() - start);
    child.info({ status: c.res.status, durationMs }, 'request completed');
  };
};
