import { z } from 'zod';

/**
 * The ONLY module that reads process.env. Validated once at boot: a missing,
 * malformed or insecure variable crashes the process with a precise message.
 */
const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Reverse proxies in front of the API (load balancer = 1). Drives req.ip. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    DATABASE_URL: z.url(),

    /** Public URL of this API (Google redirects back here). */
    API_URL: z.url(),
    /** Public URL of the website (CORS origin, post-login redirect). */
    WEBSITE_URL: z.url(),
    CORS_EXTRA_ORIGINS: csv,

    /** HMAC key for the OAuth state cookie and checkout signatures. ≥ 32 random chars. */
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SESSION_IDLE_DAYS: z.coerce.number().int().positive().default(7),
    /** Admin actions require a sign-in younger than this. */
    ADMIN_RECENT_AUTH_HOURS: z.coerce.number().int().positive().default(12),
    /** Emails granted the admin role on Google sign-in (bootstrap; manage the rest via the API). */
    ADMIN_EMAILS: csv.transform((emails) => emails.map((e) => e.toLowerCase())),

    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),

    PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
    PADDLE_API_KEY: z.string().min(1),
    PADDLE_WEBHOOK_SECRET: z.string().min(1),
    /** Client-side token for Paddle.js on the website (public by design). */
    PADDLE_CLIENT_TOKEN: z.string().min(1),
    /** Only accept webhooks from Paddle's published IPs (api.paddle.com/ips). */
    PADDLE_WEBHOOK_IP_ALLOWLIST: bool.optional(),

    /** Ed25519 keypair (PEM; \n-escaped allowed) for signing license tokens. */
    LICENSE_SIGNING_PRIVATE_KEY: z.string().min(1),
    LICENSE_SIGNING_PUBLIC_KEY: z.string().min(1),
    LICENSE_SIGNING_KEY_ID: z.string().min(1).default('k1'),
    LICENSE_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
    LICENSE_MAX_DEVICES: z.coerce.number().int().positive().default(3),
    /** Days access survives while a renewal payment is past_due (Paddle retries the card). */
    PAST_DUE_GRACE_DAYS: z.coerce.number().int().min(0).default(7),
    /** Apply scheduled downgrades this long before the period ends (before Paddle renews). */
    DOWNGRADE_APPLY_LEAD_MINUTES: z.coerce.number().int().positive().default(60),

    MAIL_FROM: z.string().min(1).default('Stackroost <hello@stackroost.dev>'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Production refuses insecure configurations instead of running with them.
    for (const key of ['API_URL', 'WEBSITE_URL'] as const) {
      if (!env[key].startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must be https in production' });
      }
    }
    if (env.PADDLE_ENV === 'production' && !env.PADDLE_API_KEY.startsWith('pdl_live_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PADDLE_API_KEY'],
        message: 'expected a live key (pdl_live_…)',
      });
    }
    if (env.PADDLE_WEBHOOK_IP_ALLOWLIST === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['PADDLE_WEBHOOK_IP_ALLOWLIST'],
        message: 'must stay enabled in production',
      });
    }
  });

type Parsed = z.infer<typeof schema>;
export type Env = Omit<Parsed, 'PADDLE_WEBHOOK_IP_ALLOWLIST'> & {
  PADDLE_WEBHOOK_IP_ALLOWLIST: boolean;
};

const unescapePem = (pem: string) => pem.replace(/\\n/g, '\n');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  return {
    ...env,
    // Default: on in production, off elsewhere (local tunnels have no fixed IP).
    PADDLE_WEBHOOK_IP_ALLOWLIST: env.PADDLE_WEBHOOK_IP_ALLOWLIST ?? env.NODE_ENV === 'production',
    LICENSE_SIGNING_PRIVATE_KEY: unescapePem(env.LICENSE_SIGNING_PRIVATE_KEY),
    LICENSE_SIGNING_PUBLIC_KEY: unescapePem(env.LICENSE_SIGNING_PUBLIC_KEY),
  };
}
