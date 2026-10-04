import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { main } from './migrate-static-assets';

type StoredObject = { body: Buffer; metadata: Omit<PutObjectCommandInput, 'Bucket' | 'Key' | 'Body'> };
const storage = vi.hoisted(() => ({
  buckets: new Map<string, Map<string, StoredObject>>(),
  calls: [] as { endpoint: string; operation: string; key?: string }[],
}));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...original,
    S3Client: class {
      constructor(private readonly config: { endpoint: string }) {}
      destroy() {}
      async send(command: GetObjectCommand | ListObjectsV2Command | PutObjectCommand) {
        const endpoint = this.config.endpoint;
        const bucket = storage.buckets.get(endpoint);
        if (!bucket) throw new Error('Unexpected endpoint');
        storage.calls.push({
          endpoint,
          operation: command.constructor.name,
          key: 'Key' in command.input ? command.input.Key : undefined,
        });
        if (command instanceof original.ListObjectsV2Command)
          return {
            Contents: [...bucket]
              .filter(([key]) => key.startsWith(command.input.Prefix ?? ''))
              .map(([Key, object]) => ({ Key, Size: object.body.length })),
          };
        const key = command.input.Key;
        if (!key) throw new Error('Missing key');
        if (command instanceof original.GetObjectCommand) {
          const object = bucket.get(key);
          if (!object) throw { $metadata: { httpStatusCode: 404 } };
          return { ...object.metadata, ContentLength: object.body.length, Body: Readable.from([object.body]) };
        }
        if (bucket.has(key) && command.input.IfNoneMatch === '*') throw { $metadata: { httpStatusCode: 412 } };
        const { Body, Bucket: _bucket, Key: _key, ...metadata } = command.input;
        if (!(Body instanceof Uint8Array)) throw new Error('Expected binary asset');
        bucket.set(key, { body: Buffer.from(Body), metadata });
        return {};
      }
    },
  };
});
vi.mock('./lib/static-asset-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/static-asset-upload')>()),
  createRequestStartLimiter: () => async () => undefined,
}));
const LEGACY = 'https://t3.storage.dev';
const R2 = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
function asset(contents: string) {
  const body = Buffer.from(contents);
  return {
    key: `static/v1/${createHash('sha256').update(body).digest('hex')}.webp`,
    object: {
      body,
      metadata: { ContentType: 'image/webp', CacheControl: 'public, immutable', Metadata: { origin: 'catalog' } },
    },
  };
}
function writes() {
  return storage.calls.filter(({ operation }) => operation === 'PutObjectCommand');
}
beforeEach(() => {
  storage.buckets.clear();
  storage.calls.length = 0;
  storage.buckets.set(LEGACY, new Map());
  storage.buckets.set(R2, new Map());
  for (const [name, configured] of Object.entries({
    STATIC_ASSETS_LEGACY_AWS_ENDPOINT_URL: LEGACY,
    STATIC_ASSETS_R2_AWS_ENDPOINT_URL: R2,
    STATIC_ASSETS_LEGACY_S3_BUCKET_NAME: 'boardsesh-static-assets',
    STATIC_ASSETS_LEGACY_AWS_REGION: 'auto',
    STATIC_ASSETS_LEGACY_AWS_ACCESS_KEY_ID: 'legacy-key',
    STATIC_ASSETS_LEGACY_AWS_SECRET_ACCESS_KEY: 'legacy-secret',
    STATIC_ASSETS_R2_AWS_ACCESS_KEY_ID: 'r2-key',
    STATIC_ASSETS_R2_AWS_SECRET_ACCESS_KEY: 'r2-secret',
  }))
    vi.stubEnv(name, configured);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('static migration main rollback', () => {
  it('copies new R2 hashes back, verifies bytes and metadata, and preserves archives and manifests', async () => {
    const current = asset('new R2 asset');
    const archived = asset('legacy archived asset');
    storage.buckets.get(R2)!.set(current.key, current.object);
    storage.buckets.get(R2)!.set('static/v1/manifest.json', { body: Buffer.from('new manifest'), metadata: {} });
    storage.buckets.get(LEGACY)!.set(archived.key, archived.object);
    const oldManifest = { body: Buffer.from('retained manifest'), metadata: {} };
    storage.buckets.get(LEGACY)!.set('static/v1/manifest.json', oldManifest);
    await main(['--reverse', '--apply']);
    expect(storage.buckets.get(LEGACY)!.get(current.key)).toMatchObject(current.object);
    expect(storage.buckets.get(LEGACY)!.get(archived.key)).toBe(archived.object);
    expect(storage.buckets.get(LEGACY)!.get('static/v1/manifest.json')).toBe(oldManifest);
    expect(writes().every(({ endpoint, key }) => endpoint === LEGACY && key === current.key)).toBe(true);
    expect(
      storage.calls.filter(
        ({ endpoint, key, operation }) =>
          endpoint === LEGACY && key === current.key && operation === 'GetObjectCommand',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('"direction":"r2-to-tigris"'));
  });
  it.each([{ flags: [] }, { flags: ['--verify-only'] }])('reverse $flags is read-only', async ({ flags }) => {
    const current = asset('shared');
    for (const bucket of storage.buckets.values()) bucket.set(current.key, current.object);
    await main(['--reverse', ...flags]);
    expect(writes()).toEqual([]);
  });
  it('rejects same-size destination corruption without overwriting immutable keys', async () => {
    const current = asset('correct');
    storage.buckets.get(R2)!.set(current.key, current.object);
    storage.buckets.get(LEGACY)!.set(current.key, { ...current.object, body: Buffer.from('corrupt') });
    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/Corrupt immutable asset/);
    expect(writes()).toEqual([]);
  });
  it('rejects provider mismatch before any storage operation', async () => {
    vi.stubEnv('STATIC_ASSETS_R2_AWS_ENDPOINT_URL', LEGACY);
    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/R2 HTTPS account endpoint/);
    expect(storage.calls).toEqual([]);
  });
});
