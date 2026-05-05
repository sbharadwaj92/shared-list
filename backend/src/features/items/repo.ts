import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { items, listMembers } from '../../infra/schema.ts';

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
