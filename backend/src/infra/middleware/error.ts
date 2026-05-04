import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { RequestIdVariables } from './request-id.ts';

type ErrorContext = Context<{ Variables: RequestIdVariables }>;

// Every error response carries the requestId so a user-reported "I got an error"
// can be matched to the exact log entry on the server. Stable shape keeps clients
// from string-parsing free-form messages.
type ErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

// Centralized via `app.onError(...)` rather than per-route try/catch. Two reasons:
// (1) handlers can `throw new HTTPException(404, {message: 'not found'})` and stop
//     thinking about response shaping — the central handler owns the JSON envelope;
// (2) any *unexpected* throw (a bug, a downstream timeout) lands here too, so we
//     never leak a stack trace to the client by accident — it's logged at .error()
//     server-side and shaped to a generic 500 outside.
export const onError = (err: Error, c: ErrorContext): Response => {
  const reqLogger = c.get('logger');
  const requestId = c.get('requestId');

  // HTTPException is Hono's "I meant to send this status" signal. Logged at .warn()
  // because it's an expected failure path (validation, auth, not-found), not a bug.
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

  // Anything not an HTTPException is by definition unexpected. Log the full error
  // server-side (Pino serializes the `err` field with stack), but surface only a
  // generic message to the client — the requestId is enough to find the trace.
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
