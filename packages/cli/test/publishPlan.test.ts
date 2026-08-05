import { describe, expect, it } from 'vitest';
import { buildPublishPlan, toAssetPayload } from '../src/commands/publish.js';
import type { ExportedFile } from '../src/exportDir.js';

function file(name: string, hash: string): ExportedFile {
  return {
    path: name,
    sha256Hex: hash,
    key: `md5-${hash}`,
    contentType: 'application/octet-stream',
    fileExtension: '.bin',
    sizeBytes: 10,
    bytes: Buffer.from(name),
  };
}

const bundleIos = file('ios/bundle.hbc', 'a'.repeat(64));
const bundleAndroid = file('android/bundle.hbc', 'b'.repeat(64));
const sharedIcon = file('assets/icon.png', 'c'.repeat(64));

describe('buildPublishPlan', () => {
  it('dedupes files shared between platforms', () => {
    const plan = buildPublishPlan(
      [
        { launchAsset: bundleIos, assets: [sharedIcon] },
        { launchAsset: bundleAndroid, assets: [sharedIcon] },
      ],
      [],
    );

    // Three unique files, though four references exist.
    expect(plan.files.size).toBe(3);
  });

  it('uploads only what the server reports missing', () => {
    const plan = buildPublishPlan(
      [
        { launchAsset: bundleIos, assets: [sharedIcon] },
        { launchAsset: bundleAndroid, assets: [sharedIcon] },
      ],
      [bundleAndroid.sha256Hex],
    );

    expect(plan.toUpload).toEqual([bundleAndroid.sha256Hex]);
  });

  it('uploads nothing when the server has everything — the republish fast path', () => {
    const plan = buildPublishPlan([{ launchAsset: bundleIos, assets: [sharedIcon] }], []);
    expect(plan.toUpload).toEqual([]);
  });

  it('ignores hashes the server claims are missing but the export does not contain', () => {
    const plan = buildPublishPlan([{ launchAsset: bundleIos, assets: [] }], ['f'.repeat(64)]);
    expect(plan.toUpload).toEqual([]);
  });
});

describe('toAssetPayload', () => {
  it('sends the content-derived key and hash, never the file path', () => {
    const payload = toAssetPayload(sharedIcon);
    expect(payload).toEqual({
      sha256Hex: sharedIcon.sha256Hex,
      key: sharedIcon.key,
      contentType: 'application/octet-stream',
      fileExtension: '.bin',
    });
    expect(JSON.stringify(payload)).not.toContain('assets/icon.png');
  });
});
