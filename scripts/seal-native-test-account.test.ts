import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_TEST_ACCOUNT_AAD,
  NATIVE_TEST_ACCOUNT_KIND,
  NATIVE_TEST_RECIPIENT_SHA256,
  main,
  readNativeTestAccount,
  readPinnedNativeTestRecipient,
  sealNativeTestAccount,
} from './seal-native-test-account';

const operator = generateKeyPairSync('rsa', { modulusLength: 4096 });
const credentials = {
  SCREENSHOT_USER_EMAIL: 'test@boardsesh.com',
  SCREENSHOT_USER_PASSWORD: 'synthetic-QA-password-% !',
};
type Envelope = ReturnType<typeof sealNativeTestAccount>;

function unwrap(envelope: Envelope, privateKey: KeyObject = operator.privateKey): Buffer {
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.wrappedKey, 'base64'),
  );
}

function decrypt(envelope: Envelope, aad = NATIVE_TEST_ACCOUNT_AAD): unknown {
  const encryptionKey = unwrap(envelope);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  try {
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString(),
    );
  } finally {
    encryptionKey.fill(0);
  }
}

describe('dedicated native test account handoff', () => {
  it('encrypts exactly two fields using authenticated AES256 and RSA4096 OAEP SHA256', () => {
    const account = readNativeTestAccount({ ...credentials, UNRELATED_SECRET: 'excluded-canary-secret' });
    const sealed = sealNativeTestAccount(account, operator.publicKey);
    expect(decrypt(sealed)).toEqual({ kind: NATIVE_TEST_ACCOUNT_KIND, credentials });
    expect(unwrap(sealed)).toHaveLength(32);
    expect(Buffer.from(sealed.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(sealed.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(sealed.wrappedKey, 'base64')).toHaveLength(512);
    for (const canary of [
      credentials.SCREENSHOT_USER_EMAIL,
      credentials.SCREENSHOT_USER_PASSWORD,
      'excluded-canary-secret',
    ]) {
      expect(JSON.stringify(sealed)).not.toContain(canary);
    }
  });

  it.each(['ciphertext', 'tag', 'wrappedKey', 'nonce'] as const)('rejects modified %s', (field) => {
    const sealed = sealNativeTestAccount(credentials, operator.publicKey);
    const corrupt = Buffer.from(sealed[field], 'base64');
    corrupt[0] ^= 1;
    expect(() => decrypt({ ...sealed, [field]: corrupt.toString('base64') })).toThrow();
  });

  it('rejects another backup kind and a different private key', () => {
    const sealed = sealNativeTestAccount(credentials, operator.publicKey);
    expect(() => decrypt(sealed, 'boardsesh-static-assets-legacy:v1')).toThrow();
    const otherOperator = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => unwrap(sealed, otherOperator.privateKey)).toThrow();
  });

  it('generates fresh encryption keys and nonces', () => {
    const first = sealNativeTestAccount(credentials, operator.publicKey);
    const second = sealNativeTestAccount(credentials, operator.publicKey);
    expect(first.nonce).not.toBe(second.nonce);
    expect(unwrap(first)).not.toEqual(unwrap(second));
    expect(decrypt(first)).toEqual(decrypt(second));
  });

  it.each([undefined, '', 'personal@example.com', 'Test@boardsesh.com', 'test@boardsesh.com\n', ' test@boardsesh.com'])(
    'refuses another or missing account %s',
    (email) => {
      expect(() => readNativeTestAccount({ ...credentials, SCREENSHOT_USER_EMAIL: email })).toThrow();
    },
  );

  it.each([
    undefined,
    '',
    'a'.repeat(129),
    'ends-in-newline\n',
    'carriage\rreturn',
    'tab\tcharacter',
    'null\0byte',
    'delete\x7f',
    'non-ASCII-é',
  ])('refuses an unusable normal UI password', (password) => {
    expect(() => readNativeTestAccount({ ...credentials, SCREENSHOT_USER_PASSWORD: password })).toThrow();
  });

  it('accepts the printable password bounds without changing the password', () => {
    for (const password of [' ', '~'.repeat(128)]) {
      expect(
        readNativeTestAccount({ ...credentials, SCREENSHOT_USER_PASSWORD: password }).SCREENSHOT_USER_PASSWORD,
      ).toBe(password);
    }
  });

  it('pins the committed operator key and refuses arbitrary RSA recipients', async () => {
    const pem = await readFile('scripts/lib/native-test-account-recipient.pem', 'utf8');
    const pinned = readPinnedNativeTestRecipient(pem);
    expect(sealNativeTestAccount(credentials, pinned).recipientSha256).toBe(NATIVE_TEST_RECIPIENT_SHA256);
    expect(() =>
      readPinnedNativeTestRecipient(operator.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    ).toThrow('fixed public recipient');
  });

  it('rejects weak, non-RSA and private keys', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const elliptic = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    for (const publicKey of [weak.publicKey, elliptic.publicKey]) {
      expect(() =>
        readPinnedNativeTestRecipient(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      ).toThrow();
      expect(() => sealNativeTestAccount(credentials, publicKey)).toThrow();
    }
    expect(() =>
      readPinnedNativeTestRecipient(operator.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toThrow();
    expect(() => sealNativeTestAccount(credentials, operator.privateKey)).toThrow();
  });

  it('writes only an exclusive 0600 ciphertext file and preserves it on overwrite refusal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-account-test-'));
    const outputPath = join(directory, 'encrypted.json');
    try {
      const environment = {
        ...credentials,
        NATIVE_TEST_ACCOUNT_OUTPUT: outputPath,
        UNRELATED_SECRET: 'excluded-canary-secret',
      };
      await main(environment);
      const body = await readFile(outputPath, 'utf8');
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(['encrypted.json']);
      expect(JSON.parse(body).recipientSha256).toBe(NATIVE_TEST_RECIPIENT_SHA256);
      expect(body).not.toContain(credentials.SCREENSHOT_USER_PASSWORD);
      expect(body).not.toContain('excluded-canary-secret');
      await expect(main(environment)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(outputPath, 'utf8')).toBe(body);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps actual CLI success, identity rejection and filesystem failure output secret-free', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-account-cli-test-'));
    const outputPath = join(directory, 'encrypted.json');
    try {
      const invoke = (overrides: NodeJS.ProcessEnv = {}) =>
        spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/seal-native-test-account.ts')], {
          env: { ...credentials, NATIVE_TEST_ACCOUNT_OUTPUT: outputPath, ...overrides },
          encoding: 'utf8',
          timeout: 15_000,
        });
      const success = invoke();
      expect(success.status).toBe(0);
      const overwrite = invoke();
      expect(overwrite.status).toBe(1);
      const personal = invoke({ SCREENSHOT_USER_EMAIL: 'personal-secret-canary@example.com' });
      expect(personal.status).toBe(1);
      const filesystem = invoke({ NATIVE_TEST_ACCOUNT_OUTPUT: join(directory, 'secret-path-canary', 'absent.json') });
      expect(filesystem.status).toBe(1);
      for (const result of [success, overwrite, personal, filesystem]) {
        const output = result.stdout + result.stderr;
        for (const canary of [
          credentials.SCREENSHOT_USER_PASSWORD,
          credentials.SCREENSHOT_USER_EMAIL,
          'personal-secret-canary',
          'secret-path-canary',
          outputPath,
        ])
          expect(output).not.toContain(canary);
      }
      expect(overwrite.stderr).toBe('Native test account handoff failed; secret-bearing details withheld.\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
