import {
  createCipheriv,
  createHash,
  createPublicKey,
  constants,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const NATIVE_TEST_ACCOUNT_AAD = 'boardsesh-native-test-account:v1';
export const NATIVE_TEST_ACCOUNT_KIND = 'boardsesh-native-test-account';
export const NATIVE_TEST_RECIPIENT_SHA256 = '86464ec8651d001d12939ec5b897b64ab08efcf10a37783a0f9c03840ecb38fd';
export const NATIVE_TEST_FIELDS = ['SCREENSHOT_USER_EMAIL', 'SCREENSHOT_USER_PASSWORD'] as const;
const recipientPath = new URL('./lib/native-test-account-recipient.pem', import.meta.url);

export type NativeTestAccount = { SCREENSHOT_USER_EMAIL: string; SCREENSHOT_USER_PASSWORD: string };

export function readNativeTestAccount(environment: NodeJS.ProcessEnv): NativeTestAccount {
  const email = environment.SCREENSHOT_USER_EMAIL;
  const password = environment.SCREENSHOT_USER_PASSWORD;
  if (email !== 'test@boardsesh.com' || !password || password.length > 128 || /[^\x20-\x7e]/.test(password)) {
    throw new Error('The dedicated native test account and a printable 1–128 character password are required.');
  }
  return { SCREENSHOT_USER_EMAIL: email, SCREENSHOT_USER_PASSWORD: password };
}

function publicRecipientSha256(recipient: KeyObject): string {
  if (
    recipient.type !== 'public' ||
    recipient.asymmetricKeyType !== 'rsa' ||
    recipient.asymmetricKeyDetails?.modulusLength !== 4096
  ) {
    throw new Error('An RSA4096 public recipient is required.');
  }
  return createHash('sha256')
    .update(recipient.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function readPinnedNativeTestRecipient(publicKeyPem: string): KeyObject {
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKeyPem) || publicKeyPem.includes('PRIVATE KEY')) {
    throw new Error('The fixed public recipient is required.');
  }
  const recipient = createPublicKey(publicKeyPem);
  if (publicRecipientSha256(recipient) !== NATIVE_TEST_RECIPIENT_SHA256) {
    throw new Error('The fixed public recipient is required.');
  }
  return recipient;
}

// The CLI always supplies the fixed, hash-checked recipient below. A separate
// pure crypto entry point lets tests prove decryption without the operator key.
export function sealNativeTestAccount(credentials: NativeTestAccount, recipient: KeyObject) {
  const account = readNativeTestAccount(credentials);
  const recipientSha256 = publicRecipientSha256(recipient);
  const encryptionKey = randomBytes(32);
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ kind: NATIVE_TEST_ACCOUNT_KIND, credentials: account }));
  try {
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(NATIVE_TEST_ACCOUNT_AAD));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = publicEncrypt(
      { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encryptionKey,
    );
    return {
      version: 1,
      algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
      recipientSha256,
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
  const outputPath = environment.NATIVE_TEST_ACCOUNT_OUTPUT;
  if (!outputPath) throw new Error('An encrypted output path is required.');
  const account = readNativeTestAccount(environment);
  const recipient = readPinnedNativeTestRecipient(await readFile(recipientPath, 'utf8'));
  const sealed = sealNativeTestAccount(account, recipient);
  await writeFile(outputPath, JSON.stringify(sealed) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Dedicated native test account sealed; only the encrypted artifact may be uploaded.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Native test account handoff failed; secret-bearing details withheld.');
    process.exitCode = 1;
  });
}
