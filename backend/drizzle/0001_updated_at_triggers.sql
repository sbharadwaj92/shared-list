-- updated_at trigger
--
-- Drizzle Kit generates table DDL from the TypeScript schema, but it does not
-- emit triggers. The sync engine's last-write-wins comparison relies on
-- `updated_at` being bumped on EVERY mutation, including direct SQL or admin
-- sessions that bypass the application layer. Application-layer hooks
-- (Drizzle's `$onUpdate`, ORM lifecycle events) can't guarantee that — only
-- a database trigger can.
--
-- The function uses `NEW.updated_at = now()` rather than `clock_timestamp()`
-- so all rows written inside one transaction get the same timestamp. That
-- matters for cascade soft-delete (deleting a list and its items in the same
-- transaction): clients reading `?since=` see them all, atomically, without
-- one row sneaking in just below the cutoff.
--
-- Phase 7 follow-up: `0002_truncate_updated_at_ms.sql` swaps `now()` for
-- `date_trunc('milliseconds', now())` so JS/Swift/Kotlin Date round-trip is
-- lossless. This file's body is the historical first version; do not edit it
-- — the active body lives in 0002.
--
-- `LANGUAGE plpgsql` is required because the body is procedural (an assignment
-- and a return); SQL functions can't return NEW. `STABLE` is the strongest
-- volatility we can claim — `now()` is stable within a transaction.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- One trigger per table. `BEFORE UPDATE` fires before the row is written, so
-- the modified `updated_at` lands in the actual UPDATE — there is no second
-- write. `FOR EACH ROW` is required (the default in Postgres is statement-
-- level, which would not give us NEW).
--
-- Naming: `<table>_set_updated_at` keeps `\d <table>` output in psql readable
-- and avoids collisions if more triggers land on these tables later.

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER lists_set_updated_at
  BEFORE UPDATE ON lists
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER list_members_set_updated_at
  BEFORE UPDATE ON list_members
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER items_set_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER device_tokens_set_updated_at
  BEFORE UPDATE ON device_tokens
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER list_invites_set_updated_at
  BEFORE UPDATE ON list_invites
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER refresh_tokens_set_updated_at
  BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
