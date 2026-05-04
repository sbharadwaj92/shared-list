import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { items } from '../../infra/schema.ts';

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
