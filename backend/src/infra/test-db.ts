import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { Wait } from 'testcontainers';

// Test-only database helper.
//
// `setupTestDatabase()` boots a real Postgres in a Docker container, applies
// the same `drizzle/` migration set our dev DB runs, and returns a Drizzle
// client pointed at it. This is *not* a mock — every assertion in the repo
// tests runs against actual Postgres semantics (FK constraints, triggers,
// enum types, functional indexes). The dev container at `shared-list-postgres`
// is left untouched.
//
// Why a real container instead of an in-memory SQLite or pglite?
// - The `updated_at` trigger is plpgsql; SQLite has nothing equivalent.
// - The `list_role` and `device_platform` enums are Postgres types.
// - The functional unique index `lower(email)` relies on Postgres expression
//   indexes.
// - Most of all: the *whole point* of this phase's tests is to verify the
//   schema works as it will in production. A fake DB would test the fake's
//   behavior, not ours.
//
// Why `postgres-js` here when the production app uses `bun-sql`?
// drizzle-kit's migrator only ships adapters for node-style drivers
// (pg, postgres-js, neon, vercel). `postgres-js` was already added for
// `db:migrate` in the dev workflow, so reusing it for tests avoids a second
// driver dependency. The repo helpers accept the `Database` type, which is
// structurally compatible with both drivers' Drizzle clients — all of our
// repo code uses the standard Drizzle query builder, not driver-specific APIs.
//
// Lifecycle:
//   const t = await setupTestDatabase();
//   // ... tests use t.db ...
//   await t.teardown();
// Tests should call `setupTestDatabase` in `beforeAll` and `teardown` in
// `afterAll`. Container start is ~3-5s on first pull, ~1-2s after that.

export type TestDatabase = {
  db: ReturnType<typeof drizzle>;
  container: StartedPostgreSqlContainer;
  client: ReturnType<typeof postgres>;
  teardown: () => Promise<void>;
};

// On macOS with Docker Desktop the daemon socket lives at
// `~/.docker/run/docker.sock`, not `/var/run/docker.sock` (which doesn't even
// exist on this host). testcontainers-node's auto-detection looks at the
// non-existent legacy path first and fails to find the daemon unless
// `DOCKER_HOST` points it at the real socket. We set this exactly once, and
// only if the user hasn't overridden it themselves (CI runners or Linux dev
// boxes have a real `/var/run/docker.sock`).
const ensureDockerHost = (): void => {
  if (process.env.DOCKER_HOST) return;
  const desktopSocket = `${process.env.HOME}/.docker/run/docker.sock`;
  process.env.DOCKER_HOST = `unix://${desktopSocket}`;
};

export const setupTestDatabase = async (): Promise<TestDatabase> => {
  ensureDockerHost();
  // Pin the image tag so a Postgres major-version bump in production doesn't
  // silently change what tests run against. Match dev's `postgres:17-alpine`.
  //
  // Wait strategy: the @testcontainers/postgresql default
  // `Wait.forAll([forHealthCheck, forListeningPorts])` deadlocks against
  // `postgres:17-alpine` because that image declares no HEALTHCHECK directive
  // — the health-check strategy never resolves. We replace it with a log-based
  // wait keyed on Postgres's own startup banner. The `times: 2` is important:
  // initdb starts the server once during bootstrap, shuts it down, and starts
  // it again as the real server. We only want to return after the SECOND
  // "ready to accept connections", i.e. the server clients will actually
  // connect to. Returning after the first one races with the initdb shutdown.
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const connectionString = container.getConnectionUri();

  // `max: 1` on a per-test container is intentional: the migrator opens its
  // own connection, the repo functions open another, and we don't want the
  // pool to keep idle connections that prevent `await client.end()` from
  // settling cleanly during teardown.
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  // Apply the same migration directory the dev DB uses. `migrationsFolder` is
  // resolved relative to the process cwd (the `backend/` dir when bun test
  // runs), so this path is stable across test files.
  await migrate(db, { migrationsFolder: './drizzle' });

  const teardown = async (): Promise<void> => {
    await client.end({ timeout: 5 });
    await container.stop();
  };

  return { db, container, client, teardown };
};
