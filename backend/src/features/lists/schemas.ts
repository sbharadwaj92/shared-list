import { z } from '@hono/zod-openapi';
import { ListDTO } from '../sync/schemas.ts';

// Zod schemas for the lists write endpoints (Phase 7 slice C.1).
//
// We re-export `ListDTO` from `sync/schemas.ts` rather than redefine it here
// — the shape returned by POST/PATCH/DELETE must match the shape clients
// already deserialize from `GET /sync/lists`, otherwise the client needs two
// `Decodable` types for "the same row." One source of truth means a future
// column rename surfaces in one schema and one DTO, not two of each.
export { ListDTO };

// `ListIdParam` lives in the path for PATCH /lists/:id and DELETE /lists/:id.
// We declare it explicitly (rather than relying on Hono's untyped `c.req.param`)
// so the OpenAPI doc shows the parameter and a malformed UUID returns 400
// via the validation hook instead of silently surfacing as a not-found.
export const ListIdParam = z
  .object({
    id: z.uuid().openapi({ param: { name: 'id', in: 'path' }, example: '019470fd-…' }),
  })
  .openapi('ListIdParam');

// POST /lists body. The id MUST come from the client — Phase 7 idempotency
// hinges on the client owning UUID v7 generation so a network-blip retry
// hits ON CONFLICT DO NOTHING and gets the canonical row back.
export const CreateListBody = z
  .object({
    id: z.uuid().openapi({
      description:
        'Client-generated UUID v7. Required so a retried POST is idempotent against ON CONFLICT DO NOTHING.',
    }),
    name: z.string().trim().min(1, 'name required').max(120, 'name too long'),
  })
  .openapi('CreateListBody', {
    example: {
      id: '019470fd-7a00-7000-8000-000000000001',
      name: 'Groceries',
    },
  });

// PATCH /lists/:id body. Only `name` is patchable in C.1 — owner transfer,
// archive, etc. land in later phases. We keep the shape an object (not a bare
// string) so future patch fields can be added without a breaking change.
export const PatchListBody = z
  .object({
    name: z.string().trim().min(1, 'name required').max(120, 'name too long'),
  })
  .openapi('PatchListBody');

// 409 conflict envelope for the If-Match-mismatch path. The latest row's
// timestamp is included so the client can hand it back as the next If-Match
// without an extra round-trip.
//
// Why a structured `latest` payload instead of just an `etag` string: the
// client also needs the new `name` to render the merge UI, and the protocol
// already speaks `ListDTO` everywhere — sending the full row keeps the
// contract uniform.
export const ListConflictResponse = z
  .object({
    error: z.object({
      code: z.literal('precondition_failed'),
      message: z.string(),
      requestId: z.string(),
    }),
    latest: ListDTO,
  })
  .openapi('ListConflictResponse');

// Header schema for If-Match. Declared as a Zod object schema (rather than
// shoved into the OpenAPI route config as a hand-typed parameter) because
// `@hono/zod-openapi`'s validator runs `safeParseAsync` against the value
// it stores under `request.headers` — anything that isn't a real Zod schema
// throws at request time. The header NAME must match what the route handler
// reads via `c.req.header('If-Match')`. We accept any string here and parse
// the ISO datetime in the handler so the error message can be tailored
// (a Zod-validator failure here would produce a generic 400 in the central
// envelope rather than the more helpful "If-Match must be ISO8601…").
export const IfMatchHeader = z
  .object({
    'if-match': z.string().openapi({
      description: 'ISO8601 datetime of the last-known updated_at for the row',
      example: '2026-05-05T12:34:56.789Z',
    }),
  })
  .openapi('IfMatchHeader');
