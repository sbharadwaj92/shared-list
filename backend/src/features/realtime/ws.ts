import type { Server, ServerWebSocket } from 'bun';
import type { Database } from '../../infra/db.ts';
import { logger } from '../../infra/logger.ts';
import { verifyAccessToken } from '../auth/tokens.ts';
import { activeMembership } from '../list-members/repo.ts';
import { ClientMessage, type ServerMessageT } from './messages.ts';
import { listTopic } from './topics.ts';

// Per-socket state attached at upgrade time. `ws.data` carries these fields
// throughout the socket's lifecycle, replacing the per-socket Map<ws, state>
// we'd otherwise need to thread through every handler.
//
// `connectionId` is for log correlation only — it's not used by the protocol
// or shared with the client. Useful when triaging "why did this socket
// disappear?" from log lines on the operator side.
//
// `subscriptions` is tracked here AS WELL AS via Bun's `ws.subscriptions`
// because Bun's array is recomputed on every access (it's a getter, not a
// stored set). We keep our own Set so subscribe/unsubscribe runs in O(1)
// and we don't pay for a string-array scan on every message.
export type SocketData = {
  userId: string;
  connectionId: string;
  subscriptions: Set<string>;
};

// `?token=<jwt>` is the auth surface for the upgrade. The alternatives were:
//   - Cookie-based auth: works in browsers, but our clients are URLSession /
//     Ktor on native, both of which can set arbitrary headers on the
//     upgrade request but DON'T have a cookie jar by default. Adding one
//     for one use case is overkill.
//   - Authorization header: native URLSessionWebSocketTask actually does
//     support custom headers, but the browser WebSocket API does NOT — and
//     while we don't have a browser client today, picking a header-based
//     scheme would foreclose ever adding one without a protocol break.
//     Query-string auth is what the platform-mobile-WS community has
//     converged on for this exact reason.
//
// Query-string tokens have a sharp edge: they show up in access logs and
// `ps` output if anything ever pipes the URL to a shell. Mitigation: the
// access token is short-lived (15 min) and we are on the LAN. Caddy's
// access log format strips the query string by default for `/ws` lines so
// a token doesn't survive in `/var/log/caddy/access.log` long-term.
// (See backend/Caddyfile Phase 10 changes.)
const extractToken = (req: Request): string | null => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  return token && token.length > 0 ? token : null;
};

// Authenticates the upgrade request and returns the userId, or `null` if
// the request should be rejected. Exported for testability — the upgrade
// handler stitches this together with `server.upgrade(req, { data })`,
// which can't be invoked outside a real Bun.serve, but the auth slice can
// be unit-tested in isolation.
export const authenticateWsRequest = async (req: Request): Promise<string | null> => {
  const token = extractToken(req);
  if (!token) {
    return null;
  }
  try {
    const claims = await verifyAccessToken(token);
    return claims.sub;
  } catch {
    return null;
  }
};

// Three outcomes from inspecting a request at the WS layer:
//   - `not_ws`: the URL doesn't match the WS path; caller should fall
//     through to the normal HTTP handler (Hono).
//   - `upgraded`: the WS upgrade succeeded; Bun has already written the
//     101 response and `Bun.serve` expects `undefined` from the fetch
//     handler. We expose this as a typed outcome rather than relying on
//     the same `undefined` return to mean two different things.
//   - `response`: we synthesised an HTTP response (401, 400) that the
//     caller should return verbatim.
//
// Discriminating on a `kind` field is more verbose than just returning
// `Response | undefined`, but it sidesteps the "two flavors of undefined
// look identical to the caller" trap that caused the original bug.
export type WsUpgradeOutcome =
  | { kind: 'not_ws' }
  | { kind: 'upgraded' }
  | { kind: 'response'; response: Response };

// Wires the upgrade. Call this from the top-level `Bun.serve` fetch handler.
// Returns one of three outcomes (see `WsUpgradeOutcome`) so the caller can
// route correctly without re-parsing the URL.
export const upgradeWsRequest = async (
  req: Request,
  server: Server<SocketData>,
  opts: { path?: string } = {},
): Promise<WsUpgradeOutcome> => {
  const url = new URL(req.url);
  const path = opts.path ?? '/ws';
  if (url.pathname !== path) return { kind: 'not_ws' };

  const userId = await authenticateWsRequest(req);
  if (!userId) {
    // 401 on a WebSocket upgrade is the documented way to reject — clients
    // see this as an HTTP 401 response (their WebSocket never opens),
    // which is exactly what we want.
    return { kind: 'response', response: new Response('unauthenticated', { status: 401 }) };
  }

  // `crypto.randomUUID()` here is intentional (a v4) rather than UUIDv7:
  // this id only ever appears in log lines, never in the wire protocol or
  // database, so monotonic ordering doesn't matter.
  const connectionId = crypto.randomUUID();
  const data: SocketData = { userId, connectionId, subscriptions: new Set() };

  const upgraded = server.upgrade(req, { data });
  if (!upgraded) {
    // server.upgrade returning false means the request wasn't actually a
    // WebSocket upgrade (missing/invalid Upgrade header). Treat as 400 —
    // someone called GET /ws with regular HTTP.
    return {
      kind: 'response',
      response: new Response('not a websocket upgrade', { status: 400 }),
    };
  }
  // 101 Switching Protocols has been sent by Bun. Caller should return
  // undefined from the fetch handler.
  return { kind: 'upgraded' };
};

