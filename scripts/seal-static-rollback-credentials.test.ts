import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_AAD, LEGACY_FIELDS, main, sealStaticRollbackCredentials } from './seal-static-rollback-credentials';

const operator = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = operator.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const environment = {
  STATIC_ASSETS_LEGACY_S3_BUCKET_NAME: 'boardsesh-static-assets',
  STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL: 'https://t3.storage.dev',
  STATIC_ASSETS_LEGACY_AWS_REGION: 'auto',
  STATIC_ASSETS_LEGACY_AWS_ACCESS_KEY_ID: 'test-access-key',
  STATIC_ASSETS_LEGACY_AWS_SECRET_ACCESS_KEY: 'test-secret-key',
  UNRELATED_SECRET: 'must-never-enter-backup',
};

function unwrapEncryptionKey(
  envelope: ReturnType<typeof sealStaticRollbackCredentials>,
  privateKey = operator.privateKey,
): Buffer {
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.wrappedKey, 'base64'),
  );
}

function decrypt(
  envelope: ReturnType<typeof sealStaticRollbackCredentials>,
  privateKey = operator.privateKey,
): unknown {
  const key = unwrapEncryptionKey(envelope, privateKey);
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  cipher.setAAD(Buffer.from(BACKUP_AAD));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString(),
  );
}

describe('static rollback credential sealing', () => {
  it('writes only an encrypted 0600 artifact and refuses to overwrite it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'static-rollback-test-'));
    const outputPath = join(directory, 'encrypted.json');
    try {
      const configured = {
        ...environment,
        STATIC_ROLLBACK_BACKUP_PUBLIC_KEY: publicKey,
        STATIC_ROLLBACK_BACKUP_OUTPUT: outputPath,
      };
      await main(configured);
      const encrypted = await readFile(outputPath, 'utf8');
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect(decrypt(JSON.parse(encrypted) as ReturnType<typeof sealStaticRollbackCredentials>)).toMatchObject({
        kind: 'boardsesh-static-assets-legacy',
      });
      expect(encrypted).not.toContain(environment.STATIC_ASSETS_LEGACY_AWS_SECRET_ACCESS_KEY);
      await expect(main(configured)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(outputPath, 'utf8')).toBe(encrypted);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('round-trips exactly the five legacy fields for the operator key', () => {
    const sealed = sealStaticRollbackCredentials(environment, publicKey);
    expect(decrypt(sealed)).toEqual({
      kind: 'boardsesh-static-assets-legacy',
      credentials: Object.fromEntries(LEGACY_FIELDS.map((name) => [name, environment[name]])),
    });
    for (const credential of ['test-access-key', 'test-secret-key', environment.UNRELATED_SECRET]) {
      expect(JSON.stringify(sealed)).not.toContain(credential);
    }
  });

  it('rejects a different private key', () => {
    const otherOperator = generateKeyPairSync('rsa', { modulusLength: 3072 });
    expect(() => decrypt(sealStaticRollbackCredentials(environment, publicKey), otherOperator.privateKey)).toThrow();
  });

  it.each(['ciphertext', 'tag', 'wrappedKey', 'nonce'] as const)('rejects tampered %s', (field) => {
    const sealed = sealStaticRollbackCredentials(environment, publicKey);
    const corrupted = Buffer.from(sealed[field], 'base64');
    corrupted[0] ^= 1;
    expect(() => decrypt({ ...sealed, [field]: corrupted.toString('base64') })).toThrow();
  });

  it('uses fresh symmetric keys and nonces on repeated backups', () => {
    const first = sealStaticRollbackCredentials(environment, publicKey);
    const second = sealStaticRollbackCredentials(environment, publicKey);
    expect(second.nonce).not.toEqual(first.nonce);
    expect(unwrapEncryptionKey(second)).not.toEqual(unwrapEncryptionKey(first));
    expect(decrypt(second)).toEqual(decrypt(first));
  });

  it.each(LEGACY_FIELDS)('fails closed for missing %s', (name) => {
    expect(() => sealStaticRollbackCredentials({ ...environment, [name]: '' }, publicKey)).toThrow(
      'Missing legacy credential',
    );
  });

  it('refuses R2 credentials and keys from another bucket', () => {
    expect(() =>
      sealStaticRollbackCredentials(
        { ...environment, STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL: 'https://account.r2.cloudflarestorage.com' },
        publicKey,
      ),
    ).toThrow('existing Tigris');
    expect(() =>
      sealStaticRollbackCredentials(
        { ...environment, STATIC_ASSETS_LEGACY_S3_BUCKET_NAME: 'another-bucket' },
        publicKey,
      ),
    ).toThrow('existing Tigris');
  });

  it('rejects weak, non-RSA, and private keys', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const elliptic = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    for (const key of [weak.publicKey, elliptic.publicKey]) {
      expect(() =>
        sealStaticRollbackCredentials(environment, key.export({ type: 'spki', format: 'pem' }).toString()),
      ).toThrow('at least 3072 bits');
    }
    expect(() =>
      sealStaticRollbackCredentials(
        environment,
        operator.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ),
    ).toThrow('public key');
  });

  it.each([
    '# PUBLIC KEY\n-----BEGIN CERTIFICATE-----\nnot-a-public-key',
    '# comment\n' + publicKey,
    'invalid PUBLIC KEY',
  ])('rejects non-public-key PEM headers', (pem) => {
    expect(() => sealStaticRollbackCredentials(environment, pem)).toThrow('operator RSA public key');
  });
});
