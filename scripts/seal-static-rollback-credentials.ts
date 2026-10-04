import { createCipheriv, createPublicKey, constants, publicEncrypt, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const BACKUP_AAD = 'boardsesh-static-assets-legacy:v1';
export const LEGACY_FIELDS = [
  'STATIC_ASSETS_LEGACY_S3_BUCKET_NAME',
  'STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL',
  'STATIC_ASSETS_LEGACY_AWS_REGION',
  'STATIC_ASSETS_LEGACY_AWS_ACCESS_KEY_ID',
  'STATIC_ASSETS_LEGACY_AWS_SECRET_ACCESS_KEY',
] as const;

export function sealStaticRollbackCredentials(environment: NodeJS.ProcessEnv, publicKeyPem: string) {
  const credentials: Record<string, string> = {};
  for (const name of LEGACY_FIELDS) {
    const credential = environment[name];
    if (!credential?.trim()) throw new Error(`Missing legacy credential: ${name}`);
    credentials[name] = credential;
  }
  const endpoint = new URL(credentials.STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL);
  if (
    credentials.STATIC_ASSETS_LEGACY_S3_BUCKET_NAME !== 'boardsesh-static-assets' ||
    endpoint.protocol !== 'https:' ||
    !['t3.storage.dev', 'fly.storage.tigris.dev'].includes(endpoint.hostname) ||
    endpoint.pathname !== '/' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Backup requires the existing Tigris static-assets credentials.');
  }
  if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n/.test(publicKeyPem.trim()) || publicKeyPem.includes('PRIVATE KEY')) {
    throw new Error('An operator RSA public key is required.');
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error('The operator public key must be RSA with at least 3072 bits.');
  }
  const encryptionKey = randomBytes(32);
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ kind: 'boardsesh-static-assets-legacy', credentials }));
  try {
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(BACKUP_AAD));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encryptionKey,
    );
    return {
      version: 1,
      algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
      wrappedKey: wrappedKey.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    encryptionKey.fill(0);
    plaintext.fill(0);
  }
}

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const publicKey = environment.STATIC_ROLLBACK_BACKUP_PUBLIC_KEY;
  const outputPath = environment.STATIC_ROLLBACK_BACKUP_OUTPUT;
  if (!publicKey || !outputPath) throw new Error('Backup public key and encrypted output path are required.');
  const sealed = sealStaticRollbackCredentials(environment, publicKey);
  await writeFile(outputPath, JSON.stringify(sealed) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Legacy static-assets rollback credentials sealed; only the encrypted artifact may be uploaded.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Legacy static-assets credential backup failed; secret-bearing details withheld.');
    process.exitCode = 1;
  });
}
