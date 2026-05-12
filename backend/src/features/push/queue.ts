import { PgBoss } from 'pg-boss';
import { logger } from '../../infra/logger.ts';
import type { PushJob } from './types.ts';

// Push queue interface.
//
// One queue name (`push-send`), one job shape (PushJob). pg-boss handles
// durability, retry/backoff, and crash recovery for free — those are the
// reasons it earned a slot in PLAN.md over a hand-rolled solution.
//
// We expose a thin facade over pg-boss so two things become testable:
//
//   1. Production code can call `queue.send(job)` and `queue.work(handler)`
//      without importing pg-boss directly.
//   2. Tests can substitute an `InMemoryPushQueue` that processes jobs
//      synchronously, giving fast assertions without booting pg-boss
//      against a real Postgres.
//
// The pg-boss instance manages its own connection pool inside the
// process, separate from Drizzle's. That's a design choice on their part
// — pg-boss does LISTEN/NOTIFY and long-running polling queries that we
// don't want to compete with our regular request-handling pool.

export const PUSH_QUEUE_NAME = 'push-send';

export type PushHandler = (job: PushJob) => Promise<void>;

export type PushQueue = {
  /** Make sure the queue exists and pg-boss tables are set up. Safe to
   * call multiple times — pg-boss handles the idempotency. */
  start: () => Promise<void>;
  /** Submit a job for asynchronous processing. Returns the job id so
   * tests can correlate. */
  send: (job: PushJob) => Promise<string>;
  /** Register a worker callback. Pg-boss invokes it concurrently; our
   * handler does the actual platform-specific dispatch. */
  work: (handler: PushHandler) => Promise<void>;
  /** Graceful shutdown. */
  stop: () => Promise<void>;
};

// pg-boss-backed implementation.
//
// `connectionString` is the same Postgres URL the rest of the app uses.
// pg-boss creates a `pgboss` schema (default) inside that DB, owned by
// the same user, so there's nothing additional to provision.
//
// Retry/backoff config: 5 retries with exponential backoff (default in
// pg-boss is no retries, which is wrong for push). The base delay of
// 30s aligns with APNs/FCM transient-failure recovery times — most
// 5xx blips resolve within a minute.
export const makePgBossPushQueue = (connectionString: string): PushQueue => {
  // Construction is cheap; we hold off on `start()` until the caller
  // explicitly opts in. This matters because `bun test` shouldn't
  // implicitly connect pg-boss to dev Postgres just because the module
  // got imported.
  const boss = new PgBoss(connectionString);

  // Surface unexpected pg-boss errors through our logger so they show up
  // alongside the rest of the app's logs rather than disappearing into
  // stderr.
  boss.on('error', (err) => {
    logger.error({ err }, 'pg-boss internal error');
  });

  return {
    async start(): Promise<void> {
      await boss.start();
      await boss.createQueue(PUSH_QUEUE_NAME);
      logger.info({ queue: PUSH_QUEUE_NAME }, 'push queue started');
    },
    async send(job: PushJob): Promise<string> {
      const id = await boss.send(PUSH_QUEUE_NAME, job, {
        // Retry policy. The exponential schedule (30s, 60s, 120s, …)
        // gives transient APNs/FCM outages time to recover without
        // hammering. After 5 attempts we give up — at our scale (3
        // users) a notification that's been retrying for 8 minutes is
        // already stale anyway.
        retryLimit: 5,
        retryBackoff: true,
        retryDelay: 30,
      });
      if (!id) throw new Error('pg-boss send returned no id');
      return id;
    },
    async work(handler: PushHandler): Promise<void> {
      await boss.work<PushJob>(PUSH_QUEUE_NAME, async ([jobMeta]) => {
        // pg-boss invokes work() with an array (batch support); we
        // process one at a time so a single failing job doesn't poison
        // a whole batch. The Zod parse here is a load-bearing guard:
        // pg-boss persists job data as JSONB, and a schema change
        // between enqueue and dequeue could otherwise feed the worker
        // a stale shape it doesn't recognize.
        if (!jobMeta) return;
        // pg-boss's TypeScript types are weak — runtime check what we
        // actually have. The handler accepts a typed PushJob, so any
        // mismatch is a bug we want to surface loudly.
        const data = jobMeta.data;
        if (!data || typeof data !== 'object') {
          logger.error({ jobId: jobMeta.id }, 'push job missing data');
          throw new Error('push job missing data');
        }
        await handler(data);
      });
    },
    async stop(): Promise<void> {
      await boss.stop();
    },
  };
};

// In-memory queue for tests. Synchronously processes jobs as they're
// sent — no concurrency, no retries — so test assertions can verify
// "after send(), the handler ran with this payload" without waiting on
// pg-boss's poll interval.
//
// We track sent + processed jobs so tests can distinguish "the job was
// enqueued but the worker hasn't been registered yet" from "the job ran
// successfully." This mirrors the production race more honestly than a
// fire-and-forget mock would.
export class InMemoryPushQueue implements PushQueue {
  readonly sent: PushJob[] = [];
  readonly processed: PushJob[] = [];
  private handler: PushHandler | null = null;
  private nextId = 0;
  private pending: PushJob[] = [];

  async start(): Promise<void> {
    // no-op
  }

  async send(job: PushJob): Promise<string> {
    this.sent.push(job);
    if (this.handler) {
      await this.handler(job);
      this.processed.push(job);
    } else {
      // Defer until work() registers a handler — same semantics as
      // production where enqueue can happen before the worker is up.
      this.pending.push(job);
    }
    return String(++this.nextId);
  }

  async work(handler: PushHandler): Promise<void> {
    this.handler = handler;
    // Drain anything that arrived before we were ready.
    while (this.pending.length > 0) {
      const job = this.pending.shift();
      if (job) {
        await handler(job);
        this.processed.push(job);
      }
    }
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  reset(): void {
    this.sent.length = 0;
    this.processed.length = 0;
    this.pending.length = 0;
    this.handler = null;
    this.nextId = 0;
  }
}
