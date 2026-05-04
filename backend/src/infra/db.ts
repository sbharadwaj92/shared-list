import { drizzle } from 'drizzle-orm/bun-sql';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { config } from './config.ts';

// Phase 2: client wired; Phase 3 starts using it via the repo layer.
// /health intentionally does not ping the DB; that lives in a future readiness probe.
export const db = drizzle(config.DATABASE_URL);

// Two flavors of Drizzle Postgres client live in this repo:
//   - `bun-sql` driver (production runtime; what `db` above is)
//   - `postgres-js` driver (test runtime, because drizzle-kit's migrator
//     ships only node-style adapters)
// Both are concrete subclasses of `PgDatabase`. Repo functions accept the
// abstract base so the same helper works under either driver without a
// driver-specific overload. `PgQueryResultHKT` is the "any pg result kind"
// marker — there is no driver-agnostic alternative; this is the type Drizzle
// itself uses internally for cross-driver code.
export type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
