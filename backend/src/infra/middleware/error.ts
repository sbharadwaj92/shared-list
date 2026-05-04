import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { RequestIdVariables } from './request-id.ts';

type ErrorContext = Context<{ Variables: RequestIdVariables }>;

type ErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

export const onError = (err: Error, c: ErrorContext): Response => {
  const reqLogger = c.get('logger');
  const requestId = c.get('requestId');

  if (err instanceof HTTPException) {
    reqLogger.warn({ status: err.status, err: err.message }, 'http exception');
    const body: ErrorBody = {
      error: {
        code: 'http_exception',
        message: err.message,
        requestId,
      },
    };
    return c.json(body, err.status);
  }

  reqLogger.error({ err }, 'unhandled error');
  const body: ErrorBody = {
    error: {
      code: 'internal_server_error',
      message: 'Internal server error',
      requestId,
    },
  };
  return c.json(body, 500);
};
