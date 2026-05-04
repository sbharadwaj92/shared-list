import pino, { type Logger } from 'pino';
import { config } from './config.ts';

const isDev = config.NODE_ENV === 'development';

const baseOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  base: { service: 'backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    censor: '[redacted]',
  },
};

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
