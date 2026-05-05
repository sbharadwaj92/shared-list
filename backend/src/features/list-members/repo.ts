import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../infra/db.ts';
import { listMembers } from '../../infra/schema.ts';

// Repo helpers for `list_members`.
//
// Membership is the auth gate for every list and item operation: "is this
// caller a member of the list?" replaces "is this caller the owner of the
// resource?" because even the list creator is just a member with role 'owner'.
// Keeping membership reads here, behind a soft-delete filter, ensures a user
// who has been removed from a list (soft-deleted member row) loses access on
// the next request.
//
// Reading membership is hot — it happens on every list/item endpoint — so
// the `(list_id, user_id)` lookup uses the composite primary key for an
// O(log n) index seek.

/** Returns the active member row for a (list, user) pair, or `undefined` if
 * the user is not a member or the membership has been soft-deleted. */
export const activeMembership = async (db: Database, listId: string, userId: string) => {
  const [row] = await db
    .select()
    .from(listMembers)
    .where(
      and(
        eq(listMembers.listId, listId),
        eq(listMembers.userId, userId),
        isNull(listMembers.deletedAt),
      ),
    )
    .limit(1);
  return row;
};

/** All active members of a list. Used when fanning out push notifications
 * (excluding the actor) and when rendering "people in this list" in UI. */
export const activeMembersOfList = async (db: Database, listId: string) =>
  db
    .select()
    .from(listMembers)
    .where(and(eq(listMembers.listId, listId), isNull(listMembers.deletedAt)));

/** Membership rows touched after `since` that the caller has a stake in,
 * INCLUDING soft-deleted (tombstoned) rows. Used by
 * `GET /sync/list_members?since=`.
 *
 * "Has a stake in" decomposes into two cases the client cares about:
 *
 *   1. The caller's *own* membership row (active or tombstoned) for any list.
 *      Surfaces self-revocations: when the caller is removed from a list,
 *      this row's `deleted_at` is the signal that tells the client to drop
 *      the list locally.
 *
 *   2. *Other* members' rows for lists where the caller is currently an active
 *      member. Lets the client render the "people in this list" view and
 *      keep it fresh as members come and go. Once the caller is revoked from
 *      a list (case 1 fires), they stop seeing further changes to that list's
 *      member set — privacy-preserving.
 *
 * Implementation is a single SELECT with two OR'd predicates instead of two
 * separate queries: the union semantics live in SQL, the route handler stays
 * declarative, and Postgres can use the appropriate indexes
 * (`list_members_user_id_idx` for case 1, the PK for case 2's IN-subquery). */
export const membersSince = async (db: Database, userId: string, since: Date) => {
  // Subquery alias — listing my active memberships, the set of lists whose
  // *other* members' rows I'm allowed to see. Aliased so we can reference it
  // in the outer query without name collision against the main `listMembers`
  // table on the other side of the OR.
  const myMemberships = alias(listMembers, 'my_memberships');
  return db
    .select()
    .from(listMembers)
    .where(
      and(
        gt(listMembers.updatedAt, since),
        or(
          // Case 1: my own row — active or tombstoned, regardless of list state.
          eq(listMembers.userId, userId),
          // Case 2: anyone's row in lists where I'm currently an active member.
          inArray(
            listMembers.listId,
            db
              .select({ id: myMemberships.listId })
              .from(myMemberships)
              .where(and(eq(myMemberships.userId, userId), isNull(myMemberships.deletedAt))),
          ),
        ),
      ),
    );
};
