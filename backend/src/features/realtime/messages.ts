import { z } from 'zod';

// Wire-format messages exchanged over the WebSocket.
//
// The protocol is intentionally tiny: three client-to-server message types
// (`subscribe`, `unsubscribe`, `ping`) and three server-to-client message
// types (`event`, `ack`, `error`). Anything more elaborate (binary frames,
// custom subprotocols, framed compression) is deferred — clients are
// implementing this from scratch in two separate codebases, so the smaller
// the surface the easier it is to reach parity.
//
// Why JSON-over-text rather than MessagePack or a binary frame format:
//   - Both client implementations (URLSessionWebSocketTask + Ktor) speak
//     text frames natively without an extra codec dependency.
//   - We can debug live with `wscat -c 'wss://…/ws?token=…'` and read the
//     traffic with our eyes, which is invaluable for a learning project.
//   - The throughput hit vs binary is negligible at our scale (≤ a few
//     events per second per user, single LAN).
//
// `type` is the discriminator on every message. `discriminatedUnion`
// requires it to be a literal at parse time, which makes the resulting
// TypeScript type safely exhaustive in switch statements. Forgetting a
// branch in the handler produces a compile error rather than a runtime drop.

// ----- Client → server -----

// `subscribe`: the client asks to receive future events for a given list.
// `unsubscribe`: the inverse. Both are idempotent — re-subscribing to a topic
// you already hold is a no-op on the server (Bun's pub/sub deduplicates by
// topic string), and unsubscribing from a topic you don't hold is silently
// allowed (consistent with `Set.prototype.delete` semantics).
//
// We don't gate `unsubscribe` on membership: a user who has been removed
// from a list might be holding a stale subscription, and refusing to drop
// it would just delay cleanup. Membership IS checked on `subscribe` so a
// non-member can't passively wiretap a list's events.
//
// `ping` is a client-initiated keepalive. Bun's `sendPings: true` already
// sends WebSocket-protocol ping frames at the transport layer, but those
// are invisible to application code on both clients (URLSessionWebSocketTask
// surfaces them as a connectivity signal, not a callback you can act on).
// An application-layer ping/pong gives the client a definitive
// "the server is alive and processing my messages" signal, which is what
// the heartbeat is for in Phases 11/12.
export const ListIdSchema = z.uuid();

export const SubscribeMessage = z.object({
  type: z.literal('subscribe'),
  listId: ListIdSchema,
});

export const UnsubscribeMessage = z.object({
  type: z.literal('unsubscribe'),
  listId: ListIdSchema,
});

export const PingMessage = z.object({
  type: z.literal('ping'),
});

export const ClientMessage = z.discriminatedUnion('type', [
  SubscribeMessage,
  UnsubscribeMessage,
  PingMessage,
]);

export type ClientMessageT = z.infer<typeof ClientMessage>;

// ----- Server → client -----

// `event`: the meat of the protocol. A mutation happened on a list the
// client is subscribed to. The payload carries enough to identify *what*
// changed but never the *contents* of the changed row — the client must
// pull via `?since=` to learn the new shape. This is the freshness-signal
// pattern from PLAN.md L391: WS events trigger reconciliation, they don't
// replace it. The sync engine remains the only path that mutates local state.
//
// We deliberately don't include the row body in the event:
//   - It would tempt clients to short-circuit reconciliation, then drift
//     when an event drops.
//   - Concurrent edits could deliver out-of-order bodies, and the receiving
//     client would need its own LWW pass; cheaper to defer to the existing
//     sync engine reconciliation than to duplicate the merge logic on WS.
//
// `action` is descriptive only — even on `deleted`, the client still pulls
// via `?since=` and discovers the tombstone there. This keeps the event
// shape uniform: receiving one always means "ask the server for fresh data,"
// nothing more.
export const EventEntity = z.enum(['list', 'item', 'list_member']);
export const EventAction = z.enum(['created', 'updated', 'deleted']);

export const EventPayload = z.object({
  entity: EventEntity,
  action: EventAction,
  // For `entity: 'list'` this is the listId itself. For `entity: 'item'`
  // it's the itemId AND we carry a `listId` (because the client subscribes
  // by list, and the topic-routing already filters to the right listId).
  // For `entity: 'list_member'` it's the userId and `listId` is set.
  id: z.uuid(),
  listId: ListIdSchema,
  // Server-side wall-clock at publish. Clients can use this for logging /
  // freshness display; it is NOT a replacement for `?since=` cursors,
  // which still come from `serverTime` on the read feed.
  at: z.iso.datetime({ offset: true }),
});

export type EventPayloadT = z.infer<typeof EventPayload>;

export const EventMessage = z.object({
  type: z.literal('event'),
  payload: EventPayload,
});

// `ack`: confirms a subscribe/unsubscribe was processed. We don't ack `ping`
// — that gets `pong` (typed below) — and we don't ack `event` (events are
// server-initiated). Acks let the client distinguish "the message was
// received and applied" from "the message was sent but the server hasn't
// gotten to it yet" during reconnect storms.
export const AckMessage = z.object({
  type: z.literal('ack'),
  inReplyTo: z.enum(['subscribe', 'unsubscribe']),
  listId: ListIdSchema,
});

export const PongMessage = z.object({
  type: z.literal('pong'),
});

// `error`: the message couldn't be processed. We use `code` strings (not
// HTTP status codes) because we're not over HTTP at this point — the
// transport is a single long-lived socket, and matching error shapes to
// HTTP statuses just confuses both ends. Codes are documented in
// `backend/docs/sync.md` (Phase 10 section).
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum(['invalid_message', 'not_a_member', 'unauthenticated', 'rate_limited']),
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  EventMessage,
  AckMessage,
  PongMessage,
  ErrorMessage,
]);

export type ServerMessageT = z.infer<typeof ServerMessage>;
