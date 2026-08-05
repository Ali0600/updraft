import { parseSignatureHeader, verifyBytes } from '@ota/core';
import { md, pki } from 'node-forge';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { SigningConfigError } from '../../src/services/signer.js';
import {
  clientHeaders,
  expectNoUpdateAvailable,
  parseSinglePart,
  publishFixture,
} from '../helpers/publishFixture.js';
import { createTestApp, type TestHarness } from '../helpers/testApp.js';
import { testConfig } from '../helpers/testConfig.js';
import { generateTestKeys } from '../helpers/testKeys.js';

// RSA generation is slow; one key pair serves the whole file.
let keys: ReturnType<typeof generateTestKeys>;
beforeAll(() => {
  keys = generateTestKeys();
});

const KEY_ID = 'main';
const EXPECT_SIGNATURE = `sig, keyid="${KEY_ID}", alg="rsa-v1_5-sha256"`;

function signingEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CODE_SIGNING_PRIVATE_KEY_BASE64: Buffer.from(keys.privateKeyPem, 'utf8').toString('base64'),
    CODE_SIGNING_KEY_ID: KEY_ID,
    ...overrides,
  };
}

/**
 * Verifies with node-forge rather than node:crypto — a different
 * implementation than the one that produced the signature, which is the point.
 * The device runs its own verifier too, so a signature only our own code can
 * check would prove nothing.
 */
function verifyWithForge(
  payload: string,
  signatureBase64: string,
  certificatePem: string,
): boolean {
  const certificate = pki.certificateFromPem(certificatePem);
  const digest = md.sha256.create();
  digest.update(payload, 'utf8');
  return (certificate.publicKey as pki.rsa.PublicKey).verify(
    digest.digest().bytes(),
    Buffer.from(signatureBase64, 'base64').toString('binary'),
  );
}

describe('code signing', () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  describe('when a key is configured and the client asks for a signature', () => {
    it('signs the manifest over the exact bytes it sends', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': EXPECT_SIGNATURE }),
      });

      expect(response.statusCode).toBe(200);
      const part = parseSinglePart(response);

      const header = parseSignatureHeader(part.headers['expo-signature'] ?? '');
      expect(header?.keyid).toBe(KEY_ID);

      // The bytes verified are the part body as received, not a re-serialization.
      expect(verifyBytes(part.body, header?.sig ?? '', keys.certificatePem)).toBe(true);
    });

    it('produces a signature a different implementation also accepts', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': EXPECT_SIGNATURE }),
      });

      const part = parseSinglePart(response);
      const header = parseSignatureHeader(part.headers['expo-signature'] ?? '');

      expect(verifyWithForge(part.body, header?.sig ?? '', keys.certificatePem)).toBe(true);
    });

    it('produces a signature that fails if a single byte of the body changes', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': EXPECT_SIGNATURE }),
      });

      const part = parseSinglePart(response);
      const header = parseSignatureHeader(part.headers['expo-signature'] ?? '');
      const tampered = part.body.replace('"runtimeVersion":"1.0.0"', '"runtimeVersion":"9.9.9"');

      expect(tampered).not.toBe(part.body);
      expect(verifyBytes(tampered, header?.sig ?? '', keys.certificatePem)).toBe(false);
    });

    it('puts the signature on the part, not on the HTTP response', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': EXPECT_SIGNATURE }),
      });

      expect(parseSinglePart(response).headers['expo-signature']).toBeDefined();
      expect(response.headers['expo-signature']).toBeUndefined();
    });

    it('signs directives too, so "nothing to apply" is authenticated', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app, { runtimeVersion: '1.0.0' });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({
          'expo-runtime-version': '2.0.0',
          'expo-expect-signature': EXPECT_SIGNATURE,
        }),
      });

      const part = expectNoUpdateAvailable(response);
      const header = parseSignatureHeader(part.headers['expo-signature'] ?? '');
      expect(verifyBytes(part.body, header?.sig ?? '', keys.certificatePem)).toBe(true);
    });

    it('signs the body and uses response headers for the bare JSON envelope', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({
          accept: 'application/expo+json',
          'expo-expect-signature': EXPECT_SIGNATURE,
        }),
      });

      expect(response.statusCode).toBe(200);
      const header = parseSignatureHeader(response.headers['expo-signature'] as string);
      expect(verifyBytes(response.body, header?.sig ?? '', keys.certificatePem)).toBe(true);
    });
  });

  describe('fail-closed behaviour', () => {
    it('refuses with 400 when signing is requested but no key is configured', async () => {
      harness = await createTestApp();
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': EXPECT_SIGNATURE }),
      });

      // Never an unsigned 200: that would silently downgrade the client.
      expect(response.statusCode).toBe(400);
    });

    it('refuses with 400 when the client asks for a keyid we do not hold', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': 'sig, keyid="rotated-away"' }),
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses with 400 for an algorithm we cannot produce', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({
          'expo-expect-signature': `sig, keyid="${KEY_ID}", alg="ed25519"`,
        }),
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses with 400 for a malformed expo-expect-signature', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders({ 'expo-expect-signature': 'not a dictionary "' }),
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('when the client does not ask for a signature', () => {
    it('serves an unsigned manifest even though a key is configured', async () => {
      harness = await createTestApp(signingEnv());
      await publishFixture(harness.app);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/manifest/demo',
        headers: clientHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expect(parseSinglePart(response).headers['expo-signature']).toBeUndefined();
    });
  });

  describe('boot-time key validation', () => {
    it('refuses to start when the key file does not exist', async () => {
      await expect(
        buildApp({
          config: testConfig({ CODE_SIGNING_PRIVATE_KEY_PATH: '/nonexistent/private-key.pem' }),
        }),
      ).rejects.toThrow(SigningConfigError);
    });

    it('refuses to start when the configured key is not a valid PEM', async () => {
      await expect(
        buildApp({
          config: testConfig({
            CODE_SIGNING_PRIVATE_KEY_BASE64: Buffer.from('not a key', 'utf8').toString('base64'),
          }),
        }),
      ).rejects.toThrow(SigningConfigError);
    });

    it('rejects configuring both key sources rather than silently preferring one', () => {
      expect(() =>
        testConfig({
          CODE_SIGNING_PRIVATE_KEY_PATH: './certs/private-key.pem',
          CODE_SIGNING_PRIVATE_KEY_BASE64: 'Zm9v',
        }),
      ).toThrow(/not both/);
    });

    it('accepts a key supplied as a file path', async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const dir = mkdtempSync(join(tmpdir(), 'updraft-keys-'));
      const keyPath = join(dir, 'private-key.pem');
      writeFileSync(keyPath, keys.privateKeyPem);

      try {
        harness = await createTestApp({
          CODE_SIGNING_PRIVATE_KEY_PATH: keyPath,
          CODE_SIGNING_KEY_ID: KEY_ID,
        });
        await publishFixture(harness.app);

        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/manifest/demo',
          headers: clientHeaders({ 'expo-expect-signature': EXPECT_SIGNATURE }),
        });

        expect(parseSinglePart(response).headers['expo-signature']).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
