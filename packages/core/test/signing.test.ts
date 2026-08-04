import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseExpectSignatureHeader,
  serializeSignatureHeader,
  signBytes,
  verifyBytes,
} from '../src/signing.js';

// Generated per run — a private key is never checked into this repo, not even a test one.
function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

describe('signBytes / verifyBytes', () => {
  it('verifies a signature over the exact bytes that were signed', () => {
    const { privateKey, publicKey } = testKeyPair();
    const manifest = JSON.stringify({ id: 'abc' });

    const signature = signBytes(manifest, privateKey);
    expect(verifyBytes(manifest, signature, publicKey)).toBe(true);
  });

  it('rejects a signature when a single byte of the payload changes', () => {
    const { privateKey, publicKey } = testKeyPair();
    const signature = signBytes('{"id":"abc"}', privateKey);

    expect(verifyBytes('{"id":"abd"}', signature, publicKey)).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const signer = testKeyPair();
    const other = testKeyPair();
    const signature = signBytes('payload', signer.privateKey);

    expect(verifyBytes('payload', signature, other.publicKey)).toBe(false);
  });
});

describe('serializeSignatureHeader', () => {
  it('emits a structured-field dictionary the parser accepts back', () => {
    const header = serializeSignatureHeader({ sig: 'YWJj', keyid: 'main' });

    expect(header).toContain('sig=');
    expect(header).toContain('keyid=');

    const parsed = parseExpectSignatureHeader(header);
    expect(parsed?.keyid).toBe('main');
  });

  it('includes alg when given', () => {
    const header = serializeSignatureHeader({ sig: 'YWJj', keyid: 'main', alg: 'rsa-v1_5-sha256' });
    expect(parseExpectSignatureHeader(header)?.alg).toBe('rsa-v1_5-sha256');
  });
});

describe('parseExpectSignatureHeader', () => {
  it('reads keyid and alg from a client header', () => {
    const parsed = parseExpectSignatureHeader('sig, keyid="main", alg="rsa-v1_5-sha256"');
    expect(parsed).toEqual({ keyid: 'main', alg: 'rsa-v1_5-sha256' });
  });

  it('returns undefined for unparseable input rather than guessing', () => {
    expect(parseExpectSignatureHeader('not a dictionary "')).toBeUndefined();
  });

  it('returns undefined when keyid is absent, so callers cannot fall back to a default', () => {
    expect(parseExpectSignatureHeader('sig, alg="rsa-v1_5-sha256"')).toBeUndefined();
  });
});
