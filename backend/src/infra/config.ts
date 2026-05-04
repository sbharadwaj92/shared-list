import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly at boot — a typed config that lies is worse than no config.
  // The logger isn't constructed yet (it depends on this module), so console.error
  // is the only signal available; the noConsole rule explicitly allows it.
  console.error('Invalid environment configuration:', parsed.error.format());
  process.exit(1);
}

export const config: AppConfig = Object.freeze(parsed.data);
