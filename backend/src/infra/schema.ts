import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Conventions used across every table in this file
// ---------------------------------------------------------------------------
//
// 1. **UUID v7 primary keys, generated in application code.** Postgres has no
//    native uuidv7() until 18; we're on 17. We could install pg_uuidv7, but the
//    sync protocol *also* needs clients (iOS, Android) to generate IDs offline
//    so a `POST` retried after a network blip doesn't double-create. If the DB
//    were the only source of IDs, the client couldn't safely retry. Centralizing
//    UUID generation in app code on every layer makes the idempotency story
//    uniform — server uses `Bun.randomUUIDv7()`, mobile uses platform v7 — and
//    keeps the schema simple (no extension dependency, no trigger to generate).
//
//    The cost: the columns below are `uuid('id').primaryKey()` with no default.
//    Every INSERT must supply an `id`. That's a load-bearing rule for the repo
//    layer to enforce.
//
// 2. **`updated_at` is set by a trigger, not by application code.** Drizzle's
//    `$onUpdate` hook would fire only when you go through Drizzle, but raw SQL
//    in a future migration or a `psql` admin session would silently bypass it.
//    A `BEFORE UPDATE` trigger is the only thing that can guarantee "any change
//    to a row bumps the timestamp" — and the sync engine's last-write-wins
//    relies on that guarantee at the protocol level. The trigger function and
//    the per-table triggers live in `drizzle/0000_add_updated_at_trigger.sql`,
//    a hand-written follow-up to the drizzle-kit-generated table DDL.
//
// 3. **Soft delete on user-facing entities only.** `lists`, `items`,
//    `list_members` carry `deleted_at TIMESTAMPTZ NULL`. Reads in feature code
//    must go through `activeLists()` / `activeItems()` etc. (in `repo.ts`)
//    which always filter `deleted_at IS NULL`. Raw `db.select().from(items)`
//    is intentionally allowed — the 90-day purge job needs it — but feature
//    code that uses it is a bug. Other tables (`users`, `refresh_tokens`,
//    `device_tokens`, `list_invites`) don't soft-delete: account deletion is
//    out of scope; refresh tokens are hard-deleted on revoke (so a leaked DB
//    snapshot can't reuse them); device tokens get replaced; invites use
//    `used_at` to mark single-use consumption.
//
// 4. **Indexes on every FK and on `updated_at`.** The FK indexes make joined
//    reads (a user's lists, a list's items) O(log n) instead of O(n).
//    `updated_at` indexes are what makes `GET /<resource>?since=<ts>` fast —
//    the sync engine queries this on every reconnect, so an unindexed scan
//    would be felt immediately.

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
//
// `email` is the login identifier. `citext` would be the principled choice for
// case-insensitive uniqueness, but it's an extension and adds setup. A plain
// `text` column with a `lower(email)` unique index achieves the same property
// without the extension dependency, and we already need to lowercase on signup
// for display anyway.
//
// `password_hash` stores the full argon2id-encoded string (Bun.password.hash
// returns the entire `$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>` blob).
// Storing the encoded string means we can re-hash with new parameters later
// by inspecting the prefix on login — no schema change needed.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Functional unique index on lower(email) gives us case-insensitive
    // uniqueness without needing the citext extension. Postgres can use this
    // index for `WHERE lower(email) = lower($1)` lookups during login.
    emailLowerUnique: uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
    updatedAtIdx: index('users_updated_at_idx').on(table.updatedAt),
  }),
);

// ---------------------------------------------------------------------------
// lists
// ---------------------------------------------------------------------------
//
// A list is the unit of sharing. Membership is via `list_members`, not a
// `user_id` FK on the list itself — even the creator is just a member with
// `role = 'owner'`. That uniformity simplifies the auth checks in CRUD
// endpoints (always "is the caller a member?" rather than "is the caller the
// creator OR a member?").
//
// `created_by` is denormalized for audit/display ("created by Alice"). It is
// NOT used for permission checks — those go through `list_members`.
export const lists = pgTable(
  'lists',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    createdByIdx: index('lists_created_by_idx').on(table.createdBy),
    updatedAtIdx: index('lists_updated_at_idx').on(table.updatedAt),
  }),
);

// ---------------------------------------------------------------------------
// list_members + role enum
// ---------------------------------------------------------------------------
//
// `pgEnum` creates a real Postgres ENUM type. The alternative, `text` + a CHECK
// constraint, is more flexible (adding values is a single ALTER without a type
// migration) but loses the type-system guarantee on the Drizzle side. Since
// `owner | editor` is small and stable for v1 (`viewer` is a Phase 19+ idea),
// the enum is the better learning artifact: it makes the role explicit in
// `\d list_members` output and rejects typos at insert time.
//
// Composite primary key `(list_id, user_id)` enforces "a user is a member of a
// list at most once" without needing a separate unique constraint. It also
// gives us a B-tree index on `(list_id, user_id)` for free, which is the
// natural lookup direction.
export const listRole = pgEnum('list_role', ['owner', 'editor']);

