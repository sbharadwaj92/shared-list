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
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // HS256 secret for signing access tokens (jose). 32 bytes minimum is the
  // smallest size that doesn't waste entropy against the SHA-256 keyspace —
  // anything shorter is silently weaker. We hard-fail at boot if the env var
  // is missing or too short, rather than letting a dev-default leak into prod.
  JWT_SECRET: z.string().min(32),
  // Access token lifetime. 15 min is the PLAN.md choice: short enough that a
  // stolen access token has a bounded blast radius, long enough that the
  // single-flight refresh path doesn't fire on every other request. Coerced
  // because env vars are strings.
  ACCESS_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 15),
  // Refresh token lifetime. 30 days mirrors typical mobile-app expectations
  // (re-auth roughly monthly if the user goes dormant). Rotation on every
  // /auth/refresh keeps each individual token short-lived in practice.
  REFRESH_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),

  // --- Push delivery (Phase 10) ---
  //
  // Push is opt-in. A solo dev without Apple/Firebase credentials must
  // still be able to `bun run dev` — so the absence of these vars is OK,
  // and the push subsystem becomes a no-op when disabled. When enabled,
  // BOTH the APNs and FCM blocks are required (we can't half-enable
  // pushes; that just deferred-fails on the platform we forgot).
  //
  // `PUSH_ENABLED=true` is the master switch. The boot validator enforces
  // the dependency: if true, all credential vars must be present.

  PUSH_ENABLED: z.coerce.boolean().default(false),

  // APNs (Apple Push Notification service) credentials.
  //   - APNS_TEAM_ID: the Apple Developer team ID (10-char string)
  //   - APNS_KEY_ID: the Key ID assigned to the .p8 (10-char string)
  //   - APNS_PRIVATE_KEY: the contents of the .p8 file (PEM-encoded ES256
  //     private key). Multi-line; in `.env` use \n escapes or a single-
  //     line PEM. We do the unescape at use site, not here, so the
  //     stored value is the raw text and we don't pre-mangle it.
  //   - APNS_BUNDLE_ID: the iOS app bundle id — sent in `apns-topic`
  //     header. APNs rejects pushes whose topic doesn't match the cert
  //     they were sent under, so a typo here causes silent delivery
  //     failures (visible in APNs response).
  //   - APNS_USE_SANDBOX: targets api.sandbox.push.apple.com (true) or
  //     api.push.apple.com (false). Per PLAN.md L391 we use sandbox for
  //     dev — production endpoint requires a production-signed app.
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_USE_SANDBOX: z.coerce.boolean().default(true),

  // FCM (Firebase Cloud Messaging) credentials. The HTTP v1 API uses a
  // service account JSON for OAuth2 token minting. We accept the JSON as
  // a single string (escape newlines in `.env`) and parse at use site.
  //   - FCM_PROJECT_ID is also present inside the service account JSON
  //     but we surface it as its own var because the v1 URL embeds it,
  //     and forcing a JSON.parse just to read it would be silly.
  FCM_PROJECT_ID: z.string().min(1).optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
});

// Cross-field validation: when push is enabled, every credential it
// needs MUST be present. The Zod object-level `.superRefine` is the
// right tool here — running this after the per-field schema parses
// means we already have typed values to assert on.
const envSchemaWithPushGuard = envSchema.superRefine((env, ctx) => {
  if (!env.PUSH_ENABLED) return;
  const required = [
    'APNS_TEAM_ID',
    'APNS_KEY_ID',
    'APNS_PRIVATE_KEY',
    'APNS_BUNDLE_ID',
    'FCM_PROJECT_ID',
    'FCM_SERVICE_ACCOUNT_JSON',
  ] as const;
  for (const key of required) {
    if (!env[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when PUSH_ENABLED=true`,
      });
    }
  }
});

// `Readonly<>` makes the inferred type immutable at compile time — you can't
// accidentally do `config.PORT = 4000` somewhere downstream and silently break
// observability assumptions about which port we're listening on.
export type AppConfig = Readonly<z.infer<typeof envSchema>>;

// `safeParse` returns `{success, data | error}` instead of throwing. We use it
// (over `parse`) because we want to *control* the failure path — print our own
// formatted message and `process.exit(1)`, not surface a Zod stack trace.
const parsed = envSchemaWithPushGuard.safeParse(process.env);

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
