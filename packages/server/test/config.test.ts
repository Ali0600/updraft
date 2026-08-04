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
