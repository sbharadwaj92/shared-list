import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { type Item, items, listMembers } from '../../infra/schema.ts';

// Repo helpers for the `items` table.
//
// Same rule as `lists/repo.ts`: feature code goes through these helpers; the
// 90-day purge job and the `?since=` sync endpoint are the only places allowed
// to read soft-deleted rows directly.
//
// `position` is sorted ascending here so callers don't have to remember to
// `ORDER BY position`. The integer ordering is last-write-wins under
// concurrent reorders — see PLAN.md for why this is acceptable for v1.

/** All non-deleted items in a list, ordered by position. The standard read
 * for `ListDetailView` (iOS) and the equivalent Compose screen on Android. */
export const activeItems = async (db: Database, listId: string) =>
  db
    .select()
    .from(items)
    .where(and(eq(items.listId, listId), isNull(items.deletedAt)))
    .orderBy(asc(items.position));

/** A single item by id, only if not soft-deleted. Same 404-collapsing rationale
 * as `findActiveListById`. */
export const findActiveItemById = async (db: Database, id: string) => {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), isNull(items.deletedAt)))
    .limit(1);
  return row;
};

/** Items touched after `since` in any list the user is *currently* a member of,
 * INCLUDING soft-deleted (tombstoned) item rows. Used by `GET /sync/items?since=`.
 *
 * Same two filter rules as `listsSince`:
 *   - `items.deleted_at` not filtered → tombstones flow.
 *   - `list_members.deleted_at IS NULL` filtered → revoked users stop seeing
 *     items in lists they no longer belong to.
 *
 * No `position` ordering here — sync responses are timestamp-ordered, not
 * display-ordered. Display order is rebuilt locally from `position` after
 * the client merges the batch into its store. */
export const itemsSince = async (db: Database, userId: string, since: Date) =>
  db
    .select()
    .from(items)
    .where(
      and(
        gt(items.updatedAt, since),
        inArray(
          items.listId,
          db
            .select({ id: listMembers.listId })
            .from(listMembers)
            .where(and(eq(listMembers.userId, userId), isNull(listMembers.deletedAt))),
        ),
      ),
    );

// ---------------------------------------------------------------------------
// Write helpers (Phase 7 slice C.1)
// ---------------------------------------------------------------------------

/** Idempotent insert. Returns `{ row, created: false }` on a PK conflict so
 * a client retry receives the already-stored row — same idempotency contract
 * as `insertListWithOwner`. Also surfaces the soft-deleted-id case as an
 * explicit error so the route can map it to 409 (rather than silently
 * returning a tombstone the caller did not ask for). */
export const insertItem = async (
  db: Database,
  values: {
    id: string;
    listId: string;
    text: string;
    position: number;
    createdBy: string;
  },
): Promise<{ row: Item; created: boolean }> => {
  const inserted = await db
    .insert(items)
    .values({
      id: values.id,
      listId: values.listId,
      text: values.text,
      position: values.position,
      createdBy: values.createdBy,
    })
    .onConflictDoNothing({ target: items.id })
    .returning();
  if (inserted.length === 0) {
    const existing = await findActiveItemById(db, values.id);
    if (!existing) {
      throw new ItemIdConflictWithTombstone(values.id);
    }
    return { row: existing, created: false };
  }
  const firstRow = inserted[0];
  if (!firstRow) {
    throw new Error('insertItem: returning() unexpectedly empty after insert');
  }
  return { row: firstRow, created: true };
};

export class ItemIdConflictWithTombstone extends Error {
  constructor(public readonly itemId: string) {
    super(`item ${itemId} exists but is tombstoned`);
    this.name = 'ItemIdConflictWithTombstone';
  }
}

// Patch fields are intentionally a small closed set. Each is optional so a
// PATCH body with only `{ text }` updates only `text`, only `{ checked }`
// toggles the check timestamp, etc.
//
// `checked` accepts `Date` or `null` rather than a boolean: the wire format
// preserves the timestamp the item was checked off (see SyncDTOs and
// ItemDTO comments). The route handler is responsible for translating an
// inbound boolean toggle into a Date or null before calling this helper.
export type ItemPatch = {
  text?: string;
  position?: number;
  checked?: Date | null;
};

/** Conditional patch via If-Match: applies the patch only if the row's
 * current `updated_at` equals `expectedUpdatedAt` AND the row is still
 * alive. Returns the latest row on the conflict path so the route handler
 * can echo it back to the client. */
export const conditionalUpdateItem = async (
  db: Database,
  values: { id: string; patch: ItemPatch; expectedUpdatedAt: Date },
): Promise<{ ok: true; row: Item } | { ok: false; latest: Item | undefined }> => {
  const { patch } = values;
  // Build the SET clause from only the keys present in the patch — sending
  // `undefined` to drizzle `.set()` would still update the column to NULL on
  // some drivers, which is the opposite of "leave it alone."
  const setValues: Partial<{ text: string; position: number; checked: Date | null }> = {};
  if (patch.text !== undefined) setValues.text = patch.text;
  if (patch.position !== undefined) setValues.position = patch.position;
  if (patch.checked !== undefined) setValues.checked = patch.checked;
  if (Object.keys(setValues).length === 0) {
    // Empty patch: nothing to do. We still treat this as success against the
    // current row to keep the contract simple — clients that send a no-op
    // shouldn't get a 409 just because nothing changed. The route layer's
    // Zod schema rejects fully-empty bodies before we get here, so this is
    // a defense-in-depth guard.
    const latest = await findActiveItemById(db, values.id);
    if (!latest) {
      return { ok: false, latest: undefined };
    }
    return { ok: true, row: latest };
  }
  const updated = await db
    .update(items)
    .set(setValues)
    .where(
      and(
        eq(items.id, values.id),
        eq(items.updatedAt, values.expectedUpdatedAt),
        isNull(items.deletedAt),
      ),
    )
    .returning();
  const winner = updated[0];
  if (winner) {
    return { ok: true, row: winner };
  }
  const latest = await findActiveItemById(db, values.id);
  return { ok: false, latest };
};

/** Soft-delete a single item. Returns `{ deleted: false }` if the row was
 * already gone (or never existed) so the route handler can pick 404 vs 204. */
export const softDeleteItem = async (
  db: Database,
  itemId: string,
): Promise<{ deleted: boolean }> => {
  const updated = await db
    .update(items)
    .set({ deletedAt: sql`date_trunc('milliseconds', now())` })
    .where(and(eq(items.id, itemId), isNull(items.deletedAt)))
    .returning({ id: items.id });
  return { deleted: updated.length === 1 };
};
