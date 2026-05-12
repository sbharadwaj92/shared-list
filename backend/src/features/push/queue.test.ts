import { describe, expect, test } from 'bun:test';
import { InMemoryPushQueue } from './queue.ts';
import type { PushJob } from './types.ts';

// Tests for the InMemoryPushQueue test double. The pg-boss-backed
// implementation is tested implicitly by the integration test in
// service.test.ts via env-gated live Postgres connection — not here,
// because spinning a fresh pg-boss schema per test would be slow.
//
// The in-memory queue's contract is:
//   - send(job) → runs handler if registered; queues otherwise
//   - work(handler) → drains any pending jobs through handler immediately
//   - reset() → clears all state

const sampleJob: PushJob = {
  token: 'token-xyz',
  platform: 'ios',
  title: 'Hi',
  body: 'there',
};

describe('InMemoryPushQueue', () => {
  test('processes a job immediately when handler is registered first', async () => {
    const q = new InMemoryPushQueue();
    const seen: PushJob[] = [];
    await q.work(async (j) => {
      seen.push(j);
    });
    await q.send(sampleJob);
    expect(seen).toEqual([sampleJob]);
    expect(q.sent).toEqual([sampleJob]);
    expect(q.processed).toEqual([sampleJob]);
  });

  test('drains a queued job when handler registers later', async () => {
    // This mirrors a real race condition in production: a request can
    // enqueue a push before the worker process has fully come up.
    // pg-boss would buffer the job in Postgres; the in-memory queue
    // buffers in `pending`.
    const q = new InMemoryPushQueue();
    await q.send(sampleJob);
    expect(q.sent).toEqual([sampleJob]);
    expect(q.processed).toEqual([]); // not processed yet

    const seen: PushJob[] = [];
    await q.work(async (j) => {
      seen.push(j);
    });

    expect(seen).toEqual([sampleJob]);
    expect(q.processed).toEqual([sampleJob]);
  });

  test('reset clears all state', async () => {
    const q = new InMemoryPushQueue();
    await q.work(async () => {});
    await q.send(sampleJob);
    q.reset();
    expect(q.sent).toEqual([]);
    expect(q.processed).toEqual([]);
    // After reset, a new send WITHOUT a handler must buffer (verifying
    // the handler reference itself was cleared).
    await q.send(sampleJob);
    expect(q.processed).toEqual([]);
  });

  test('handler errors propagate from send (test-friendly)', async () => {
    // In production pg-boss would catch and retry; in tests we want the
    // assertion to surface immediately so we know which call broke.
    const q = new InMemoryPushQueue();
    await q.work(async () => {
      throw new Error('boom');
    });
    await expect(q.send(sampleJob)).rejects.toThrow(/boom/);
  });

  test('send returns a string id that increments', async () => {
    const q = new InMemoryPushQueue();
    await q.work(async () => {});
    const a = await q.send(sampleJob);
    const b = await q.send(sampleJob);
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
    expect(a).not.toBe(b);
  });
});
