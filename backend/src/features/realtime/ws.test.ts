import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { sql } from 'drizzle-orm';
import { listMembers, lists, users } from '../../infra/schema.ts';
import { type TestDatabase, setupTestDatabase } from '../../infra/test-db.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { ServerMessage } from './messages.ts';
import { type SocketData, authenticateWsRequest, handleClientMessage } from './ws.ts';

// Unit tests for the WebSocket dispatcher and the auth slice.
//
// We exercise `handleClientMessage` directly with a fake `ServerWebSocket`
// rather than booting `Bun.serve` because every assertion here is about
// "given input X, did we send the right output and subscribe to the right
// topic" — neither of which require a real socket. The end-to-end pipe is
// covered separately in integration.test.ts where we DO boot a real server.
//
// `authenticateWsRequest` is exercised here because it's the slice that
// upgrades 401 → reject without ever entering Bun's upgrade code path.

// A minimal stand-in for ServerWebSocket. We only need the fields and
// methods that handleClientMessage actually touches:
//   - data            : SocketData
//   - subscribe(topic): tracked into `subscribed`
//   - unsubscribe     : tracked into `subscribed`
//   - send(payload)   : tracked into `sent`
// Everything else (`subscriptions` getter, `cork`, etc) goes untouched.
const makeFakeSocket = (
  userId: string,
): {
  ws: ServerWebSocket<SocketData>;
  sent: string[];
  subscribed: Set<string>;
} => {
  const sent: string[] = [];
  const subscribed = new Set<string>();
  const data: SocketData = {
    userId,
    connectionId: 'test-conn-id',
    subscriptions: new Set(),
  };
  const ws = {
    data,
    send: (msg: string | ArrayBuffer | Uint8Array): number => {
      sent.push(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
      return 1;
    },
    subscribe: (topic: string): void => {
      subscribed.add(topic);
    },
    unsubscribe: (topic: string): void => {
      subscribed.delete(topic);
    },
    // Required by the ServerWebSocket type but unused in this code path —
    // we cast through `unknown` to bypass the exhaustiveness check, which
    // is acceptable for a test double.
  } as unknown as ServerWebSocket<SocketData>;
  return { ws, sent, subscribed };
};

// Parse the most recent server message off the fake socket. Asserting on
// raw JSON strings is brittle; asserting on the typed parsed shape is what
// we actually care about.
const lastMessage = (sent: string[]) => {
  const raw = sent[sent.length - 1];
  if (!raw) throw new Error('no message sent');
  return ServerMessage.parse(JSON.parse(raw));
};

describe('handleClientMessage', () => {
  let t: TestDatabase;
  let userId: string;
  let listId: string;

  beforeAll(async () => {
    t = await setupTestDatabase();
  });

  afterAll(async () => {
    await t.teardown();
  });

  // Reset state between tests. We seed one user + one list + an active
  // membership in each `beforeEach` so individual tests can mutate that
  // membership (e.g. delete it to test the not-a-member rejection) without
  // bleeding into the next test.
  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE TABLE users CASCADE`);
    userId = '019470fd-d301-7000-8000-000000000001';
    listId = '019470fd-d301-7000-8000-000000000002';
    await t.db.insert(users).values({
      id: userId,
      email: 'alice@example.com',
      passwordHash: 'unused-in-this-test',
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
  });

  test('subscribe to a list the user is a member of -> subscribes + acks', async () => {
    const { ws, sent, subscribed } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'subscribe', listId }));

    // The dispatcher should have subscribed the socket to the per-list topic
    // AND sent an ack. The ack confirms the subscribe took effect, which is
    // important during reconnect bursts when the client needs to know which
    // subscribes survived the new socket.
    expect(subscribed.has(`list:${listId}`)).toBe(true);
    expect(ws.data.subscriptions.has(`list:${listId}`)).toBe(true);
    const msg = lastMessage(sent);
    expect(msg.type).toBe('ack');
    if (msg.type === 'ack') {
      expect(msg.inReplyTo).toBe('subscribe');
      expect(msg.listId).toBe(listId);
    }
  });

  test('subscribe to a list the user is NOT a member of -> error not_a_member', async () => {
    // The non-member case is the actual auth boundary for events. The JWT
    // upgrade only proves the user is authenticated; per-list scoping is
    // enforced here.
    await t.db.delete(listMembers);
    const { ws, sent, subscribed } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'subscribe', listId }));

    expect(subscribed.size).toBe(0);
    const msg = lastMessage(sent);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('not_a_member');
    }
  });

  test('subscribe to a list with a soft-deleted membership -> error not_a_member', async () => {
    // Revoked membership: the row is still there but deleted_at is set.
    // The query is `activeMembership` which filters deleted_at IS NULL, so
    // this exercise verifies the soft-delete gate works end-to-end.
    await t.db.update(listMembers).set({ deletedAt: sql`now()` });
    const { ws, sent, subscribed } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'subscribe', listId }));

    expect(subscribed.size).toBe(0);
    const msg = lastMessage(sent);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('not_a_member');
    }
  });

  test('unsubscribe -> unsubscribes + acks (no membership check)', async () => {
    // First subscribe...
    const { ws, sent, subscribed } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'subscribe', listId }));
    expect(subscribed.size).toBe(1);

    // ...then revoke membership (simulating "user was kicked while still
    // online")...
    await t.db.delete(listMembers);
    sent.length = 0;

    // ...then unsubscribe. This should succeed even though they're no
    // longer a member — otherwise a revoked user holding a subscription
    // would be stuck with it forever.
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'unsubscribe', listId }));
    expect(subscribed.size).toBe(0);
    expect(ws.data.subscriptions.size).toBe(0);
    const msg = lastMessage(sent);
    expect(msg.type).toBe('ack');
    if (msg.type === 'ack') expect(msg.inReplyTo).toBe('unsubscribe');
  });

  test('ping -> pong', async () => {
    const { ws, sent } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'ping' }));
    const msg = lastMessage(sent);
    expect(msg.type).toBe('pong');
  });

  test('malformed JSON -> error invalid_message', async () => {
    const { ws, sent } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, '{ this is not json');
    const msg = lastMessage(sent);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') expect(msg.code).toBe('invalid_message');
  });

  test('unknown message type -> error invalid_message', async () => {
    const { ws, sent } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'whoami', listId }));
    const msg = lastMessage(sent);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') expect(msg.code).toBe('invalid_message');
  });

  test('subscribe twice to same list -> idempotent (one entry in subscriptions Set)', async () => {
    // Subscribing twice should leave exactly one topic-subscription in
    // place — neither double-counting nor leaving the state inconsistent
    // between Bun's index and our parallel Set.
    const { ws, sent, subscribed } = makeFakeSocket(userId);
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'subscribe', listId }));
    await handleClientMessage(t.db, ws, JSON.stringify({ type: 'subscribe', listId }));
    expect(subscribed.size).toBe(1);
    expect(ws.data.subscriptions.size).toBe(1);
    // Both subscribes get an ack — clients can use them to confirm
    // re-subscription after reconnect (idempotent on the server, but the
    // ack is still a useful liveness signal).
    expect(sent.filter((s) => JSON.parse(s).type === 'ack')).toHaveLength(2);
  });
});

describe('authenticateWsRequest', () => {
  // The upgrade gate. We don't go through Bun.serve here — we just call
  // the helper directly with a fabricated Request and assert the userId
  // we get back.
  test('accepts a request with a valid token in the query string', async () => {
    const userId = '019470fd-d301-7000-8000-000000000010';
    const token = await signAccessToken(userId);
    const req = new Request(`http://localhost/ws?token=${encodeURIComponent(token)}`);
    const result = await authenticateWsRequest(req);
    expect(result).toBe(userId);
  });

  test('rejects a request with no token', async () => {
    const req = new Request('http://localhost/ws');
    const result = await authenticateWsRequest(req);
    expect(result).toBeNull();
  });

  test('rejects a request with an empty token', async () => {
    const req = new Request('http://localhost/ws?token=');
    const result = await authenticateWsRequest(req);
    expect(result).toBeNull();
  });

  test('rejects a request with a garbage token', async () => {
    const req = new Request('http://localhost/ws?token=not-a-jwt');
    const result = await authenticateWsRequest(req);
    expect(result).toBeNull();
  });
});