// Message dispatcher. Called for every text/binary frame from a client.
// Exported separately from `buildWsHandlers` so the parse-and-dispatch
// logic can be tested without standing up a real socket.
export const handleClientMessage = async (
  db: Database,
  ws: ServerWebSocket<SocketData>,
  raw: string | Buffer | Uint8Array,
): Promise<void> => {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendMessage(ws, {
      type: 'error',
      code: 'invalid_message',
      message: 'message is not valid JSON',
    });
    return;
  }

  const result = ClientMessage.safeParse(parsed);
  if (!result.success) {
    sendMessage(ws, {
      type: 'error',
      code: 'invalid_message',
      message: 'message did not match a known shape',
    });
    return;
  }

  const msg = result.data;
  switch (msg.type) {
    case 'subscribe': {
      // Membership check is the actual auth boundary for events — the
      // upgrade only proves "you're a real user," not "you're entitled to
      // this list's events." A user who has been removed from a list
      // (soft-deleted member row) MUST get rejected here, even if their
      // access token is still valid.
      const member = await activeMembership(db, msg.listId, ws.data.userId);
      if (!member) {
        sendMessage(ws, {
          type: 'error',
          code: 'not_a_member',
          message: 'you are not a member of this list',
        });
        return;
      }
      const topic = listTopic(msg.listId);
      ws.subscribe(topic);
      ws.data.subscriptions.add(topic);
      sendMessage(ws, { type: 'ack', inReplyTo: 'subscribe', listId: msg.listId });
      return;
    }
    case 'unsubscribe': {
      // No membership re-check — a stale subscription should be cleanable
      // even after the user was removed. Otherwise a revoked user would
      // be stuck holding a topic they can never drop, and the only way to
      // clean it would be a server-side disconnect.
      const topic = listTopic(msg.listId);
      ws.unsubscribe(topic);
      ws.data.subscriptions.delete(topic);
      sendMessage(ws, { type: 'ack', inReplyTo: 'unsubscribe', listId: msg.listId });
      return;
    }
    case 'ping': {
      sendMessage(ws, { type: 'pong' });
      return;
    }
  }
};

// Single send helper so we never accidentally `ws.send(obj)` (which would
// stringify with `[object Object]` and silently break). Centralising the
// JSON.stringify also gives us one place to log outbound traffic for
// debugging if we ever need to.
const sendMessage = (ws: ServerWebSocket<SocketData>, msg: ServerMessageT): void => {
  ws.send(JSON.stringify(msg));
};

// Returns the WebSocket handler object Bun.serve expects. Closure-captures
// `db` so the per-message handler can do the membership lookup without
// requiring callers to pass it in. We pass `db` here rather than at module
// level because the test setup uses a Testcontainers-backed `db` and the
// production code uses the dev one.
export const buildWsHandlers = (db: Database) => ({
  // Strongly type ws.data via the `data` field — required because
  // Bun.serve<T> generics were removed (see Bun docs).
  data: {} as SocketData,
  open(ws: ServerWebSocket<SocketData>): void {
    logger.info(
      { connectionId: ws.data.connectionId, userId: ws.data.userId },
      'ws connection opened',
    );
  },
  async message(ws: ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
    try {
      await handleClientMessage(db, ws, raw);
    } catch (err) {
      // The message handler isn't a Hono route, so the global onError
      // middleware doesn't see it. Catch + log here to prevent a single
      // bad message from crashing the WS layer for everyone.
      logger.error(
        { err, connectionId: ws.data.connectionId, userId: ws.data.userId },
        'ws message handler error',
      );
      sendMessage(ws, {
        type: 'error',
        code: 'invalid_message',
        message: 'internal error processing message',
      });
    }
  },
  close(ws: ServerWebSocket<SocketData>, code: number, reason: string): void {
    logger.info(
      {
        connectionId: ws.data.connectionId,
        userId: ws.data.userId,
        code,
        reason,
        subscriptions: ws.data.subscriptions.size,
      },
      'ws connection closed',
    );
    // No explicit cleanup needed — Bun drops the socket's subscriptions
    // from its topic indices automatically on close. Our parallel Set is
    // garbage-collected with the closure.
  },
  // 60s idle timeout. Bun default is 120s; we shorten because the iOS
  // BGAppRefreshTask-less constraint (PLAN.md "out of scope") means
  // background sockets will get killed by the OS quickly anyway. 60s gives
  // a foregrounded app a clear "i should reconnect" signal without
  // generating churn for actively-used sockets.
  idleTimeout: 60,
  // Bun sends WebSocket-protocol-level ping frames automatically with
  // `sendPings: true` (the default). Application-layer ping/pong from
  // messages.ts is layered on top for the heartbeat that clients act on.
});
