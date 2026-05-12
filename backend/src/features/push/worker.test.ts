import { describe, expect, test } from 'bun:test';
import type { ApnsClient } from './apns.ts';
import type { FcmClient } from './fcm.ts';
import type { PushJob, PushResult } from './types.ts';
import { makePushHandler } from './worker.ts';

// Tests for makePushHandler. The handler is the bridge between the
// queue (pg-boss) and the senders (APNs/FCM). Its contract is the
// PushResult-to-queue-action mapping:
//   ok           -> return normally
//   retry        -> throw (pg-boss retries with backoff)
//   unregistered -> return normally + call onUnregistered
//   invalid      -> return normally + log (no retry, no cleanup)

const iosJob: PushJob = {
  token: 'apns-tok',
  platform: 'ios',
  title: 'T',
  body: 'B',
};

const androidJob: PushJob = {
  token: 'fcm-tok',
  platform: 'android',
  title: 'T',
  body: 'B',
};

// Test client doubles. Each accepts a `respond` callback that decides
// what to return for each invocation, plus a `recordedJobs` log.
const stubApns = (
  respond: (job: PushJob) => PushResult,
): ApnsClient & {
  recordedJobs: PushJob[];
} => {
  const recordedJobs: PushJob[] = [];
  return {
    recordedJobs,
    async send(j) {
      recordedJobs.push(j);
      return respond(j);
    },
  };
};

const stubFcm = (
  respond: (job: PushJob) => PushResult,
): FcmClient & {
  recordedJobs: PushJob[];
} => {
  const recordedJobs: PushJob[] = [];
  return {
    recordedJobs,
    async send(j) {
      recordedJobs.push(j);
      return respond(j);
    },
  };
};

describe('makePushHandler', () => {
  test('iOS job goes to APNs and not FCM', async () => {
    const apns = stubApns(() => ({ kind: 'ok' }));
    const fcm = stubFcm(() => ({ kind: 'ok' }));
    const handler = makePushHandler({ apns, fcm });
    await handler(iosJob);
    expect(apns.recordedJobs).toEqual([iosJob]);
    expect(fcm.recordedJobs).toEqual([]);
  });

  test('Android job goes to FCM and not APNs', async () => {
    const apns = stubApns(() => ({ kind: 'ok' }));
    const fcm = stubFcm(() => ({ kind: 'ok' }));
    const handler = makePushHandler({ apns, fcm });
    await handler(androidJob);
    expect(fcm.recordedJobs).toEqual([androidJob]);
    expect(apns.recordedJobs).toEqual([]);
  });

  test('ok result returns normally (no throw)', async () => {
    const handler = makePushHandler({
      apns: stubApns(() => ({ kind: 'ok' })),
      fcm: stubFcm(() => ({ kind: 'ok' })),
    });
    await expect(handler(iosJob)).resolves.toBeUndefined();
  });

  test('retry result throws (so pg-boss retries)', async () => {
    const handler = makePushHandler({
      apns: stubApns(() => ({ kind: 'retry', reason: 'ServiceUnavailable' })),
      fcm: stubFcm(() => ({ kind: 'ok' })),
    });
    await expect(handler(iosJob)).rejects.toThrow(/push retry: ServiceUnavailable/);
  });

  test('unregistered calls onUnregistered hook and does NOT throw', async () => {
    // The handler must NOT throw on unregistered — pg-boss should mark
    // the job complete (we've done what we can; throwing would burn
    // five retries on a dead token).
    const cleaned: PushJob[] = [];
    const handler = makePushHandler({
      apns: stubApns(() => ({ kind: 'unregistered' })),
      fcm: stubFcm(() => ({ kind: 'ok' })),
      onUnregistered: (j) => {
        cleaned.push(j);
      },
    });
    await handler(iosJob);
    expect(cleaned).toEqual([iosJob]);
  });

  test('unregistered without onUnregistered hook is still a no-op', async () => {
    // The hook is optional. Phase 10 doesn't wire cleanup; Phase 16 will.
    const handler = makePushHandler({
      apns: stubApns(() => ({ kind: 'unregistered' })),
      fcm: stubFcm(() => ({ kind: 'ok' })),
    });
    await expect(handler(iosJob)).resolves.toBeUndefined();
  });

  test('invalid result logs and does NOT throw (no retry)', async () => {
    // BadTopic, INVALID_ARGUMENT, etc — retrying won't help. The handler
    // returns normally so pg-boss marks the job done; if the operator
    // wants to know, the error log will tell them.
    const handler = makePushHandler({
      apns: stubApns(() => ({ kind: 'invalid', reason: 'BadTopic' })),
      fcm: stubFcm(() => ({ kind: 'ok' })),
    });
    await expect(handler(iosJob)).resolves.toBeUndefined();
  });

  test('transport throw propagates so pg-boss retries', async () => {
    // Network failure mid-send (DNS, timeout) should be a retry. The
    // sender throws; the handler re-throws. pg-boss applies backoff.
    const apns: ApnsClient = {
      async send() {
        throw new Error('ECONNREFUSED');
      },
    };
    const handler = makePushHandler({
      apns,
      fcm: stubFcm(() => ({ kind: 'ok' })),
    });
    await expect(handler(iosJob)).rejects.toThrow(/ECONNREFUSED/);
  });
});
