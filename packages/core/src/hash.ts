import { createHash } from 'node:crypto';

/** Lowercase hex SHA-256. Used as the content-addressed storage key. */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Base64URL SHA-256 without padding — the encoding the Expo Updates protocol
 * requires for the `hash` field of every asset in a manifest.
 */
export function sha256Base64Url(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('base64url');
}

export function hexToBase64Url(hex: string): string {
  if (!isSha256Hex(hex)) {
    throw new Error('hexToBase64Url: expected a 64-character lowercase hex SHA-256');
  }
  return Buffer.from(hex, 'hex').toString('base64url');
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Guards every path that turns client input into a storage key. Deliberately
 * rejects uppercase hex so one blob can never be addressed by two keys.
 */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}
