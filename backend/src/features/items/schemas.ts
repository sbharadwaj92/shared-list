import { z } from '@hono/zod-openapi';
import { ItemDTO } from '../sync/schemas.ts';

// Zod schemas for the items write endpoints (Phase 7 slice C.1).
// Same rationale as lists/schemas.ts — re-export the canonical DTO so the
// wire shape is identical to the read feed.
export { ItemDTO };

export const ItemIdParam = z
  .object({
    id: z.uuid().openapi({ param: { name: 'id', in: 'path' }, example: '019470fd-…' }),
  })
  .openapi('ItemIdParam');

export const ListIdInItemPath = z
  .object({
    id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
  })
  .openapi('ListIdInItemPath');

// POST /lists/:id/items body. Same client-generated-id rule as lists.
//
// `position` is required on create — the client must pick a slot. We accept
// any 32-bit signed int so callers can use the "midpoint" trick (stick this
// item between two existing items by averaging their positions) without
// special-casing zero or negatives. Concurrent reorders converge by LWW;
// PLAN.md L165 documents the visible-glitch trade-off.
//
// `text` is non-empty trimmed — PATCH below also clamps trim because empty
// items have no rendering UX.
export const CreateItemBody = z
  .object({
    id: z.uuid().openapi({
      description: 'Client-generated UUID v7. Same idempotency story as POST /lists.',
    }),
    text: z.string().trim().min(1, 'text required').max(500, 'text too long'),
    position: z
      .number()
      .int()
      .min(-2_147_483_648)
      .max(2_147_483_647)
      .openapi({ description: 'Display order; smaller values sort first.' }),
  })
  .openapi('CreateItemBody', {
    example: {
      id: '019470fd-7b00-7000-8000-000000000001',
      text: 'milk',
      position: 1000,
    },
  });

// PATCH /items/:id body — every field is optional; the route layer rejects
// the all-empty case below in `.refine`. We use `nullable()` on `checked` so
// the client can clear the timestamp by sending `{"checked": null}` (which
// JSON cannot disambiguate from "field omitted" without explicit nullable
// modelling).
//
// `checked` is wire-typed as ISO8601-or-null (matches the GET feed); the
// route handler parses it to a Date before calling the repo.
export const PatchItemBody = z
  .object({
    text: z.string().trim().min(1, 'text required').max(500, 'text too long').optional(),
    position: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    checked: z
      .string()
      .datetime({ offset: true, message: 'checked must be ISO8601 with timezone or null' })
      .nullable()
      .optional(),
  })
  // At least one field must be set. A fully-empty PATCH body is almost
  // certainly a client bug — failing fast surfaces it immediately rather
  // than letting the route hit the no-op short-circuit in the repo.
  .refine((v) => v.text !== undefined || v.position !== undefined || v.checked !== undefined, {
    message: 'patch body must set at least one of text, position, or checked',
  })
  .openapi('PatchItemBody');

export const ItemConflictResponse = z
  .object({
    error: z.object({
      code: z.literal('precondition_failed'),
      message: z.string(),
      requestId: z.string(),
    }),
    latest: ItemDTO,
  })
  .openapi('ItemConflictResponse');

// Mirrors lists/schemas.ts — see the rationale comment there. Local copy
// (rather than cross-feature import) keeps the items feature self-contained
// and lets a future change to the items header (e.g. supporting a strong
// validator) move independently from lists.
export const IfMatchHeader = z
  .object({
    'if-match': z.string().openapi({
      description: 'ISO8601 datetime of the last-known updated_at for the row',
      example: '2026-05-05T12:34:56.789Z',
    }),
  })
  .openapi('ItemIfMatchHeader');
