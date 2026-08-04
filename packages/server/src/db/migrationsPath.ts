import { fileURLToPath } from 'node:url';

/**
 * Resolved relative to this module so it works from source (src/db/migrations)
 * and from the bundle, where the build copies the folder to dist/migrations.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));
