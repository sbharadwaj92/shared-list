import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { listMembers, lists } from '../../infra/schema.ts';

// Repo helpers for the `lists` table.
//
// The cardinal rule: feature code reads through these helpers, never through
// `db.select().from(lists)` directly. The reason is the `deleted_at IS NULL`
// filter — it's mandatory for every active read, and centralizing it here
// means we can't forget it in one of the dozens of places lists get queried.
// Soft-deleted rows still need to be visible to one consumer (the `?since=`
// sync endpoint, which surfaces tombstones to clients), and to one process
// (the daily 90-day purge job). Both will read the table directly, by design.
// Anywhere else, raw access is a bug.
//
// Why pass `db` in instead of importing the singleton: tests need to point at
// a Testcontainers-backed database, not the dev one. Threading `db` through
// the repo functions makes that swap a constructor argument rather than a
// module-level monkey patch. The cost is one parameter per call.

/** All non-deleted lists, regardless of who owns them. Use sparingly — most
 * call sites want `activeListsForUser` instead, which scopes by membership. */
export const activeLists = async (db: Database) =>
  db.select().from(lists).where(isNull(lists.deletedAt));

/** A single list by id, only if not soft-deleted. Returns `undefined` for both
 * "doesn't exist" and "exists but deleted" — the API layer collapses both
 * cases into 404 because exposing the distinction leaks information. */
export const findActiveListById = async (db: Database, id: string) => {
  const [row] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.id, id), isNull(lists.deletedAt)))
    .limit(1);
  return row;
};

/** Lists touched after `since` that the user is *currently* a member of,
 * INCLUDING soft-deleted (tombstoned) list rows. This is the read used by
 * `GET /sync/lists?since=`.
 *
 * Two filter rules to keep straight:
 *
 *   - **`lists.deleted_at` is NOT filtered.** The whole point of the sync feed
 *     is to surface tombstones so clients can reconcile disappearances. A row
 *     with `deleted_at IS NOT NULL` and `updated_at > since` is exactly the
 *     "this list has been deleted since you last synced" signal.
 *
 *   - **`list_members.deleted_at IS NULL` IS filtered.** A user whose membership
 *     was revoked must stop receiving further updates to that list immediately;
 *     they learn about the revocation itself from `GET /sync/list_members?since=`,
 *     which surfaces their own soft-deleted membership row as a tombstone.
 *     Mixing in further list updates after revocation would be a privacy bug
 *     and a protocol smell — one feed handles the membership state, another
 *     the list state, and the client merges them locally.
 *
 * Phase 7's deliberate trade-off: a list-rename that lands in the same write
 * window as a member-revocation will not reach the revoked user. They'll see
 * the membership tombstone and drop the list locally, which is the correct
 * end state regardless. */
export const listsSince = async (db: Database, userId: string, since: Date) =>
  db
    .select()
    .from(lists)
    .where(
      and(
        gt(lists.updatedAt, since),
        inArray(
          lists.id,
          db
            .select({ id: listMembers.listId })
            .from(listMembers)
            .where(and(eq(listMembers.userId, userId), isNull(listMembers.deletedAt))),
        ),
      ),
    );
