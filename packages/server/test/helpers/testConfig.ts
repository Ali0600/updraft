import { type Config, loadConfig } from '../../src/config.js';

export const TEST_PUBLISH_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

/** Minimal valid environment, so each test only states what it actually varies. */
export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_URL: 'http://localhost:3000',
    PUBLISH_TOKEN: TEST_PUBLISH_TOKEN,
    ...overrides,
  });
}
