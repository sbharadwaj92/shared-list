import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import { logger } from '../logger.ts';

const REQUEST_ID_HEADER = 'X-Request-ID';
const MAX_INBOUND_ID_LENGTH = 128;

// The `Variables` type is how Hono types `c.set(...) / c.get(...)` per request.
// Adding `logger` to the variables means every downstream handler gets a child
// logger with the request ID baked in — they can `c.get('logger').info(...)`
// without re-supplying the reqId.
export type RequestIdVariables = {
  requestId: string;
  logger: Logger;
};

// We accept inbound `X-Request-ID` so a calling system (e.g. an iOS client) can
// stitch its trace to ours, but unvalidated header values shouldn't land in logs:
// a newline or terminal control char would corrupt log lines and grep results,
// and an unbounded length lets a caller bloat memory. Restricting to printable
// ASCII excluding whitespace keeps logs greppable and bounds the worst case.
const isAcceptableInboundId = (value: string | undefined): value is string => {
  if (!value) return false;
  if (value.length === 0 || value.length > MAX_INBOUND_ID_LENGTH) return false;
  return /^[\x21-\x7E]+$/.test(value);
};

export const requestId = (): MiddlewareHandler<{ Variables: RequestIdVariables }> => {
  return async (c, next) => {
    const inbound = c.req.header(REQUEST_ID_HEADER);
    // Trust the inbound id only if it survives validation; otherwise mint our own.
    // crypto.randomUUID() is v4 (random), which is fine for a log-correlation id —
    // we don't need v7's time-ordering here (those are reserved for DB primary keys).
    const reqId = isAcceptableInboundId(inbound) ? inbound : crypto.randomUUID();

    // pino.child() creates a sub-logger that automatically includes these fields
    // on every log line. This is the trick that makes `reqId` appear on every
    // log entry within this request without manually threading it through every
    // function — alternatives (AsyncLocalStorage, manual passing) are heavier.
    const child = logger.child({
      reqId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    });

    c.set('requestId', reqId);
    c.set('logger', child);
    // Echo the id back so the client can log it on their end and operators
    // can match a user-reported failure to a server-side trace.
    c.header(REQUEST_ID_HEADER, reqId);

    // performance.now() is monotonic; Date.now() can jump backwards if the
    // system clock is adjusted (NTP, manual change), which would yield bogus
    // negative durations. Always use a monotonic clock for "elapsed time."
    const start = performance.now();
    child.info('request received');
    await next();
    const durationMs = Math.round(performance.now() - start);
    child.info({ status: c.res.status, durationMs }, 'request completed');
  };
};
