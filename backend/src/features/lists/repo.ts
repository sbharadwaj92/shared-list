import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { lists } from '../../infra/schema.ts';

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
