import { z } from 'zod';

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
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, '')),

  DB_PATH: z.string().min(1).default('./data/db.sqlite'),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./data/blobs'),

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
    .safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
