import { drizzle } from 'drizzle-orm/bun-sql';
import { config } from './config.ts';

// Phase 2: client wired but no schema yet — Phase 3 introduces tables and queries.
// /health intentionally does not ping the DB; that lives in a future readiness probe.
export const db = drizzle(config.DATABASE_URL);

export type Database = typeof db;
