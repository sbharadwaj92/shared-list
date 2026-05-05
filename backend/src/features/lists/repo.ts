import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { type List, type NewList, items, listMembers, lists } from '../../infra/schema.ts';

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

// ---------------------------------------------------------------------------
// Write helpers (Phase 7 slice C.1)
// ---------------------------------------------------------------------------
//
// These wrap the mutation surface for `lists` so the route handlers stay
// declarative and the protocol-critical bits (idempotent insert, conditional
// update, transactional cascade) live in one place.

/** Idempotent insert: insert the list and the owner-membership row in a single
 * transaction. The PK conflict path (`ON CONFLICT (id) DO NOTHING`) makes a
 * client-retried POST safe — the existing canonical row is returned either way.
 *
 * Why both rows in one transaction: a partial outcome (list inserted, member
 * row missing) would leave the actor unable to read their own list back via
 * the membership-scoped helpers, and would leak orphaned lists nobody can
 * see. Atomic insert via `db.transaction` keeps the two rows in lockstep.
 *
 * Why we re-`SELECT` on the conflict branch instead of trusting `RETURNING *`:
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING *` returns ZERO rows when the
 * conflict fires (this is the documented Postgres behaviour). To honour the
 * idempotency contract — "the canonical row is returned either way" — we
 * fall back to a plain SELECT by id on the no-rows path. A retry that lands
 * on this path simply gets the row that the original POST inserted. */
export const insertListWithOwner = async (
  db: Database,
  values: { id: string; name: string; ownerId: string },
): Promise<{ row: List; created: boolean }> => {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(lists)
      .values({ id: values.id, name: values.name, createdBy: values.ownerId })
      .onConflictDoNothing({ target: lists.id })
      .returning();
    if (inserted.length === 0) {
      // Conflict path: the row already exists from a prior POST. Look it up
      // and return it as-is — caller treats this as "your retry hit, here's
      // the row we already have." We MUST go through `tx` not `db` here:
      // the transaction holds the only connection available under the test
      // pool's `max: 1`, and a `db.select(...)` would block on itself.
      const existing = await findActiveListById(tx, values.id);
      if (!existing) {
        // The id collided but the row is soft-deleted (or hard-deleted by a
        // future purge job). We don't try to revive a tombstoned list — the
        // client should pick a new UUID for a brand-new list.
        throw new ListIdConflictWithTombstone(values.id);
      }
      return { row: existing, created: false };
    }
    // Fresh insert: also seed the owner-membership row. We do NOT
    // onConflictDoNothing here — a (list_id, user_id) collision on a brand-
    // new list would be a corruption signal and should surface as an error.
    const firstRow = inserted[0];
    if (!firstRow) {
      throw new Error('insertListWithOwner: returning() unexpectedly empty after insert');
    }
    await tx.insert(listMembers).values({
      listId: firstRow.id,
      userId: values.ownerId,
      role: 'owner',
    });
    return { row: firstRow, created: true };
  });
};

/** Sentinel thrown when a POST /lists retries with an id whose row is
 * soft-deleted. The route handler maps this to 409. We use a dedicated error
 * class (rather than a string discriminator) so the handler doesn't have to
 * pattern-match on a generic Error message. */
export class ListIdConflictWithTombstone extends Error {
  constructor(public readonly listId: string) {
    super(`list ${listId} exists but is tombstoned`);
    this.name = 'ListIdConflictWithTombstone';
  }
}

/** Conditional rename via If-Match: only updates if the row's current
 * `updated_at` equals `expectedUpdatedAt`. Returns the new row on success and
 * `{ conflict: true, latest }` when the precondition fails — the latest row
 * is included so the route handler can hand it back to the client without a
 * second round-trip.
 *
 * The CAS predicate also pins `deleted_at IS NULL` so a write against a
 * concurrently-tombstoned row degrades to "not found" rather than silently
 * resurrecting it. */
export const conditionalUpdateListName = async (
  db: Database,
  values: { id: string; name: string; expectedUpdatedAt: Date },
): Promise<{ ok: true; row: List } | { ok: false; latest: List | undefined }> => {
  const updated = await db
    .update(lists)
    .set({ name: values.name })
    .where(
      and(
        eq(lists.id, values.id),
        eq(lists.updatedAt, values.expectedUpdatedAt),
        isNull(lists.deletedAt),
      ),
    )
    .returning();
  const winner = updated[0];
  if (winner) {
    return { ok: true, row: winner };
  }
  // Precondition failed: either the row was modified between the client's
  // read and write, or it's been deleted. `findActiveListById` returns
  // undefined for both "does not exist" and "soft-deleted" — handler
  // collapses both into 404 vs 409 based on whether the id was ever known.
  const latest = await findActiveListById(db, values.id);
  return { ok: false, latest };
};

/** Soft-delete a list AND every active item underneath in one transaction.
 * Each item's `deleted_at` is set to the same instant so the `?since=` items
 * feed surfaces every tombstone on the next pull — the trigger then bumps
 * each `updated_at` to that same instant for free.
 *
 * Why update items via raw SQL with `now()` rather than threading a JS Date:
 * the `set_updated_at()` trigger truncates `updated_at` to ms precision via
 * `date_trunc('milliseconds', now())`. Computing `deleted_at` on the same
 * clock (via the DB) keeps `deleted_at` and `updated_at` aligned — the
 * client expects them to match for fresh tombstones. Using `new Date()`
 * here would introduce sub-ms drift that could trip future invariants. */
export const softDeleteListCascade = async (
  db: Database,
  listId: string,
): Promise<{ deleted: boolean }> => {
  return db.transaction(async (tx) => {
    const updatedList = await tx
      .update(lists)
      .set({ deletedAt: sql`date_trunc('milliseconds', now())` })
      .where(and(eq(lists.id, listId), isNull(lists.deletedAt)))
      .returning({ id: lists.id });
    if (updatedList.length === 0) {
      return { deleted: false };
    }
    // Cascade: only active items get the tombstone bump. Already-deleted
    // items keep their original `deleted_at`, so we don't churn their
    // `updated_at` and re-stream them to clients that have already seen them.
    await tx
      .update(items)
      .set({ deletedAt: sql`date_trunc('milliseconds', now())` })
      .where(and(eq(items.listId, listId), isNull(items.deletedAt)));
    return { deleted: true };
  });
};

// `NewList` is re-exported here so call sites that build a `values` object
// don't need to reach across into `infra/schema`. The inferred type stays in
// sync with the schema automatically.
export type { NewList };
