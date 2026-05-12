import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../app.ts';
import { listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { ServerMessage, type ServerMessageT } from './messages.ts';
import { BunEventPublisher } from './publisher.ts';
import { listTopic } from './topics.ts';
import { type SocketData, buildWsHandlers, upgradeWsRequest } from './ws.ts';

// Real end-to-end WebSocket tests. Unlike `ws.test.ts` (which uses a fake
// socket), these boot a real `Bun.serve` on a random port, open a real
// `WebSocket` client, and verify the full round-trip:
//
//   - HTTP 101 Switching Protocols on a valid token
//   - HTTP 401 on a missing or invalid token
//   - message round-trip: client sends, server processes, client receives
//   - server.publish() routes correctly to subscribed sockets
//   - non-subscriber does NOT receive events for other lists
//
// The cost of doing this for every dispatcher test would be a 5x test-time
// increase (each test waits on socket connect + close). We keep the
// dispatcher tests pure and run a small set of round-trip scenarios here
// to verify the WS layer wires up to the rest of the system.

// Port 0 = let the OS pick an unused port. The server.port is read back
// from the returned `Server` so the WS URL can be built without races on
// "is anything else bound to 3001 today?".
const startTestServer = async (t: TestDatabase) => {
  const publisher = new BunEventPublisher();
  const app = buildApp(t.db, { eventPublisher: publisher });
  const wsHandlers = buildWsHandlers(t.db);

  const server: Server<SocketData> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const outcome = await upgradeWsRequest(req, srv);
      switch (outcome.kind) {
        case 'upgraded':
          return undefined as unknown as Response;
        case 'response':
          return outcome.response;
        case 'not_ws':
          return app.fetch(req);
      }
    },
    websocket: wsHandlers,
  });
  publisher.bind(server);

  const baseUrl = `ws://127.0.0.1:${server.port}/ws`;
  return { server, publisher, baseUrl };
};

// Promisified "wait for the next message on this socket." The native
// WebSocket API is event-driven (onmessage callback); we wrap it so each
// test step reads as a sequential assertion. Bun's WebSocket honours
// addEventListener + close.
const nextMessage = (ws: WebSocket, timeoutMs = 1000): Promise<ServerMessageT> => {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      ws.removeEventListener('message', onMessage);
      clearTimeout(timer);
      try {
        const raw = typeof event.data === 'string' ? event.data : '';
        resolve(ServerMessage.parse(JSON.parse(raw)));
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('timed out waiting for next ws message'));
    }, timeoutMs);
    ws.addEventListener('message', onMessage);
  });
};

const connectWs = (baseUrl: string, token: string): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('ws connect timed out')), 1500);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
      { once: true },
    );
  });
};

// Close a socket and wait for the underlying TCP teardown. Without this,
// fast-running tests sometimes leak open sockets that cause "address in
// use" errors on the next iteration.
const closeWs = (ws: WebSocket): Promise<void> => {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.close();
  });
};

describe('ws integration (real Bun.serve + real WebSocket client)', () => {
  let t: TestDatabase;
  let userId: string;
  let listId: string;
  let server: Server<SocketData>;
  let publisher: BunEventPublisher;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    t = await setupTestDatabase();
    const started = await startTestServer(t);
    server = started.server;
    publisher = started.publisher;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    server.stop();
    await t.teardown();
  });

  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
    userId = '019470fd-d301-7000-8000-000000000001';
    listId = '019470fd-d301-7000-8000-000000000002';
    await t.db.insert(users).values({
      id: userId,
      email: 'alice@example.com',
      passwordHash: 'unused',
      displayName: 'Alice',
    });
    await t.db.insert(lists).values({
      id: listId,
      name: 'Test list',
      createdBy: userId,
    });
    await t.db.insert(listMembers).values({
      listId,
      userId,
      role: 'owner',
    });
    token = await signAccessToken(userId);
  });

  test('connect with a valid token + subscribe + receive published event', async () => {
    const ws = await connectWs(baseUrl, token);

    ws.send(JSON.stringify({ type: 'subscribe', listId }));
    const ack = await nextMessage(ws);
    expect(ack.type).toBe('ack');

    // Trigger an event via the publisher (this is the same code path
    // mutation routes use). The subscribed socket should receive it.
    publisher.publish({
      entity: 'item',
      action: 'created',
      id: '019470fd-d301-7000-8000-000000000099',
      listId,
      at: new Date().toISOString(),
    });

    const evt = await nextMessage(ws);
    expect(evt.type).toBe('event');
    if (evt.type === 'event') {
      expect(evt.payload.entity).toBe('item');
      expect(evt.payload.action).toBe('created');
      expect(evt.payload.listId).toBe(listId);
    }

    await closeWs(ws);
  });

  test('non-subscriber does NOT receive events for other lists', async () => {
    // Membership scoping: an authenticated user who hasn't subscribed to
    // a particular list must not see events for it, even if they have
    // membership. Subscription is the explicit opt-in.
    const ws = await connectWs(baseUrl, token);

    publisher.publish({
      entity: 'item',
      action: 'created',
      id: '019470fd-d301-7000-8000-000000000099',
      listId,
      at: new Date().toISOString(),
    });

    // We expect no message to arrive — a timeout on `nextMessage` proves
    // the negative. 250ms is enough for any synchronous delivery race; on
    // a properly working pub/sub there's never a delivery for an
    // unsubscribed socket.
    await expect(nextMessage(ws, 250)).rejects.toThrow(/timed out/);

    await closeWs(ws);
  });

  test('upgrade with no token returns 401', async () => {
    // We can't use the WebSocket API for this — it doesn't surface the
    // HTTP status to JS. Hit the WS path with a plain fetch + Upgrade
    // header and check the synthesised 401.
    const res = await fetch(`http://127.0.0.1:${server.port}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
    });
    expect(res.status).toBe(401);
  });

  test('upgrade with an invalid token returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/ws?token=garbage`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
    });
    expect(res.status).toBe(401);
  });

  test('subscribe to a list the user is not a member of returns error', async () => {
    // Different list, no membership for this user.
    const otherListId = '019470fd-d301-7000-8000-000000000050';
    await t.db.insert(lists).values({
      id: otherListId,
      name: 'Not yours',
      createdBy: userId,
    });
    // Note: we deliberately did NOT insert a member row for `otherListId`.
    // PLAN.md models even the creator as a member, so without that row,
    // the user is not a member of `otherListId`.

    const ws = await connectWs(baseUrl, token);
    ws.send(JSON.stringify({ type: 'subscribe', listId: otherListId }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('not_a_member');
    }

    await closeWs(ws);
  });

  test('publishing to a topic with no subscribers is a no-op (does not throw)', async () => {
    // Sanity: the BunEventPublisher must not blow up when no one is
    // listening. This is the steady state when nobody has subscribed yet.
    expect(() => {
      publisher.publish({
        entity: 'list',
        action: 'created',
        id: listId,
        listId,
        at: new Date().toISOString(),
      });
    }).not.toThrow();
    // And the topic should reflect the no-subscribers state.
    expect(listTopic(listId)).toBe(`list:${listId}`);
  });
});
