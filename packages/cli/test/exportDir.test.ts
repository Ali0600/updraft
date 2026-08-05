import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportDirError, parseExportDir } from '../src/exportDir.js';

// The same fixture the server's conformance suite publishes.
const FIXTURE = fileURLToPath(new URL('../../server/test/fixtures/export-basic', import.meta.url));

describe('parseExportDir on the checked-in fixture', () => {
  it('reads the platforms the export contains', () => {
    const parsed = parseExportDir(FIXTURE);
    expect(parsed.platforms.map((platform) => platform.platform)).toEqual(['ios']);
  });

  it('computes sha256 and md5 from the actual bytes', () => {
    const parsed = parseExportDir(FIXTURE);
    const bundle = parsed.platforms[0]?.launchAsset;
    const bytes = readFileSync(join(FIXTURE, '_expo/static/js/ios/index.hbc'));

    // Recomputed here from disk — the test never trusts the parser's own math.
    expect(bundle?.sha256Hex).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(bundle?.key).toBe(createHash('md5').update(bytes).digest('hex'));
    expect(bundle?.sizeBytes).toBe(bytes.length);
  });

  it('derives content types from extensions, bundle as javascript', () => {
    const parsed = parseExportDir(FIXTURE);
    expect(parsed.platforms[0]?.launchAsset.contentType).toBe('application/javascript');
    expect(parsed.platforms[0]?.assets[0]?.contentType).toBe('text/plain');
    expect(parsed.platforms[0]?.assets[0]?.fileExtension).toBe('.txt');
  });

  it('rejects a request for a platform the export does not contain', () => {
    expect(() => parseExportDir(FIXTURE, { platforms: ['android'] })).toThrow(ExportDirError);
  });

  it('has no expo config in this fixture', () => {
    expect(parseExportDir(FIXTURE).expoConfig).toBeUndefined();
  });
});

describe('parseExportDir error handling', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'updraft-export-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the missing metadata.json when pointed at a non-export directory', () => {
    expect(() => parseExportDir(dir)).toThrow(/metadata\.json/);
  });

  it('rejects malformed metadata.json rather than guessing', () => {
    writeFileSync(join(dir, 'metadata.json'), '{"version": 7}');
    expect(() => parseExportDir(dir)).toThrow(ExportDirError);
  });

  it('rejects metadata that references a file that is not there', () => {
    writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { ios: { bundle: 'missing.hbc', assets: [] } },
      }),
    );
    expect(() => parseExportDir(dir)).toThrow(/unreadable/);
  });

  it('reads expoConfig.json when present', () => {
    mkdirSync(join(dir, 'bundles'), { recursive: true });
    writeFileSync(join(dir, 'bundles/app.hbc'), 'bundle bytes');
    writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { ios: { bundle: 'bundles/app.hbc', assets: [] } },
      }),
    );
    writeFileSync(join(dir, 'expoConfig.json'), JSON.stringify({ name: 'demo', slug: 'demo' }));

    expect(parseExportDir(dir).expoConfig).toEqual({ name: 'demo', slug: 'demo' });
  });

  it('fails loudly when an explicitly named expo config is absent', () => {
    mkdirSync(join(dir, 'bundles'), { recursive: true });
    writeFileSync(join(dir, 'bundles/app.hbc'), 'bundle bytes');
    writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { ios: { bundle: 'bundles/app.hbc', assets: [] } },
      }),
    );

    expect(() => parseExportDir(dir, { expoConfigPath: join(dir, 'nope.json') })).toThrow(
      /not found/,
    );
  });
});
