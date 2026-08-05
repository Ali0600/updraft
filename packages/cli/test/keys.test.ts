import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appConfigSnippet,
  CERTIFICATE_FILE,
  generateKeys,
  PRIVATE_KEY_FILE,
} from '../src/commands/keys.js';
import { buildProgram } from '../src/index.js';

describe('cli program', () => {
  it('exposes the updraft program name', () => {
    expect(buildProgram().name()).toBe('updraft');
  });

  it('registers the keys command', () => {
    expect(buildProgram().commands.map((command) => command.name())).toContain('keys');
  });
});

describe('keys generate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'updraft-keys-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const options = { commonName: 'Updraft Test', validityYears: 10, keyId: 'main' };

  it('writes a usable key pair and certificate', () => {
    const result = generateKeys({ ...options, outputDir: dir });

    expect(readFileSync(result.privateKeyPath, 'utf8')).toContain('PRIVATE KEY');
    expect(result.certificatePem).toContain('BEGIN CERTIFICATE');

    const certificate = new X509Certificate(result.certificatePem);
    expect(certificate.subject).toContain('Updraft Test');
  });

  it('issues a certificate valid for the requested number of years', () => {
    const result = generateKeys({ ...options, validityYears: 10, outputDir: dir });

    const certificate = new X509Certificate(result.certificatePem);
    const years =
      (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) /
      (365.25 * 24 * 60 * 60 * 1000);

    // Rotation requires a store release, so a short-lived cert would strand users.
    expect(years).toBeGreaterThan(9.5);
  });

  it('writes the private key owner-readable only', () => {
    const result = generateKeys({ ...options, outputDir: dir });
    expect(statSync(result.privateKeyPath).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing private key', () => {
    writeFileSync(join(dir, PRIVATE_KEY_FILE), 'existing key');

    // Overwriting would strand every shipped build that embedded the old cert.
    expect(() => generateKeys({ ...options, outputDir: dir })).toThrow(/already exists/);
    expect(readFileSync(join(dir, PRIVATE_KEY_FILE), 'utf8')).toBe('existing key');
  });

  it('refuses to overwrite an existing certificate', () => {
    writeFileSync(join(dir, CERTIFICATE_FILE), 'existing cert');
    expect(() => generateKeys({ ...options, outputDir: dir })).toThrow(/already exists/);
  });

  it('prints an app config snippet naming the same key id and algorithm', () => {
    const snippet = JSON.parse(appConfigSnippet('main', './certificate.pem'));
    expect(snippet.expo.updates.codeSigningMetadata).toEqual({
      keyid: 'main',
      alg: 'rsa-v1_5-sha256',
    });
  });
});
