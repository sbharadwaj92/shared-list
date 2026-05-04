import { and, eq, isNull } from 'drizzle-orm';
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
