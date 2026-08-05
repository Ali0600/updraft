import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SIGNATURE_ALGORITHM, serializeSignatureHeader, signBytes } from '@ota/core';
import type { Config } from '../config.js';

export interface Signer {
  /** The keyid clients must name in `expo-expect-signature`. */
  readonly keyId: string;
  /** Returns a complete `expo-signature` header value for these exact bytes. */
  sign(bytes: Buffer | string): string;
}

export class SigningConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningConfigError';
  }
}

/**
 * Builds the signer, or returns undefined when no key is configured.
 *
 * A configured-but-broken key throws: running unsigned because a PEM failed to
 * parse would silently downgrade every client that asked for a signature.
 * Unconfigured is a deliberate choice and stays permitted — only requests that
 * actually demand a signature fail, in the route.
 */
export function createSigner(config: Config): Signer | undefined {
  const pem = loadPrivateKeyPem(config);
  if (!pem) return undefined;

  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new SigningConfigError(
      `code signing key is not a readable private key PEM: ${(error as Error).message}`,
    );
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw new SigningConfigError(
      `code signing key must be RSA (${SIGNATURE_ALGORITHM}), got ${key.asymmetricKeyType ?? 'unknown'}`,
    );
  }

  const keyPem = key.export({ type: 'pkcs8', format: 'pem' }).toString();

  return {
    keyId: config.CODE_SIGNING_KEY_ID,
    sign: (bytes) =>
      serializeSignatureHeader({
        sig: signBytes(bytes, keyPem),
        keyid: config.CODE_SIGNING_KEY_ID,
      }),
  };
}

function loadPrivateKeyPem(config: Config): string | undefined {
  if (config.CODE_SIGNING_PRIVATE_KEY_BASE64) {
    return Buffer.from(config.CODE_SIGNING_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  }

  const path = config.CODE_SIGNING_PRIVATE_KEY_PATH;
  if (!path) return undefined;

  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new SigningConfigError(
      `cannot read code signing key at ${path}: ${(error as Error).message}`,
    );
  }
}
