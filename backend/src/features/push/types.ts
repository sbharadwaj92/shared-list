import { z } from 'zod';

// Push job payload — the contract between the producer (mutation routes
// in Phase 16, or the test endpoint here) and the worker that dispatches
// to APNs/FCM.
//
// Kept deliberately minimal: title + body + a data map. We're not trying
// to model every APNs/FCM feature (sound, badge, actions); v1 is "render
// a basic notification when the app is backgrounded." Anything richer
// belongs to Phase 16+ when we know what the UX needs.
//
// The data map is a string→string dict so it round-trips through both
// platforms unchanged (APNs accepts arbitrary user-info JSON, but FCM's
// HTTP v1 `data` field is strictly Record<string,string>). Picking the
// stricter contract here means we don't accidentally ship something that
// works on iOS but blows up on Android.

export const PushJobSchema = z.object({
  // Token-tier addressing: a job targets ONE physical device. The
  // fan-out logic (one mutation → multiple member devices) lives at the
  // enqueue site, not in the job itself. Per-device jobs let us retry,
  // mark dead, and observe individual deliveries without a coupling
  // between "user has 3 devices" and "did all 3 succeed."
  token: z.string().min(1).max(4096),
  platform: z.enum(['ios', 'android']),

  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),

  // Optional per-message data. Strict string-string dict for cross-
  // platform parity (see file header).
  data: z.record(z.string(), z.string()).optional(),
});

export type PushJob = z.infer<typeof PushJobSchema>;

// Outcome reported back by the platform sender. We don't expose
// underlying HTTP errors to callers — instead a discriminated result
// makes the queue's retry/dead-letter decisions explicit.
//
//   `ok`            : delivery accepted by the platform. The device may
//                     or may not render the alert (DND, battery saver),
//                     but APNs/FCM took responsibility.
//   `retry`         : transient failure (network, 5xx, rate limit). The
//                     queue should retry with backoff.
//   `unregistered`  : the platform says this token is dead (uninstalled
//                     app, expired). The queue should mark the
//                     device_token row for deletion (Phase 16 wires this).
//   `invalid`       : permanent failure that's not unregistered (bad
//                     credentials, bad payload). Worker logs and drops.
export type PushResult =
  | { kind: 'ok' }
  | { kind: 'retry'; reason: string }
  | { kind: 'unregistered' }
  | { kind: 'invalid'; reason: string };

// Transport seam: the senders accept a `fetch` impl so tests can stub
// without touching globals. Default is `globalThis.fetch` (Bun-native).
export type FetchLike = typeof fetch;
