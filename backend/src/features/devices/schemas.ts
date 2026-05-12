import { z } from '@hono/zod-openapi';

// Wire schemas for `POST /devices`.
//
// `id` is client-generated UUID v7 (same convention as lists/items —
// PLAN.md L25). The client picks an id once per (user, device) install
// and reuses it; that gives idempotent registration on the client side
// before we even hit the DB-level ON CONFLICT.
//
// The `token` field is the opaque platform token: 64 hex chars for APNs
// (32 bytes), or ~150+ chars for FCM. Both are platform-defined strings;
// we don't try to validate the inner format here, just bound the length so
// a misbehaving client can't send us a 10MB string and consume RAM.
//
// `platform` is the same `device_platform` enum the DB uses
// (`ios | android`). Mismatched casing or values fail Zod at the boundary.

export const RegisterDeviceBody = z
  .object({
    id: z.uuid().openapi({ description: 'Client-generated UUID v7' }),
    platform: z.enum(['ios', 'android']).openapi({ description: 'Mobile OS this token came from' }),
    // 4096 char ceiling is well above APNs (64) and FCM (~200) sizes; it's a
    // safety bound, not a contract-level validation.
    token: z
      .string()
      .min(1)
      .max(4096)
      .openapi({ description: 'APNs (32 bytes hex) or FCM registration token' }),
  })
  .openapi('RegisterDeviceBody');

// Response shape mirrors the canonical row but in wire ISO datetime form,
// to be consistent with other DTOs in the project.
export const DeviceTokenDTO = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    platform: z.enum(['ios', 'android']),
    token: z.string(),
    lastSeenAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .openapi('DeviceTokenDTO');
