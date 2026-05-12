import { describe, expect, test } from 'bun:test';
import { ClientMessage, ServerMessage } from './messages.ts';

// Wire-format tests. These exist to lock the protocol shape — any breaking
// change here is a coordinated cross-platform change (backend + ios +
// android), and the test failure is the first thing that catches it.
//
// We test both happy and unhappy paths because Zod's discriminatedUnion
// has subtle behaviour around extra fields and missing keys: a malformed
// payload should produce `success: false`, not throw, so the handler can
// return a structured error to the client instead of a stack trace.

describe('ClientMessage parse', () => {
  test('subscribe with valid uuid parses', () => {
    const result = ClientMessage.safeParse({
      type: 'subscribe',
      listId: '019470fd-d301-7000-8000-000000000001',
    });
    expect(result.success).toBe(true);
  });

  test('unsubscribe with valid uuid parses', () => {
    const result = ClientMessage.safeParse({
      type: 'unsubscribe',
      listId: '019470fd-d301-7000-8000-000000000001',
    });
    expect(result.success).toBe(true);
  });

  test('ping parses with no fields', () => {
    const result = ClientMessage.safeParse({ type: 'ping' });
    expect(result.success).toBe(true);
  });

  test('subscribe with non-uuid listId rejects', () => {
    const result = ClientMessage.safeParse({
      type: 'subscribe',
      listId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  test('unknown type rejects', () => {
    const result = ClientMessage.safeParse({
      type: 'flood-the-server',
      listId: '019470fd-d301-7000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  test('missing type rejects', () => {
    const result = ClientMessage.safeParse({
      listId: '019470fd-d301-7000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  test('subscribe without listId rejects', () => {
    // A `subscribe` with no `listId` is a no-op at best and a programming
    // error at worst — reject loudly rather than silently subscribing to
    // some undefined topic.
    const result = ClientMessage.safeParse({ type: 'subscribe' });
    expect(result.success).toBe(false);
  });
});

describe('ServerMessage parse', () => {
  // We parse server→client messages on the client side; the backend never
  // calls ServerMessage.parse on its own output (it produces them). But
  // pinning the shape here ensures the schema stays accurate when both
  // platform clients try to validate against it.
  test('event message parses', () => {
    const result = ServerMessage.safeParse({
      type: 'event',
      payload: {
        entity: 'list',
        action: 'created',
        id: '019470fd-d301-7000-8000-000000000001',
        listId: '019470fd-d301-7000-8000-000000000001',
        at: '2026-05-12T10:00:00.000+00:00',
      },
    });
    expect(result.success).toBe(true);
  });

  test('ack message parses', () => {
    const result = ServerMessage.safeParse({
      type: 'ack',
      inReplyTo: 'subscribe',
      listId: '019470fd-d301-7000-8000-000000000001',
    });
    expect(result.success).toBe(true);
  });

  test('pong message parses', () => {
    const result = ServerMessage.safeParse({ type: 'pong' });
    expect(result.success).toBe(true);
  });

  test('error message parses', () => {
    const result = ServerMessage.safeParse({
      type: 'error',
      code: 'not_a_member',
      message: 'you are not a member of this list',
    });
    expect(result.success).toBe(true);
  });

  test('event with unknown entity rejects', () => {
    const result = ServerMessage.safeParse({
      type: 'event',
      payload: {
        entity: 'invented_entity',
        action: 'created',
        id: '019470fd-d301-7000-8000-000000000001',
        listId: '019470fd-d301-7000-8000-000000000001',
        at: '2026-05-12T10:00:00.000+00:00',
      },
    });
    expect(result.success).toBe(false);
  });

  test('event without offset in `at` rejects', () => {
    // The protocol mandates a timezone offset on `at` — clients on three
    // platforms must agree on how to parse it, and "no offset" is the most
    // common ambiguity source.
    const result = ServerMessage.safeParse({
      type: 'event',
      payload: {
        entity: 'list',
        action: 'created',
        id: '019470fd-d301-7000-8000-000000000001',
        listId: '019470fd-d301-7000-8000-000000000001',
        at: '2026-05-12T10:00:00.000',
      },
    });
    expect(result.success).toBe(false);
  });
});
