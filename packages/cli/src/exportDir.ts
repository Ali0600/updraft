import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@ota/core';
import mime from 'mime';
import { z } from 'zod';

/** The shape `npx expo export` writes to dist/metadata.json. */
const metadataSchema = z.object({
  version: z.literal(0),
  bundler: z.string(),
  // partialRecord: an export can legitimately contain a single platform; a
  // plain record over an enum key demands every key exist.
  fileMetadata: z.partialRecord(
    z.enum(['ios', 'android']),
    z.object({
      bundle: z.string().min(1),
      assets: z.array(z.object({ path: z.string().min(1), ext: z.string().min(1) })),
    }),
  ),
});

export type ExportPlatform = 'ios' | 'android';

export interface ExportedFile {
  /** Path relative to the export dir, as metadata.json states it. */
  path: string;
  sha256Hex: string;
  /**
   * MD5 hex of the file contents — Metro's asset-key convention. Matching it
   * lets the client recognise assets already embedded in the binary and skip
   * downloading them.
   */
  key: string;
  contentType: string;
  fileExtension: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface PlatformExport {
  platform: ExportPlatform;
  launchAsset: ExportedFile;
  assets: ExportedFile[];
}

export interface ParsedExport {
  platforms: PlatformExport[];
  /** Parsed expoConfig.json when present — becomes manifest extra.expoClient. */
  expoConfig: Record<string, unknown> | undefined;
}

export class ExportDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportDirError';
  }
}

export interface ParseExportDirOptions {
  /** Subset of platforms to publish; defaults to everything in the export. */
  platforms?: ExportPlatform[] | undefined;
  /** Overrides `<dir>/expoConfig.json`. */
  expoConfigPath?: string | undefined;
}

export function parseExportDir(dir: string, options: ParseExportDirOptions = {}): ParsedExport {
  const metadataPath = join(dir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    throw new ExportDirError(
      `${metadataPath} not found — is '${dir}' the output of \`npx expo export\`?`,
    );
  }

  let metadata: z.infer<typeof metadataSchema>;
  try {
    metadata = metadataSchema.parse(JSON.parse(readFileSync(metadataPath, 'utf8')));
  } catch (error) {
    throw new ExportDirError(`could not parse ${metadataPath}: ${(error as Error).message}`);
  }

  const available = Object.keys(metadata.fileMetadata) as ExportPlatform[];
  const wanted = options.platforms?.length ? options.platforms : available;

  const platforms: PlatformExport[] = [];
  for (const platform of wanted) {
    const files = metadata.fileMetadata[platform];
    if (!files) {
      throw new ExportDirError(
        `platform '${platform}' is not in this export (contains: ${available.join(', ')})`,
      );
    }

    platforms.push({
      platform,
      // Hermes exports use .hbc; the protocol still calls the bundle content
      // javascript, matching the reference server.
      launchAsset: readExportedFile(dir, files.bundle, 'application/javascript', '.bundle'),
      assets: files.assets.map((asset) =>
        readExportedFile(
          dir,
          asset.path,
          mime.getType(asset.ext) ?? 'application/octet-stream',
          `.${asset.ext}`,
        ),
      ),
    });
  }

  return { platforms, expoConfig: readExpoConfig(dir, options.expoConfigPath) };
}

function readExportedFile(
  dir: string,
  relativePath: string,
  contentType: string,
  fileExtension: string,
): ExportedFile {
  const absolute = join(dir, relativePath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new ExportDirError(
      `metadata.json references ${relativePath} but it is unreadable: ${(error as Error).message}`,
    );
  }

  return {
    path: relativePath,
    sha256Hex: sha256Hex(bytes),
    key: createHash('md5').update(bytes).digest('hex'),
    contentType,
    fileExtension,
    sizeBytes: bytes.length,
    bytes,
  };
}

function readExpoConfig(
  dir: string,
  overridePath: string | undefined,
): Record<string, unknown> | undefined {
  const path = overridePath ?? join(dir, 'expoConfig.json');
  if (!existsSync(path)) {
    // Optional by design — but an explicitly named file must exist.
    if (overridePath) throw new ExportDirError(`expo config not found at ${overridePath}`);
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ExportDirError(`could not parse ${path}: ${(error as Error).message}`);
  }
}
