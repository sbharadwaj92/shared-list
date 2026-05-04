import pino, { type Logger } from 'pino';
import { config } from './config.ts';

const isDev = config.NODE_ENV === 'development';

const baseOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  // `base` adds these fields to every single log line. `service: 'backend'`
  // becomes useful when we ship logs to an aggregator alongside future services.
  base: { service: 'backend' },
  // Default Pino timestamps are unix-millis numbers. ISO 8601 strings are far
  // more readable when scanning logs by eye and play nicer with most log viewers.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redaction is a *defense-in-depth* belt: a stray `logger.info({req})` shouldn't
  // leak a bearer token even if a developer forgets to scrub it. Paths use Pino's
  // dot-path notation; `*.password` matches `password` at any one level of nesting.
  // This is NOT a substitute for never logging secrets — it's the safety net for
  // when someone does. Update when adding new sensitive fields (e.g. refreshToken).
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    censor: '[redacted]',
  },
};

// Two transports by environment:
//   dev  -> pino-pretty: colored, multi-line, human-readable in a terminal
//   test/prod -> default JSON: one log line per record, machine-parseable
// The dev pretty transport is intentionally NOT used in tests — JSON in test logs
// makes failures grep-friendly in CI output. pino-pretty also runs in a worker
// thread, which adds a small amount of startup latency we don't need in prod.
export const logger: Logger = isDev
  ? pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
      },
    })
  : pino(baseOptions);

export type { Logger };
