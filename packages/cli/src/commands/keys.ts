import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from '@expo/code-signing-certificates';
import { Command } from 'commander';

export const PRIVATE_KEY_FILE = 'private-key.pem';
export const CERTIFICATE_FILE = 'certificate.pem';

export interface GenerateKeysOptions {
  outputDir: string;
  commonName: string;
  validityYears: number;
  keyId: string;
}

export interface GeneratedKeys {
  privateKeyPath: string;
  certificatePath: string;
  certificatePem: string;
}

/**
 * Creates a self-signed code-signing certificate for expo-updates.
 *
 * Self-signed is what the protocol expects here: the certificate is embedded
 * in the app binary and is its own trust root.
 */
export function generateKeys(options: GenerateKeysOptions): GeneratedKeys {
  const outputDir = resolve(options.outputDir);
  const privateKeyPath = join(outputDir, PRIVATE_KEY_FILE);
  const certificatePath = join(outputDir, CERTIFICATE_FILE);

  // Overwriting a private key silently breaks every already-shipped build that
  // embedded the matching certificate, and the old key is unrecoverable.
  for (const path of [privateKeyPath, certificatePath]) {
    if (existsSync(path)) {
      throw new Error(
        `${path} already exists. Refusing to overwrite: shipped apps embed the matching certificate and could never be updated again. Move the existing keys aside first.`,
      );
    }
  }

  const keyPair = generateKeyPair();
  const validityNotBefore = new Date();
  const validityNotAfter = new Date(validityNotBefore);
  // Rotating the key requires an app-store release, so a short expiry would
  // strand users on old binaries.
  validityNotAfter.setFullYear(validityNotAfter.getFullYear() + options.validityYears);

  const certificate = generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore,
    validityNotAfter,
    commonName: options.commonName,
  });

  const { privateKeyPEM } = convertKeyPairToPEM(keyPair);
  const certificatePem = convertCertificateToCertificatePEM(certificate);

  mkdirSync(outputDir, { recursive: true });
  // Owner-only: this file is the entire authority to publish updates.
  writeFileSync(privateKeyPath, privateKeyPEM, { mode: 0o600 });
  writeFileSync(certificatePath, certificatePem, { mode: 0o644 });

  return { privateKeyPath, certificatePath, certificatePem };
}

export function appConfigSnippet(keyId: string, certificatePath: string): string {
  return JSON.stringify(
    {
      expo: {
        updates: {
          url: 'https://your-server.example.com/api/manifest/your-app',
          codeSigningCertificate: certificatePath,
          codeSigningMetadata: { keyid: keyId, alg: 'rsa-v1_5-sha256' },
          requestHeaders: { 'expo-channel-name': 'production' },
        },
      },
    },
    null,
    2,
  );
}

export function keysCommand(): Command {
  const keys = new Command('keys').description('manage code signing keys');

  keys
    .command('generate')
    .description('generate a self-signed code signing certificate and private key')
    .option('-o, --output <dir>', 'directory to write the key pair into', './certs')
    .option('--common-name <name>', 'certificate common name', 'Updraft')
    .option('--validity-years <years>', 'certificate validity in years', '10')
    .option('--key-id <id>', 'key id clients will request', 'main')
    .action(
      (options: { output: string; commonName: string; validityYears: string; keyId: string }) => {
        const validityYears = Number(options.validityYears);
        if (!Number.isInteger(validityYears) || validityYears < 1) {
          throw new Error('--validity-years must be a positive integer');
        }

        const result = generateKeys({
          outputDir: options.output,
          commonName: options.commonName,
          validityYears,
          keyId: options.keyId,
        });

        process.stdout.write(
          [
            `Wrote ${result.privateKeyPath} (mode 0600)`,
            `Wrote ${result.certificatePath}`,
            '',
            'Keep the private key out of version control and off the app.',
            'Give it to the server as CODE_SIGNING_PRIVATE_KEY_PATH (or _BASE64).',
            '',
            'Embed the certificate in your app config:',
            '',
            appConfigSnippet(options.keyId, `./${CERTIFICATE_FILE}`),
            '',
            'Rotating this key needs an app-store release, since the certificate',
            'ships inside the binary.',
            '',
          ].join('\n'),
        );
      },
    );

  return keys;
}
