import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_PUBLISH_TOKEN, testConfig } from './helpers/testConfig.js';

const base = {
  PUBLIC_URL: 'http://localhost:3000',
  PUBLISH_TOKEN: TEST_PUBLISH_TOKEN,
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = testConfig();
    expect(config.PORT).toBe(3000);
    expect(config.STORAGE_DRIVER).toBe('local');
    expect(config.CODE_SIGNING_KEY_ID).toBe('main');
  });

  it('refuses to boot without PUBLISH_TOKEN', () => {
    expect(() => loadConfig({ PUBLIC_URL: base.PUBLIC_URL })).toThrow(/PUBLISH_TOKEN/);
  });

  it('refuses a PUBLISH_TOKEN shorter than 32 characters', () => {
    expect(() => loadConfig({ ...base, PUBLISH_TOKEN: 'short' })).toThrow(/PUBLISH_TOKEN/);
  });

  it('refuses to boot without PUBLIC_URL, which asset URLs are built from', () => {
    expect(() => loadConfig({ PUBLISH_TOKEN: base.PUBLISH_TOKEN })).toThrow(/PUBLIC_URL/);
  });

  it('rejects a PUBLIC_URL that is not a URL', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'localhost:3000' })).toThrow(/PUBLIC_URL/);
  });

  it('strips trailing slashes from PUBLIC_URL so asset URLs never double up', () => {
    expect(testConfig({ PUBLIC_URL: 'http://localhost:3000///' }).PUBLIC_URL).toBe(
      'http://localhost:3000',
    );
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('loadConfig: S3 storage', () => {
  it('refuses STORAGE_DRIVER=s3 without a bucket', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });

  it('accepts STORAGE_DRIVER=s3 with a bucket', () => {
    const config = loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'updates' });
    expect(config.S3_BUCKET).toBe('updates');
    expect(config.S3_REGION).toBe('us-east-1');
  });

  it.each([
    ['S3_ACCESS_KEY_ID', { S3_ACCESS_KEY_ID: 'key' }],
    ['S3_SECRET_ACCESS_KEY', { S3_SECRET_ACCESS_KEY: 'secret' }],
  ])('refuses %s without its pair', (_label, half) => {
    // Half a credential is never intentional, and without this the AWS
    // provider chain silently falls back to ambient credentials.
    expect(() =>
      loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'updates', ...half }),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('accepts neither credential, which is the IAM-role path', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'updates' })).not.toThrow();
  });

  it('rejects an S3_ENDPOINT that is not an http(s) URL', () => {
    expect(() =>
      loadConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'minio:9000' }),
    ).toThrow(/S3_ENDPOINT/);
  });

  it('rejects an ASSETS_BASE_URL that is not an http(s) URL', () => {
    expect(() => loadConfig({ ...base, ASSETS_BASE_URL: 'cdn.example.com' })).toThrow(
      /ASSETS_BASE_URL/,
    );
    expect(() => loadConfig({ ...base, ASSETS_BASE_URL: 'javascript:alert(1)' })).toThrow(
      /ASSETS_BASE_URL/,
    );
  });

  it('strips trailing slashes from ASSETS_BASE_URL, like PUBLIC_URL', () => {
    expect(
      loadConfig({ ...base, ASSETS_BASE_URL: 'https://cdn.example.com//' }).ASSETS_BASE_URL,
    ).toBe('https://cdn.example.com');
  });
});
