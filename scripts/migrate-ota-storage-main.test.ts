import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GetObjectCommand, GetObjectTaggingCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { main } from './migrate-ota-storage';

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
      async send(command: GetObjectCommand | GetObjectTaggingCommand | ListObjectsV2Command | PutObjectCommand) {
        const endpoint = this.config.endpoint;
        const bucket = storage.buckets.get(endpoint);
        if (!bucket) throw new Error('Unexpected endpoint');
        storage.calls.push({
          endpoint,
          operation: command.constructor.name,
          key: 'Key' in command.input ? command.input.Key : undefined,
        });
        if (command instanceof original.ListObjectsV2Command)
          return { Contents: [...bucket].map(([Key, object]) => ({ Key, Size: object.body.length })) };
        if (command instanceof original.GetObjectTaggingCommand) {
          if (endpoint.includes('r2.cloudflarestorage.com')) throw new Error('R2 does not implement GetObjectTagging');
          return { TagSet: [] };
        }
        const key = command.input.Key;
        if (!key) throw new Error('Missing key');
        if (command instanceof original.GetObjectCommand) {
          const object = bucket.get(key);
          if (!object) throw { $metadata: { httpStatusCode: 404 } };
          return { ...object.metadata, ContentLength: object.body.length, Body: Readable.from([object.body]) };
        }
        const { Body, Bucket: _bucket, Key: _key, ContentMD5: _md5, ...metadata } = command.input;
        if (!(Body instanceof Readable)) throw new Error('Expected staged OTA stream');
        const chunks: Buffer[] = [];
        for await (const chunk of Body) chunks.push(Buffer.from(chunk as Uint8Array));
        bucket.set(key, { body: Buffer.concat(chunks), metadata });
        return {};
      }
    },
  };
});
const LEGACY = 'https://t3.storage.dev';
const R2 = 'https://synthetic.r2.cloudflarestorage.com';
let liveEndpoint = R2;
function object(contents: string): StoredObject {
  return {
    body: Buffer.from(contents),
    metadata: {
      ContentType: 'application/octet-stream',
      CacheControl: 'private',
      ContentDisposition: 'attachment',
      ContentLanguage: 'en',
      Expires: new Date('2030-01-01'),
      Metadata: { runtime: 'historical' },
    },
  };
}
function writes() {
  return storage.calls.filter(({ operation }) => operation === 'PutObjectCommand');
}
beforeEach(() => {
  liveEndpoint = R2;
  storage.buckets.clear();
  storage.calls.length = 0;
  storage.buckets.set(LEGACY, new Map());
  storage.buckets.set(R2, new Map());
  for (const [name, configured] of Object.entries({
    RAILWAY_TOKEN: 'synthetic-token',
    RAILWAY_PROJECT_ID: 'project',
    OTA_LEGACY_AWS_ENDPOINT_URL: LEGACY,
    OTA_LEGACY_AWS_ACCESS_KEY_ID: 'legacy-key',
    OTA_LEGACY_AWS_SECRET_ACCESS_KEY: 'legacy-secret',
    OTA_R2_AWS_ENDPOINT_URL: R2,
    OTA_R2_AWS_ACCESS_KEY_ID: 'r2-key',
    OTA_R2_AWS_SECRET_ACCESS_KEY: 'r2-secret',
    GITHUB_ACTIONS: 'false',
  }))
    vi.stubEnv(name, configured);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected Railway JSON body');
      const request = JSON.parse(init.body) as { query: string };
      if (/\bmutation\b/.test(request.query)) throw new Error('Unexpected Railway mutation');
      const data = request.query.includes('MigrationProject')
        ? {
            project: {
              environments: { edges: [{ node: { id: 'env', name: 'production' } }] },
              services: { edges: [{ node: { id: 'ota', name: 'boardsesh-ota-v3' } }] },
            },
          }
        : {
            variables: {
              AWS_BASE_ENDPOINT: liveEndpoint,
              AWS_ACCESS_KEY_ID: 'live-key',
              AWS_SECRET_ACCESS_KEY: 'live-secret',
              STORAGE_MODE: 's3',
              S3_BUCKET_NAME: 'boardsesh-ota-v3',
            },
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('OTA migration main rollback', () => {
  it('reads live R2 and copies new runtime assets back while retaining legacy archives', async () => {
    const current = object('new update');
    const archived = object('archived preview');
    storage.buckets.get(R2)!.set('new-runtime/bundle', current);
    storage.buckets.get(LEGACY)!.set('old-preview/bundle', archived);
    await main(['--reverse', '--apply']);
    expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')).toMatchObject(current);
    expect(storage.buckets.get(LEGACY)!.get('old-preview/bundle')).toBe(archived);
    expect(writes()).toEqual([{ endpoint: LEGACY, operation: 'PutObjectCommand', key: 'new-runtime/bundle' }]);
    expect(
      storage.calls.some(({ endpoint, operation }) => endpoint === R2 && operation === 'GetObjectTaggingCommand'),
    ).toBe(false);
    expect(
      storage.calls.filter(({ endpoint, operation }) => endpoint === R2 && operation === 'GetObjectCommand').length,
    ).toBeGreaterThanOrEqual(3);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SHA-256, and metadata (preserve-archives)'));
  });
  it.each([{ flags: [] }, { flags: ['--verify-only'] }])('reverse $flags is read-only', async ({ flags }) => {
    for (const bucket of storage.buckets.values()) bucket.set('current', object('shared'));
    storage.buckets.get(LEGACY)!.set('archive', object('keep'));
    await main(['--reverse', ...flags]);
    expect(writes()).toEqual([]);
  });
  it.each([{ mismatch: 'content' }, { mismatch: 'metadata' }])(
    'verify-only detects $mismatch drift without writing',
    async ({ mismatch }) => {
      const current = object('correct');
      storage.buckets.get(R2)!.set('current', current);
      storage.buckets
        .get(LEGACY)!
        .set(
          'current',
          mismatch === 'content'
            ? { ...current, body: Buffer.from('corrupt') }
            : { ...current, metadata: { ...current.metadata, CacheControl: 'public' } },
        );
      await expect(main(['--reverse', '--verify-only'])).rejects.toThrow(/verification failed/);
      expect(writes()).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(mismatch));
    },
  );
  it('still rejects extra destination keys before forward-copy writes', async () => {
    liveEndpoint = LEGACY;
    storage.buckets.get(LEGACY)!.set('current', object('current'));
    storage.buckets.get(R2)!.set('extra', object('extra'));
    await expect(main(['--apply'])).rejects.toThrow(/No objects were copied/);
    expect(writes()).toEqual([]);
  });
  it('rejects a non-R2 live rollback source before storage operations', async () => {
    liveEndpoint = LEGACY;
    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/Rollback requires.*R2/);
    expect(storage.calls).toEqual([]);
  });
});
