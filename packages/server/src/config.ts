import { z } from 'zod';

/**
 * Shared so PUBLIC_URL and ASSETS_BASE_URL cannot drift apart. A trailing
 * slash on either produces `https://host//assets/<hex>`, which some CDNs 404
 * and others silently normalise — a bug that appears on one provider only.
 */
const originUrl = () =>
  z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ''));

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Origin the client can reach us at. Asset URLs in manifests are built from
   * it. The protocol check matters: bare `z.url()` accepts "localhost:3000",
   * which parses as scheme `localhost:` and yields unreachable asset URLs.
   */
  PUBLIC_URL: originUrl(),

  DB_PATH: z.string().min(1).default('./data/db.sqlite'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./data/blobs'),

  S3_BUCKET: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ENDPOINT: originUrl().optional(),
  /**
   * MinIO and most self-hosted gateways require path-style addressing; AWS
   * deprecated it. Defaulting off the presence of a custom endpoint makes the
   * common case work with no extra variable, and an explicit value still wins.
   */
  S3_FORCE_PATH_STYLE: z.stringbool().optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /**
   * When set, new manifests point assets at this origin instead of at us. The
   * proxy route stays enabled regardless, because devices in the field already
   * hold manifests addressed to PUBLIC_URL.
   */
  ASSETS_BASE_URL: originUrl().optional(),

  /**
   * Fastify's proxy trust. Unset means "do not trust", which is the
   * fail-closed direction: the rate limiter then keys on the proxy's address
   * and over-limits, rather than letting anyone spoof X-Forwarded-For to get
   * unlimited attempts. Set it only when actually behind a reverse proxy.
   */
  TRUST_PROXY: z.string().min(1).optional(),
  /**
   * Applies to admin and metrics routes only. A real Metro export uploads
   * tens of assets, so this never troubles a legitimate publish while still
   * bounding a runaway loop or a token brute-force.
   */
  RATE_LIMIT_ADMIN_MAX: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  /**
   * Bearer token for every admin/publish route. Required with a real length
   * floor: a short token here is the whole authentication story.
   */
  PUBLISH_TOKEN: z
    .string()
    .min(32, 'PUBLISH_TOKEN must be at least 32 characters (generate with `openssl rand -hex 32`)'),

  /**
   * Code signing key, supplied as a file path (volume mount) or inline base64
   * (platforms that only offer environment variables). Setting both is a
   * configuration error rather than a silent precedence rule — the operator
   * would have no way to tell which key is actually signing.
   */
  CODE_SIGNING_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  CODE_SIGNING_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  CODE_SIGNING_KEY_ID: z.string().min(1).default('main'),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parses configuration, throwing on anything invalid. The server refuses to
 * boot rather than starting in a half-configured state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema
    .refine(
      (config) => !(config.CODE_SIGNING_PRIVATE_KEY_PATH && config.CODE_SIGNING_PRIVATE_KEY_BASE64),
      {
        path: ['CODE_SIGNING_PRIVATE_KEY_PATH'],
        message: 'set CODE_SIGNING_PRIVATE_KEY_PATH or CODE_SIGNING_PRIVATE_KEY_BASE64, not both',
      },
    )
    .refine((config) => config.STORAGE_DRIVER !== 's3' || Boolean(config.S3_BUCKET), {
      path: ['S3_BUCKET'],
      message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
    })
    .refine((config) => Boolean(config.S3_ACCESS_KEY_ID) === Boolean(config.S3_SECRET_ACCESS_KEY), {
      path: ['S3_ACCESS_KEY_ID'],
      // Half a credential is never intentional, and the failure without this
      // check is worse than a boot error: the AWS provider chain quietly
      // falls back to instance metadata or ~/.aws, so the server starts,
      // looks healthy, and writes into whatever bucket those creds reach.
      // Setting neither is legitimate — that is the IAM-role path.
      message: 'set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together, or neither',
    })
    .safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
