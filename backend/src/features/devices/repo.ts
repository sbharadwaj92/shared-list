import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { type DeviceToken, deviceTokens } from '../../infra/schema.ts';

// Repo helpers for `device_tokens`.
//
// The semantics we want: registering a token is idempotent on the token
// itself. Same physical device hitting /devices twice with the same APNs
// or FCM token should not create two rows. Different user logging in on
// the same physical device (so the OS reissues the same token) should
// MOVE the row to the new user — because the token is globally unique by
// APNs/FCM contract, two users owning the same token simultaneously would
// route every push for either user to the other phone.
//
// The schema has a unique index on `token` alone (see infra/schema.ts L232),
// so a plain INSERT with ON CONFLICT(token) DO UPDATE gives us that
// "move + refresh" semantics in one statement. Drizzle's `.onConflictDoUpdate`
// is the right tool here.

/** Upsert (user, platform, token) and return the canonical row. If the
 * token already exists, its row is reassigned to `userId` and platform is
 * reset (in case a device reinstall switched platforms via shared icloud
 * + emulator transitions, vanishingly unlikely but cheap to handle).
 * `last_seen_at` and `updated_at` are bumped to now() so dormant-token
 * cleanup jobs see this as "alive." */
export const upsertDeviceToken = async (
  db: Database,
  args: {
    id: string;
    userId: string;
    platform: 'ios' | 'android';
    token: string;
  },
): Promise<DeviceToken> => {
  // Drizzle returns an array; we only ever insert one row, so destructure.
  // ON CONFLICT (token) means: if a row with this token already exists,
  // update it instead of inserting. We update userId/platform too so a
  // device that switched users gets reassigned cleanly. The original `id`
  // stays — there's no reason to churn the primary key.
  const [row] = await db
    .insert(deviceTokens)
    .values({
      id: args.id,
      userId: args.userId,
      platform: args.platform,
      token: args.token,
    })
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: {
        userId: args.userId,
        platform: args.platform,
        lastSeenAt: sql`date_trunc('milliseconds', now())`,
        updatedAt: sql`date_trunc('milliseconds', now())`,
      },
    })
    .returning();
  if (!row) {
    // ON CONFLICT DO UPDATE always touches a row when there's a conflict,
    // so RETURNING * always yields one row. This branch is unreachable;
    // we surface it as a real Error so a future Drizzle bump that breaks
    // the contract isn't silent.
    throw new Error('upsertDeviceToken: no row returned');
  }
  return row;
};

/** All active device tokens for one user. Used by the push fan-out path
 * (Phase 16) to enumerate where a notification should land. Currently
 * unused at the route layer — exported here so Slice C / Phase 16 can
 * read from a single helper rather than duplicating the SELECT. */
export const deviceTokensForUser = async (db: Database, userId: string): Promise<DeviceToken[]> =>
  db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId));
