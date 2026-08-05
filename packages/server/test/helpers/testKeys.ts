import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from '@expo/code-signing-certificates';

export interface TestKeys {
  privateKeyPem: string;
  publicKeyPem: string;
  certificatePem: string;
}

/**
 * Generates a real expo-updates code-signing certificate at test time.
 *
 * Never a checked-in key, even a "test" one: the habit of not having private
 * keys in the repo is worth more than the second this costs. RSA generation is
 * slow, so callers should hoist this to module scope and share it.
 */
export function generateTestKeys(commonName = 'updraft-test'): TestKeys {
  const keyPair = generateKeyPair();
  const validityNotBefore = new Date();
  const validityNotAfter = new Date(validityNotBefore.getTime() + 24 * 60 * 60 * 1000);

  const certificate = generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore,
    validityNotAfter,
    commonName,
  });

  const { privateKeyPEM, publicKeyPEM } = convertKeyPairToPEM(keyPair);
  return {
    privateKeyPem: privateKeyPEM,
    publicKeyPem: publicKeyPEM,
    certificatePem: convertCertificateToCertificatePEM(certificate),
  };
}
