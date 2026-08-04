import { describe, expect, it } from 'vitest';
import { directiveSchema, manifestSchema, rollBackToEmbeddedDirective } from '../src/manifest.js';

const validManifest = {
  id: '0b8a1b4e-1f9a-4c1e-9b4a-3f2b1c0d9e8f',
  createdAt: '2026-08-04T12:00:00.000Z',
  runtimeVersion: '1.0.0',
  launchAsset: {
    hash: 'uNgWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    key: 'bundle.js',
    contentType: 'application/javascript',
    fileExtension: '.js',
    url: 'https://example.com/assets/abc',
  },
  assets: [],
  metadata: {},
};

describe('manifestSchema', () => {
  it('accepts a well-formed manifest', () => {
    expect(manifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it('requires a UUID id', () => {
    expect(manifestSchema.safeParse({ ...validManifest, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('requires an ISO 8601 createdAt', () => {
    expect(manifestSchema.safeParse({ ...validManifest, createdAt: '2026-08-04' }).success).toBe(
      false,
    );
  });

  it('requires absolute asset URLs, since clients cannot resolve relative ones', () => {
    const relative = { ...validManifest.launchAsset, url: '/assets/abc' };
    expect(manifestSchema.safeParse({ ...validManifest, launchAsset: relative }).success).toBe(
      false,
    );
  });
});

describe('rollBackToEmbeddedDirective', () => {
  it('builds a directive carrying commitTime', () => {
    const directive = rollBackToEmbeddedDirective('2026-08-04T12:00:00.000Z');

    expect(directiveSchema.safeParse(directive).success).toBe(true);
    expect(directive.type).toBe('rollBackToEmbedded');
    expect(directive.parameters?.commitTime).toBe('2026-08-04T12:00:00.000Z');
  });
});
