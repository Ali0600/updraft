import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { AdminApi, type AssetPayload } from '../api.js';
import { type ExportedFile, type ExportPlatform, parseExportDir } from '../exportDir.js';

const UPLOAD_CONCURRENCY = 4;

export interface PublishPlan {
  /** Unique files across all platforms, keyed by content hash. */
  files: Map<string, ExportedFile>;
  /** Hashes the server reported missing — the only ones to upload. */
  toUpload: string[];
}

/**
 * Decides what actually needs uploading. Pure so it can be tested without a
 * server: dedupe across platforms first (ios and android share most assets),
 * then keep only what the server says it lacks.
 */
export function buildPublishPlan(
  platforms: { launchAsset: ExportedFile; assets: ExportedFile[] }[],
  missingHashes: string[],
): PublishPlan {
  const files = new Map<string, ExportedFile>();
  for (const platform of platforms) {
    for (const file of [platform.launchAsset, ...platform.assets]) {
      if (!files.has(file.sha256Hex)) files.set(file.sha256Hex, file);
    }
  }

  const missing = new Set(missingHashes);
  return { files, toUpload: [...files.keys()].filter((hash) => missing.has(hash)) };
}

export function toAssetPayload(file: ExportedFile): AssetPayload {
  return {
    sha256Hex: file.sha256Hex,
    key: file.key,
    contentType: file.contentType,
    fileExtension: file.fileExtension,
  };
}

function detectGitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

async function uploadMissing(
  api: AdminApi,
  plan: PublishPlan,
  log: (line: string) => void,
): Promise<number> {
  let uploadedBytes = 0;
  const queue = [...plan.toUpload];

  async function worker(): Promise<void> {
    for (let hash = queue.shift(); hash !== undefined; hash = queue.shift()) {
      const file = plan.files.get(hash);
      if (!file) throw new Error(`plan lists ${hash} but no file carries it`);
      await api.uploadAsset(hash, file.bytes);
      uploadedBytes += file.sizeBytes;
      log(`  uploaded ${file.path} (${formatBytes(file.sizeBytes)})`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, () => worker()),
  );
  return uploadedBytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PublishOptions {
  dir: string;
  server: string;
  app: string;
  channel: string;
  runtimeVersion: string;
  platforms?: ExportPlatform[] | undefined;
  expoConfig?: string | undefined;
  gitCommit?: string | undefined;
  publishedBy?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

/** The whole publish flow; exported so tests and the action can drive it directly. */
export async function publish(options: PublishOptions): Promise<{ groupId: string }> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const parsed = parseExportDir(options.dir, {
    platforms: options.platforms,
    expoConfigPath: options.expoConfig,
  });
  const platformNames = parsed.platforms.map((platform) => platform.platform);
  log(`export contains: ${platformNames.join(', ')}`);

  const api = new AdminApi(options.server);

  const allHashes = [
    ...new Set(
      parsed.platforms.flatMap((platform) =>
        [platform.launchAsset, ...platform.assets].map((file) => file.sha256Hex),
      ),
    ),
  ];
  const missing = await api.checkAssets(allHashes);
  const plan = buildPublishPlan(parsed.platforms, missing);
  log(
    `${plan.files.size} unique file(s); ${plan.toUpload.length} to upload, ` +
      `${plan.files.size - plan.toUpload.length} already on the server`,
  );

  const uploadedBytes = await uploadMissing(api, plan, log);
  if (plan.toUpload.length > 0) log(`uploaded ${formatBytes(uploadedBytes)}`);

  // One groupId ties the per-platform rows into a single logical publish, so
  // rollback/republish/disable treat them as a unit.
  const groupId = randomUUID();
  const gitCommit = options.gitCommit ?? detectGitCommit();
  const publishedBy = options.publishedBy ?? process.env.USER;

  for (const platform of parsed.platforms) {
    const update = await api.createUpdate({
      appSlug: options.app,
      channelName: options.channel,
      platform: platform.platform,
      runtimeVersion: options.runtimeVersion,
      launchAsset: toAssetPayload(platform.launchAsset),
      assets: platform.assets.map(toAssetPayload),
      metadata: {},
      ...(parsed.expoConfig ? { extra: { expoClient: parsed.expoConfig } } : {}),
      groupId,
      ...(gitCommit ? { gitCommit } : {}),
      ...(publishedBy ? { publishedBy } : {}),
    });
    log(`published ${platform.platform}: update ${update.id}`);
  }

  log(`done — group ${groupId} on channel '${options.channel}'`);
  return { groupId };
}

export function publishCommand(): Command {
  return new Command('publish')
    .description('publish an `npx expo export` output directory as an update')
    .requiredOption('-d, --dir <dir>', 'the expo export output directory (dist)')
    .requiredOption('-s, --server <url>', 'update server origin')
    .requiredOption('-a, --app <slug>', 'app slug on the server')
    .requiredOption('-c, --channel <name>', 'channel to publish to')
    .requiredOption('-r, --runtime-version <version>', 'runtime version this update targets')
    .option('-p, --platforms <list>', 'comma-separated subset (default: all in the export)')
    .option('--expo-config <path>', 'expoConfig.json path (default: <dir>/expoConfig.json)')
    .option('--git-commit <sha>', 'recorded with the update (default: git rev-parse HEAD)')
    .option('--published-by <name>', 'recorded with the update (default: $USER)')
    .action(
      async (options: {
        dir: string;
        server: string;
        app: string;
        channel: string;
        runtimeVersion: string;
        platforms?: string;
        expoConfig?: string;
        gitCommit?: string;
        publishedBy?: string;
      }) => {
        await publish({
          dir: options.dir,
          server: options.server,
          app: options.app,
          channel: options.channel,
          runtimeVersion: options.runtimeVersion,
          platforms: options.platforms?.split(',').map((value) => value.trim()) as
            | ExportPlatform[]
            | undefined,
          expoConfig: options.expoConfig,
          gitCommit: options.gitCommit,
          publishedBy: options.publishedBy,
        });
      },
    );
}
