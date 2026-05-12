import { logger } from '../../infra/logger.ts';
import type { ApnsClient } from './apns.ts';
import type { FcmClient } from './fcm.ts';
import type { PushHandler } from './queue.ts';
import type { PushJob, PushResult } from './types.ts';

// Worker callback factory.
//
// The handler decides which platform sender a job goes to, hands it
// off, and translates the PushResult into a queue-level action:
//
//   - `ok`            → return normally; pg-boss marks the job complete.
//   - `retry`         → throw; pg-boss applies retry-with-backoff.
//   - `unregistered`  → return normally (job done) AND emit a hook so
//                       the calling layer can clean up the device_token
//                       row (Phase 16 wires the cleanup).
//   - `invalid`       → log + return normally; retrying won't fix
//                       config errors, and a dead-letter queue is more
//                       Phase 18 territory than Phase 10.
//
// We intentionally don't surface PushResult to the queue's success path
// — pg-boss only knows "complete" vs "throw → retry," and abusing the
// throw path to signal "permanently dead token" would cause five
// pointless retries before we got around to giving up.

export type OnUnregistered = (job: PushJob) => Promise<void> | void;

export const makePushHandler = (deps: {
  apns: ApnsClient;
  fcm: FcmClient;
  onUnregistered?: OnUnregistered;
}): PushHandler => {
  return async (job: PushJob): Promise<void> => {
    let result: PushResult;
    try {
      if (job.platform === 'ios') {
        result = await deps.apns.send(job);
      } else {
        result = await deps.fcm.send(job);
      }
    } catch (err) {
      // Transport-level throw (network down, fetch threw) is the
      // textbook "retry" case — we don't know whether the request
      // reached APNs/FCM at all.
      logger.warn({ err, platform: job.platform }, 'push send threw, retrying');
      throw err;
    }

    switch (result.kind) {
      case 'ok':
        logger.debug({ platform: job.platform }, 'push delivered');
        return;
      case 'retry':
        // Throwing is how we tell pg-boss to retry. The reason string
        // goes on the job's lastError for ops visibility.
        throw new Error(`push retry: ${result.reason}`);
      case 'unregistered':
        logger.info({ platform: job.platform }, 'push token unregistered; signalling cleanup');
        await deps.onUnregistered?.(job);
        return;
      case 'invalid':
        // Don't throw — retrying won't make BadTopic / INVALID_ARGUMENT
        // succeed. Log loudly so the operator notices a config mistake.
        logger.error(
          { platform: job.platform, reason: result.reason },
          'push permanently failed (invalid)',
        );
        return;
    }
  };
};