export const listMembers = pgTable(
  'list_members',
  {
    listId: uuid('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: listRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.listId, table.userId] }),
    // The PK already indexes (list_id, user_id). We also need the reverse —
    // "all lists for a user" — which is what `ListsView` will hit on every load.
    userIdIdx: index('list_members_user_id_idx').on(table.userId),
    updatedAtIdx: index('list_members_updated_at_idx').on(table.updatedAt),
  }),
);

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------
//
// `position` is a plain integer. Concurrent reorders under last-write-wins
// will occasionally produce a visible glitch (two devices each move different
// items into slot 3, one wins, the other looks "snapped back"). PLAN.md
// explicitly accepts this for v1 — fractional indexing is a Phase 19 level-up.
//
// `checked` and `text` are the only mutable user-facing fields. `created_by`
// is again denormalized for audit and never used in auth checks (membership
// in the list governs that).
//
// Cascade soft-delete from list → items happens in application code (a single
// transaction in `DELETE /lists/:id`), not via a DB trigger. Doing it in app
// code keeps the cascade visible to the sync engine — every soft-deleted item
// gets its own `updated_at` bump, so `?since=` on the items endpoint will
// surface them as tombstones to clients that aren't subscribed to lists.
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey(),
    listId: uuid('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    checked: timestamp('checked_at', { withTimezone: true }),
    position: integer('position').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    listIdIdx: index('items_list_id_idx').on(table.listId),
    createdByIdx: index('items_created_by_idx').on(table.createdBy),
    updatedAtIdx: index('items_updated_at_idx').on(table.updatedAt),
  }),
);

// ---------------------------------------------------------------------------
// device_tokens
// ---------------------------------------------------------------------------
//
// One row per (user, platform, token). A user may have multiple devices, and
// the same physical device can rotate its token (APNs and FCM both reissue
// tokens on reinstall, OS upgrade, or after long inactivity). The unique
// constraint is on `token` alone — a token is globally unique by APNs/FCM
// definition, so a token registered to user A and later re-registered to
// user B should *move* to B, not duplicate.
//
// `last_seen_at` is updated on every WS connect and every successful push.
// Tokens that haven't been seen in N days can later be purged by a job; for
// now we just record it.
export const platformEnum = pgEnum('device_platform', ['ios', 'android']);

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    token: text('token').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUnique: uniqueIndex('device_tokens_token_unique').on(table.token),
    userIdIdx: index('device_tokens_user_id_idx').on(table.userId),
    updatedAtIdx: index('device_tokens_updated_at_idx').on(table.updatedAt),
  }),
);

// ---------------------------------------------------------------------------
// list_invites
// ---------------------------------------------------------------------------
//
// 8-character base32 join code (≈40 bits of entropy). The code itself is the
// primary key — there is no separate `id`. This is unusual but deliberate:
// the code IS the natural identifier (it's what gets typed in), and we never
// need to "rename" or "look up" an invite by anything else. Storing it as the
// PK lets `POST /invites/:code/accept` go straight to a single-row lookup
// without an additional unique index.
//
// Single-use is enforced by `used_at IS NULL` on accept. A second accept call
// will see `used_at IS NOT NULL` and return 409. Combined with the 30/min/IP
// rate limit on the accept endpoint, brute force is untenable even at 40 bits.
export const listInvites = pgTable(
  'list_invites',
  {
    code: text('code').primaryKey(),
    listId: uuid('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    listIdIdx: index('list_invites_list_id_idx').on(table.listId),
    createdByIdx: index('list_invites_created_by_idx').on(table.createdBy),
    expiresAtIdx: index('list_invites_expires_at_idx').on(table.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------
//
// The refresh token sent to the client is an opaque random string (not stored
// here directly). What's stored is its sha256 hash — so a DB compromise yields
// hashes, not bearer tokens. On `POST /auth/refresh`, the server hashes the
// presented token and looks it up by hash.
//
// `used_at` is the rotation marker. A normal refresh: row's `used_at` gets
// stamped, a new row is inserted with a new token. Reuse detection: if a
// presented token's row already has `used_at IS NOT NULL`, an attacker is
// replaying a stolen token — DELETE all `refresh_tokens` rows for that
// `user_id`, forcing every device to re-login within 15 minutes (the access
// token TTL).
//
// Why hard-delete on revoke instead of soft-delete: if a breach gives an
// attacker the DB, soft-deleted refresh-token rows would still let them
// impersonate. There is no "audit trail" use case for retaining revoked
// tokens that justifies the security cost.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('refresh_tokens_token_hash_unique').on(table.tokenHash),
    userIdIdx: index('refresh_tokens_user_id_idx').on(table.userId),
    expiresAtIdx: index('refresh_tokens_expires_at_idx').on(table.expiresAt),
  }),
);

// Drizzle-zod and feature code use these inferred types instead of redefining.
// Keeping them at the bottom of the file means the inference picks up every
// column without ordering hazards.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
export type ListMember = typeof listMembers.$inferSelect;
export type NewListMember = typeof listMembers.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type DeviceToken = typeof deviceTokens.$inferSelect;
export type NewDeviceToken = typeof deviceTokens.$inferInsert;
export type ListInvite = typeof listInvites.$inferSelect;
export type NewListInvite = typeof listInvites.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
