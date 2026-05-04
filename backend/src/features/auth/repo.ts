import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../infra/db.ts';
import { type NewUser, type User, refreshTokens, users } from '../../infra/schema.ts';

// Repo helpers for the auth domain.
//
// These wrap the lowest-level Drizzle calls so the service layer can read like
// a story rather than a series of column references. There's no soft-delete
// gymnastics here — `users` and `refresh_tokens` are both hard-state tables —
// but we still funnel reads through helpers for the same reason as `lists`:
// any "find user by email" lookup must be case-insensitive (matching the
// functional unique index in schema.ts), and centralizing that rule is how we
// keep it consistent across signup vs login vs admin flows down the road.

export const findUserByEmail = async (db: Database, email: string): Promise<User | undefined> => {
  // Match the functional `lower(email)` unique index. If we wrote
  // `eq(users.email, email)` we'd get an inconsistent lookup: a user who
  // signed up as `Alice@x.com` would not be findable as `alice@x.com`.
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row;
};

export const findUserById = async (db: Database, id: string): Promise<User | undefined> => {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
};

export const insertUser = async (db: Database, user: NewUser): Promise<User> => {
  const [row] = await db.insert(users).values(user).returning();
  if (!row) {
    // Drizzle's `returning()` always returns an array on a single-row insert,
    // but TS narrows the array element to `T | undefined` so we have to
    // assert. The only realistic way `row` is undefined here is a Postgres
    // error that should have thrown above — this branch is a sanity guard.
    throw new Error('insertUser: returning() yielded no row');
  }
  return row;
};

// --- refresh tokens ---

export const insertRefreshToken = async (
  db: Database,
  values: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  },
): Promise<void> => {
  await db.insert(refreshTokens).values(values);
};

// Lookup by hash — used by /auth/refresh to find the row that backs the
// presented opaque token. Returns ALL fields including `used_at` so the
// service layer can detect reuse (rotation hit a token whose used_at is set
// = replay attempt).
export const findRefreshTokenByHash = async (db: Database, tokenHash: string) => {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row;
};

// Atomically mark a refresh token as used and return whether the update
// happened. The `used_at IS NULL` predicate makes this a CAS: if two requests
// race to refresh with the same token, exactly one update wins and the loser's
// rowsAffected is 0. The loser is a reuse attempt and must trigger revoke-all.
export const markRefreshTokenUsed = async (
  db: Database,
  tokenId: string,
): Promise<{ wonRace: boolean }> => {
  const result = await db
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(refreshTokens.id, tokenId), isNull(refreshTokens.usedAt)))
    .returning({ id: refreshTokens.id });
  return { wonRace: result.length === 1 };
};

// Reuse-detection nuke: delete every refresh token row for the user, forcing
// re-login on every device. We hard-delete rather than tombstone — there is
// no audit-trail use case that justifies leaving usable hashes in place after
// a suspected compromise.
export const deleteAllRefreshTokensForUser = async (
  db: Database,
  userId: string,
): Promise<void> => {
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
};

// Used by /auth/logout: revoke just this device's refresh token. The access
// token remains valid until its 15-min TTL — that's an intentional trade-off
// (no token blocklist needed at this scale).
export const deleteRefreshTokenById = async (db: Database, id: string): Promise<void> => {
  await db.delete(refreshTokens).where(eq(refreshTokens.id, id));
};
