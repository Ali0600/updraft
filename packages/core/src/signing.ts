import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  X509Certificate,
} from 'node:crypto';
import {
  type Dictionary,
  type DictionaryObject,
  parseDictionary,
  serializeDictionary,
} from 'structured-headers';

/** The only algorithm expo-updates supports today. */
export const SIGNATURE_ALGORITHM = 'rsa-v1_5-sha256';

export interface SignatureHeader {
  sig: string;
  keyid: string;
  alg?: string;
}

export interface ExpectedSignature {
  keyid: string;
  alg: string | undefined;
}

/** RSA PKCS#1 v1.5 over SHA-256, base64 — what `expo-signature` carries. */
export function signBytes(bytes: Buffer | string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return createSign('SHA256').update(bytes).end().sign(key, 'base64');
}

/** Verifies against either an X.509 certificate PEM or a bare public key PEM. */
export function verifyBytes(
  bytes: Buffer | string,
  signatureBase64: string,
  certificateOrPublicKeyPem: string,
): boolean {
  const publicKey = certificateOrPublicKeyPem.includes('BEGIN CERTIFICATE')
    ? new X509Certificate(certificateOrPublicKeyPem).publicKey
    : createPublicKey(certificateOrPublicKeyPem);
  return createVerify('SHA256').update(bytes).end().verify(publicKey, signatureBase64, 'base64');
}

export function serializeSignatureHeader({ sig, keyid, alg }: SignatureHeader): string {
  const dict: DictionaryObject = { sig, keyid };
  if (alg) dict.alg = alg;
  return serializeDictionary(dict);
}

/**
 * Parses the client's `expo-expect-signature`. Returns undefined for anything
 * unparseable so callers fail closed rather than signing with a guessed keyid.
 */
export function parseExpectSignatureHeader(header: string): ExpectedSignature | undefined {
  let dict: Dictionary;
  try {
    dict = parseDictionary(header);
  } catch {
    return undefined;
  }

  const keyid = stringMember(dict, 'keyid');
  if (!keyid) return undefined;
  return { keyid, alg: stringMember(dict, 'alg') };
}

function stringMember(dict: Dictionary, key: string): string | undefined {
  // Members are `[BareItem, Parameters]` or `[Item[], Parameters]`; only the
  // former can carry a bare string, so a non-string here is simply absent.
  const value = dict.get(key)?.[0];
  return typeof value === 'string' ? value : undefined;
}
