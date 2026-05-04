import { defineConfig } from 'drizzle-kit';
import { config } from './src/infra/config.ts';

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
