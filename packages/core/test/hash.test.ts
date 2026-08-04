import { describe, expect, it } from 'vitest';
import { hexToBase64Url, isSha256Hex, sha256Base64Url, sha256Hex } from '../src/hash.js';

// Known-answer vectors: SHA-256 of the empty string and of "abc".
const EMPTY_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  it('matches known SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe(EMPTY_HEX);
    expect(sha256Hex('abc')).toBe(ABC_HEX);
  });

  it('hashes Buffers and strings identically', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(sha256Hex('abc'));
  });
});

describe('sha256Base64Url', () => {
  it('produces unpadded base64url, as the protocol requires', () => {
    const hash = sha256Base64Url('abc');
    expect(hash).not.toContain('=');
    expect(hash).not.toContain('+');
    expect(hash).not.toContain('/');
    expect(hash).toBe(hexToBase64Url(ABC_HEX));
  });
});

describe('hexToBase64Url', () => {
  it('round-trips back to the same digest bytes', () => {
    expect(Buffer.from(hexToBase64Url(ABC_HEX), 'base64url').toString('hex')).toBe(ABC_HEX);
  });

  it('rejects anything that is not a 64-char lowercase hex digest', () => {
    expect(() => hexToBase64Url(ABC_HEX.toUpperCase())).toThrow();
    expect(() => hexToBase64Url(ABC_HEX.slice(0, 63))).toThrow();
    expect(() => hexToBase64Url('../../etc/passwd')).toThrow();
  });
});

describe('isSha256Hex', () => {
  it('accepts only 64-char lowercase hex', () => {
    expect(isSha256Hex(ABC_HEX)).toBe(true);
    expect(isSha256Hex(ABC_HEX.toUpperCase())).toBe(false);
    expect(isSha256Hex(`${ABC_HEX}0`)).toBe(false);
    expect(isSha256Hex(ABC_HEX.slice(0, 63))).toBe(false);
    expect(isSha256Hex('../../../etc/passwd')).toBe(false);
    expect(isSha256Hex(`${ABC_HEX}\n`)).toBe(false);
  });
});
