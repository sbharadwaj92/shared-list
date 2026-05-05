-- Truncate updated_at to millisecond precision in the trigger.
--
-- Why: the sync protocol's `?since=` cursor needs lossless round-trip through
-- the JS / Swift / Kotlin clients. All three platforms' Date types are
-- millisecond-precision. Postgres `now()` returns microsecond precision, so a
-- row stamped at e.g. `47.603008` would be read by the client as `47.603` (a
-- truncating cast), passed back as the next cursor, and the server would then
-- see `47.603 < 47.603008` as TRUE — re-streaming the row that was supposed
-- to be at-the-cursor. Strict `>` filtering broke under the cross-language
-- precision mismatch.
--
-- Fix: stamp `updated_at` at millisecond precision so all sides agree on what
-- the timestamp is. The 1-millisecond floor on tie-resolution is acceptable
-- for a 3-user app — UUID v7 ids embed millisecond timestamps and act as a
-- secondary sort key if two rows ever share `updated_at`.
--
-- We REPLACE the function (CREATE OR REPLACE) — triggers reference functions
-- by name, not by oid, so they pick up the new body without needing recreation.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  -- date_trunc('milliseconds', ...) drops sub-millisecond precision while
  -- preserving the timezone (`now()` is timestamptz). The result still has
  -- the timestamptz type — Postgres only suppresses the trailing micros.
  NEW.updated_at = date_trunc('milliseconds', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The original 0001 trigger only fires `BEFORE UPDATE`. INSERTs flow through
-- the column `DEFAULT now()`, which still produces microsecond precision —
-- bypassing the trigger we just rewrote. Extend each trigger to fire on
-- INSERT as well so EVERY path (drizzle, raw SQL, admin sessions) lands at
-- millisecond precision.
--
-- We DROP and recreate rather than ALTER because Postgres has no ALTER TRIGGER
-- syntax for changing the firing event. DROP + CREATE under one migration is
-- atomic by virtue of running inside the migration's implicit transaction.

DROP TRIGGER users_set_updated_at ON users;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER lists_set_updated_at ON lists;
--> statement-breakpoint
CREATE TRIGGER lists_set_updated_at
  BEFORE INSERT OR UPDATE ON lists
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER list_members_set_updated_at ON list_members;
--> statement-breakpoint
CREATE TRIGGER list_members_set_updated_at
  BEFORE INSERT OR UPDATE ON list_members
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER items_set_updated_at ON items;
--> statement-breakpoint
CREATE TRIGGER items_set_updated_at
  BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER device_tokens_set_updated_at ON device_tokens;
--> statement-breakpoint
CREATE TRIGGER device_tokens_set_updated_at
  BEFORE INSERT OR UPDATE ON device_tokens
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER list_invites_set_updated_at ON list_invites;
--> statement-breakpoint
CREATE TRIGGER list_invites_set_updated_at
  BEFORE INSERT OR UPDATE ON list_invites
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER refresh_tokens_set_updated_at ON refresh_tokens;
--> statement-breakpoint
CREATE TRIGGER refresh_tokens_set_updated_at
  BEFORE INSERT OR UPDATE ON refresh_tokens
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Bring existing rows in line with the new precision. Without this, dev DBs
-- carry a mix of micro- and millisecond-precision timestamps until each row
-- happens to be updated again, which would silently fail the `?since=` test
-- against any historical timestamp. Production has no data yet (Phase 7), so
-- the cost is just one rewrite per table on dev.
UPDATE users SET updated_at = updated_at;
--> statement-breakpoint
UPDATE lists SET updated_at = updated_at;
--> statement-breakpoint
UPDATE list_members SET updated_at = updated_at;
--> statement-breakpoint
UPDATE items SET updated_at = updated_at;
--> statement-breakpoint
UPDATE device_tokens SET updated_at = updated_at;
--> statement-breakpoint
UPDATE list_invites SET updated_at = updated_at;
--> statement-breakpoint
UPDATE refresh_tokens SET updated_at = updated_at;
