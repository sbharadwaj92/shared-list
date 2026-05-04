import { HTTPException } from 'hono/http-exception';
import { config } from '../../infra/config.ts';
import type { Database } from '../../infra/db.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  deleteAllRefreshTokensForUser,
  deleteRefreshTokenById,
  findRefreshTokenByHash,
  findUserByEmail,
  findUserById,
  insertRefreshToken,
  insertUser,
  markRefreshTokenUsed,
} from './repo.ts';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens.ts';

// Auth service — the business logic for /auth/signup, /login, /refresh, /logout.
//
// Routes (in routes.ts) parse + validate input, call into here, and shape the
// HTTP response. Anything that's not "talk to HTTP or talk to DB" lives here:
// password verification, token issuance, refresh-token rotation, and the
// reuse-detection nuke.
//
// The service throws `HTTPException` for *all* expected failure modes. Hono's
// onError catches them and produces the right status + JSON. This means the
// happy path is the only return path — no `Result<T, E>` plumbing, no
// "did this fail?" branching at every call site. The cost is that the service
// is HTTP-aware (it imports HTTPException), but that aligns with how the rest
// of the project handles errors and avoids inventing a parallel error vocabulary.

export type AuthResult = {
  user: { id: string; email: string; displayName: string };
  accessToken: string;
  refreshToken: string;
};

const issueTokensFor = async (
  db: Database,
  userId: string,
): Promise<{ accessToken: string; refreshToken: string }> => {
  // Issue a new access+refresh pair. Used by signup, login, AND refresh —
  // every successful auth event mints a fresh pair. Rotation on refresh is
  // why this can stay a one-liner: there is no "long-lived refresh / short
  // access" asymmetry to special-case.
  const accessToken = await signAccessToken(userId);
  const refreshToken = generateRefreshToken();
  const tokenHash = await hashRefreshToken(refreshToken);
  await insertRefreshToken(db, {
    id: Bun.randomUUIDv7(),
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_SEC * 1000),
  });
  return { accessToken, refreshToken };
};

export const signup = async (
  db: Database,
  input: { email: string; password: string; displayName: string },
): Promise<AuthResult> => {
  const normalizedEmail = input.email.trim().toLowerCase();

  // Race-aware existence check: we still race against another concurrent
  // signup, but the `users_email_lower_unique` functional index is the real
  // backstop — if two signups make it past this read in parallel, exactly
  // one INSERT succeeds and the other throws. This pre-check just gives us
  // a clean 409 in the common case.
  const existing = await findUserByEmail(db, normalizedEmail);
  if (existing) {
    throw new HTTPException(409, { message: 'email already registered' });
  }

  const passwordHash = await hashPassword(input.password);
  const userId = Bun.randomUUIDv7();
  const user = await insertUser(db, {
    id: userId,
    email: normalizedEmail,
    passwordHash,
    displayName: input.displayName.trim(),
  });

  const tokens = await issueTokensFor(db, user.id);
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    ...tokens,
  };
};

export const login = async (
  db: Database,
  input: { email: string; password: string },
): Promise<AuthResult> => {
  const normalizedEmail = input.email.trim().toLowerCase();
  const user = await findUserByEmail(db, normalizedEmail);

  // Same error message and (approximately) same response time whether the
  // email is unknown or the password is wrong — anything else gives an
  // attacker a free user-enumeration oracle. We don't bother with constant-
  // time HMAC compare because Bun.password.verify is already constant-time
  // relative to the hash content; the user-not-found branch skips the verify
  // entirely, but the timing difference (no argon2 work) is observable. For
  // a 3-user local app this is acceptable; if we later care, run a dummy
  // verify against a fixed hash on the not-found path.
  if (!user) {
    throw new HTTPException(401, { message: 'invalid email or password' });
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    throw new HTTPException(401, { message: 'invalid email or password' });
  }

  const tokens = await issueTokensFor(db, user.id);
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    ...tokens,
  };
};

export const refresh = async (db: Database, presentedRefreshToken: string): Promise<AuthResult> => {
  const presentedHash = await hashRefreshToken(presentedRefreshToken);
  const row = await findRefreshTokenByHash(db, presentedHash);

  // Unknown token: not in the table at all. Could be a typo, could be a
  // rotation that nuked everyone's tokens, could be hostile. We don't know,
  // so we just say "invalid" — the client will re-login.
  if (!row) {
    throw new HTTPException(401, { message: 'invalid refresh token' });
  }

  // Expired (past expires_at): treat the same as unknown. We don't bother
  // proactively cleaning these up here — a periodic job (later phase) sweeps.
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new HTTPException(401, { message: 'refresh token expired' });
  }

  // ---- THE REUSE-DETECTION HOT PATH ----
  // If used_at is already set, this is a replay: someone has both copies of
  // a token whose first use already happened. That's either (a) a legitimate
  // client racing two refreshes (single-flight client logic should prevent
  // this — see PLAN.md "single-flight refresh"), or (b) an attacker with a
  // stolen-but-already-used token. We can't tell which, so we assume the
  // worst and revoke ALL refresh tokens for that user. They (and any other
  // honest device) are forced to re-login within the access-token TTL. This
  // bounds attacker access to 15 minutes max, which is the whole point.
  if (row.usedAt !== null) {
    await deleteAllRefreshTokensForUser(db, row.userId);
    throw new HTTPException(401, { message: 'refresh token reuse detected — re-login' });
  }

  // Atomic CAS: mark used_at, but only if it's still NULL. If two genuinely-
  // concurrent refreshes both got past the read above, exactly one wins this
  // update; the loser has wonRace = false and is treated as the reuse case.
  // Without this, both refreshes would mint new tokens *and* leave used_at
  // unset, creating two valid token chains from one parent — defeating
  // reuse-detection on subsequent refreshes.
  const cas = await markRefreshTokenUsed(db, row.id);
  if (!cas.wonRace) {
    await deleteAllRefreshTokensForUser(db, row.userId);
    throw new HTTPException(401, { message: 'refresh token reuse detected — re-login' });
  }

  const user = await findUserById(db, row.userId);
  if (!user) {
    // The FK has ON DELETE CASCADE, so an orphan refresh-token row shouldn't
    // exist. If it does, the DB is in a bad state — fail loudly.
    throw new HTTPException(401, { message: 'user no longer exists' });
  }

  const tokens = await issueTokensFor(db, user.id);
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    ...tokens,
  };
};

// Logout is "revoke this one device's refresh token." We accept the cleartext
// refresh token (same shape as /auth/refresh), look it up by hash, and delete.
// We deliberately do NOT require a valid access token here — a user whose
// access token already expired should still be able to cleanly log out. If
// the presented refresh token is unknown, return 200 anyway: idempotent
// logout is friendlier than a 404, and there's no information leak (the
// caller holding the cleartext token can already prove or disprove its
// validity by trying it on /auth/refresh).
export const logout = async (db: Database, presentedRefreshToken: string): Promise<void> => {
  const presentedHash = await hashRefreshToken(presentedRefreshToken);
  const row = await findRefreshTokenByHash(db, presentedHash);
  if (row) {
    await deleteRefreshTokenById(db, row.id);
  }
};
