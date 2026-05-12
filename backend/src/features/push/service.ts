import type { Database } from '../../infra/db.ts';
import { logger } from '../../infra/logger.ts';
import { deviceTokensForUser } from '../devices/repo.ts';
import { makeApnsClient } from './apns.ts';
import { makeFcmClient } from './fcm.ts';
import { type PushQueue, makePgBossPushQueue } from './queue.ts';
import type { PushJob } from './types.ts';
import { makePushHandler } from './worker.ts';

// Public push service. The "module API" for everything outside `push/`.
//
// Two shapes:
//   - `EnabledPushService` — fans an event out to all of a user's device
//     tokens, enqueues per-device jobs through pg-boss, runs a worker
//     that dispatches via APNs/FCM.
//   - `DisabledPushService` — no-op. Used in tests and in dev when
//     PUSH_ENABLED=false. Callers don't have to branch.
//
// The fan-out lives here (not in routes) because every callsite that
// wants to "notify user X about Y" has the same shape: pull the user's
// device tokens, enqueue one job per token, let the queue handle the
// rest. Centralising it means a future improvement (rate-limiting per
// user, deduping bursts, etc.) lands in one place.

export type PushNotification = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export type PushService = {
  /** Send a notification to every active device of a user. Returns the
   * number of jobs enqueued — 0 if the user has no registered devices,
   * or if push is disabled. */
  notifyUser: (userId: string, msg: PushNotification) => Promise<number>;
  /** Start the worker and queue. Idempotent. */
  start: () => Promise<void>;
  /** Stop everything. */
  stop: () => Promise<void>;
};

// Disabled implementation. Used when push isn't configured (most dev
// machines) so the rest of the app doesn't need to defensive-branch.
class DisabledPushService implements PushService {
  async notifyUser(): Promise<number> {
    return 0;
  }
  async start(): Promise<void> {
    logger.info('push service disabled (PUSH_ENABLED=false)');
  }
  async stop(): Promise<void> {
    // no-op
  }
}

export type EnabledPushDeps = {
  db: Database;
  queue: PushQueue;
  apnsConfig: import('./apns.ts').ApnsConfig;
  fcmConfig: import('./fcm.ts').FcmConfig;
};

// Constructor for the enabled path. Wires the queue, the senders, the
// worker callback, and the cleanup hook all together. The hook for
// removing unregistered tokens is left as an optional injection so
// Phase 16 can plug in a repo helper without touching this file.
export const makeEnabledPushService = (deps: EnabledPushDeps): PushService => {
  const apns = makeApnsClient(deps.apnsConfig);
  const fcm = makeFcmClient(deps.fcmConfig);

  const handler = makePushHandler({
    apns,
    fcm,
    // Phase 10 doesn't yet remove unregistered tokens — we just log so
    // an operator running the dev-test endpoint can see the lifecycle.
    // Phase 16 will replace this with a real device-token delete.
    onUnregistered: (job) => {
      logger.info(
        { platform: job.platform, token: `${job.token.slice(0, 8)}…` },
        'push token marked unregistered (cleanup TODO Phase 16)',
      );
    },
  });

  return {
    async notifyUser(userId, msg): Promise<number> {
      const devices = await deviceTokensForUser(deps.db, userId);
      if (devices.length === 0) return 0;
      for (const d of devices) {
        const job: PushJob = {
          token: d.token,
          platform: d.platform,
          title: msg.title,
          body: msg.body,
          data: msg.data,
        };
        await deps.queue.send(job);
      }
      return devices.length;
    },
    async start(): Promise<void> {
      await deps.queue.start();
      await deps.queue.work(handler);
      logger.info('push service started');
    },
    async stop(): Promise<void> {
      await deps.queue.stop();
    },
  };
};

export type BuildPushServiceFromEnv = {
  db: Database;
  enabled: boolean;
  databaseUrl: string;
  apns: import('./apns.ts').ApnsConfig | null;
  fcm: import('./fcm.ts').FcmConfig | null;
};

// Convenience wrapper used by index.ts to construct from the validated
// config. Returns the disabled service when push is off OR when any
// credential is missing (defensive: config validation should have caught
// the latter, but be belt-and-braces).
export const buildPushServiceFromEnv = (env: BuildPushServiceFromEnv): PushService => {
  if (!env.enabled || !env.apns || !env.fcm) {
    return new DisabledPushService();
  }
  return makeEnabledPushService({
    db: env.db,
    queue: makePgBossPushQueue(env.databaseUrl),
    apnsConfig: env.apns,
    fcmConfig: env.fcm,
  });
};
