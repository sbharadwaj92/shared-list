import { z } from 'zod';

// Single source of truth for environment input. Zod gives us three things at once:
//   1. Runtime validation — a typo'd or missing var is rejected
//   2. Type inference — `AppConfig` below is derived from this schema
//   3. Defaults — sensible values when an env var is genuinely optional
// `z.coerce.number()` matters because process.env values are always strings;
// without coerce, PORT='3000' would fail z.number() validation.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

// `Readonly<>` makes the inferred type immutable at compile time — you can't
// accidentally do `config.PORT = 4000` somewhere downstream and silently break
// observability assumptions about which port we're listening on.
export type AppConfig = Readonly<z.infer<typeof envSchema>>;

// `safeParse` returns `{success, data | error}` instead of throwing. We use it
// (over `parse`) because we want to *control* the failure path — print our own
// formatted message and `process.exit(1)`, not surface a Zod stack trace.
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly at boot — a typed config that lies is worse than no config.
  // The logger isn't constructed yet (it depends on this module), so console.error
  // is the only signal available; the noConsole rule explicitly allows it.
  console.error('Invalid environment configuration:', parsed.error.format());
  process.exit(1);
}

// `Object.freeze` is the runtime mirror of `Readonly<>`. The type system stops
// most accidental mutations, but `(config as any).PORT = 4000` would still
// succeed at runtime without freeze. Belt and suspenders.
export const config: AppConfig = Object.freeze(parsed.data);
