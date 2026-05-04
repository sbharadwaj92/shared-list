import { defineConfig } from 'drizzle-kit';
import { config } from './src/infra/config.ts';

// Drizzle Kit (the migration CLI) requires a *default* export for its config —
// it imports this file dynamically and looks for `module.default`. That's why
// our Biome rule `noDefaultExport: error` has a per-file override for this
// file in `biome.json`. The default-export rule is good in app code because
// named exports are easier to grep; tooling configs are the legitimate exception.
//
// `schema` points to the file Drizzle introspects to detect changes — it doesn't
// exist yet (Phase 3 introduces it) but Drizzle Kit only reads this path when
// you run `db:generate`, so a missing file isn't an error today.
//
// `strict: true` makes Drizzle Kit refuse silent migrations — every generation
// is paused for a confirmation prompt. `verbose: true` prints the SQL it
// produces so we can read migrations before applying them. Both are learning
// affordances: production teams often run drizzle non-interactively, but here
// the goal is to *see* what the tool is doing.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infra/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: config.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
