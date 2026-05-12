import type { Server } from 'bun';
import type { EventPayloadT } from './messages.ts';
import { listTopic } from './topics.ts';
import type { SocketData } from './ws.ts';

// Event publisher abstraction.
//
// Mutation endpoints (lists/items/members) call `publisher.publish(event)`
// after a successful write. The publisher's job is to fan that event out to
// every WebSocket subscribed to the relevant topic. In production this rides
// Bun's native pub/sub via `server.publish()`; in tests we substitute an
// `InMemoryEventPublisher` that just records what got published, so route
// tests can assert on the wire shape without standing up a real server.
//
// Why a seam at all? Without one, the lists/items HTTP integration tests
// would need to call `Bun.serve()` and open a real WS client, which is a
// lot of moving parts to test "the route published an event after the
// write succeeded." Routing those tests through an in-memory recorder lets
// us pin the contract — "this mutation produces this event with this id
// and this listId" — in pure unit-style tests. The Bun publisher is then
// exercised by a dedicated WS integration test where the full round-trip
// matters.
//
// Failure behaviour: publishing is best-effort. A failed publish (no
// subscribers, transport error, JSON encoding bug) must NOT roll back the
// write — the write is already committed and durable in Postgres, and the
// client will catch up via the `?since=` reconciliation pull on next
// connect. Logging the failure is enough.

export type EventPublisher = {
  /** Fan an event out to every subscriber of its `listId` topic. Fire and
   * forget — never throws (errors are logged internally). */
  publish: (event: EventPayloadT) => void;
};

// Production implementation. Wraps a `Bun.Server` reference and delegates
// to its native `publish()`. Bun's pub/sub is implemented in C++ via
// uWebSockets and handles the fan-out without a per-subscriber for-loop in
// JS, which is the whole reason we picked Bun-native over a JS-level
// `Map<topic, Set<ws>>` we maintain ourselves.
//
// Construction is two-phase because `Bun.serve()` returns the server
// instance, but the routes that will publish to it are passed to
// `Bun.serve()` via `fetch: app.fetch`. We bind the server *after* serve
// returns; until then the publisher silently no-ops (which is correct
// behaviour during boot — there are no subscribers yet either).
export class BunEventPublisher implements EventPublisher {
  // Deliberately mutable: this field is rebound exactly once, immediately
  // after `Bun.serve()` returns the live server instance (see index.ts).
  // Bun's API forces this two-phase shape — the server doesn't exist yet
  // at the point the publisher is constructed, but the publisher must
  // exist by then so the app can be wired with it.
  private server: Server<SocketData> | null = null;

  bind(server: Server<SocketData>): void {
    this.server = server;
  }

  publish(event: EventPayloadT): void {
    if (!this.server) {
      // No server bound yet — boot ordering let a write race the bind.
      // In practice this can't happen at runtime (Bun.serve returns
      // before any HTTP handler is invoked), but the type allows it so
      // we handle it defensively.
      return;
    }
    const topic = listTopic(event.listId);
    const message = JSON.stringify({ type: 'event', payload: event });
    // server.publish returns the number of bytes sent across all
    // subscribers, or 0 if none. We don't act on the return value — a
    // mutation that nobody subscribed to is the steady state, not a bug.
    this.server.publish(topic, message);
  }
}

// Test implementation. Records every publish in insertion order so tests
// can assert "the route emitted exactly these events in this order."
//
// `published` is intentionally a plain readonly array, not a queue or
// observable — tests inspect it after acting on the route, so a snapshot
// is enough. If we ever need observable semantics, swap to an EventEmitter
// without touching call sites.
export class InMemoryEventPublisher implements EventPublisher {
  readonly published: EventPayloadT[] = [];

  publish(event: EventPayloadT): void {
    this.published.push(event);
  }

  reset(): void {
    this.published.length = 0;
  }
}
