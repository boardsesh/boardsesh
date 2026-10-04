import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ReadStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GetObjectCommand, GetObjectTaggingCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { main, parseMigrationOptions } from './migrate-ota-storage';

type StoredObject = { body: Buffer; metadata: Omit<PutObjectCommandInput, 'Bucket' | 'Key' | 'Body'> };
const storage = vi.hoisted(() => ({
  buckets: new Map<string, Map<string, StoredObject>>(),
  backoffs: [] as number[],
  putFailures: [] as { error: unknown; partial?: boolean; committed?: boolean; committedObject?: StoredObject }[],
  putAttempts: [] as { body: Readable; bytes: Buffer; input: PutObjectCommandInput }[],
  activeReads: new Map<string, number>(),
  readPeaks: new Map<string, number[]>(),
  calls: [] as { endpoint: string; operation: string; key?: string }[],
  putPreconditions: [] as (string | undefined)[],
  raceBeforePut: false,
  raceObject: null as StoredObject | null,
  getFailureEndpoint: '' as string,
  getFailureKey: '' as string,
  getFailure: null as unknown,
  putFailure: null as unknown,
  returnBeforeDrain: false,
  earlyPutFailure: null as unknown,
  earlyPutWinner: null as StoredObject | null,
  uploadBodies: [] as ReadStream[],
  sourceGets: 0,
  mutateSourceAfterGet: 0,
}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: async (duration: number) => {
    storage.backoffs.push(duration);
  },
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
        if (command instanceof original.ListObjectsV2Command) {
          const peaks = storage.readPeaks.get(endpoint) ?? [];
          peaks.push(0);
          storage.readPeaks.set(endpoint, peaks);
          return { Contents: [...bucket].map(([Key, object]) => ({ Key, Size: object.body.length })) };
        }
        if (command instanceof original.GetObjectTaggingCommand) {
          if (endpoint.includes('r2.cloudflarestorage.com')) throw new Error('R2 does not implement GetObjectTagging');
          return { TagSet: [] };
        }
        const key = command.input.Key;
        if (!key) throw new Error('Missing key');
        if (command instanceof original.GetObjectCommand) {
          if (endpoint === storage.getFailureEndpoint && key === storage.getFailureKey && storage.getFailure) {
            throw storage.getFailure;
          }
          const storedObject = bucket.get(key);
          if (!storedObject) throw { $metadata: { httpStatusCode: 404 } };
          if (endpoint === R2) {
            storage.sourceGets += 1;
            if (storage.sourceGets === storage.mutateSourceAfterGet) {
              bucket.set(key, object('changed!'));
            }
          }
          const body = Readable.from(
            (async function* () {
              const active = (storage.activeReads.get(endpoint) ?? 0) + 1;
              storage.activeReads.set(endpoint, active);
              const peaks = storage.readPeaks.get(endpoint)!;
              peaks[peaks.length - 1] = Math.max(peaks.at(-1)!, active);
              try {
                await new Promise<void>((resolve) => setImmediate(resolve));
                yield storedObject.body;
              } finally {
                storage.activeReads.set(endpoint, storage.activeReads.get(endpoint)! - 1);
              }
            })(),
          );
          return { ...storedObject.metadata, ContentLength: storedObject.body.length, Body: body };
        }
        storage.putPreconditions.push(command.input.IfNoneMatch);
        const { Body, Bucket: _bucket, Key: _key, ContentMD5: _md5, ...metadata } = command.input;
        if (!(Body instanceof Readable)) throw new Error('Expected staged OTA stream');
        storage.uploadBodies.push(Body as unknown as ReadStream);
        if (storage.returnBeforeDrain) {
          if (storage.earlyPutWinner) bucket.set(key, storage.earlyPutWinner);
          if (storage.earlyPutFailure === null) throw new Error('Missing early provider response');
          throw storage.earlyPutFailure;
        }
        const failure = storage.putFailures.shift();
        const chunks: Buffer[] = [];
        for await (const chunk of Body) {
          chunks.push(Buffer.from(chunk as Uint8Array));
          if (failure?.partial) break;
        }
        const bytes = Buffer.concat(chunks);
        storage.putAttempts.push({ body: Body, bytes, input: command.input });
        if (!failure?.partial) {
          if (createHash('md5').update(bytes).digest('base64') !== _md5)
            throw { name: 'BadDigest', $metadata: { httpStatusCode: 400 } };
          if (storage.putFailure) throw storage.putFailure;
          if (storage.raceBeforePut) {
            storage.raceBeforePut = false;
            if (!storage.raceObject) throw new Error('Missing synthetic race object');
            bucket.set(key, storage.raceObject);
          }
          if (command.input.IfNoneMatch === '*' && bucket.has(key))
            throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };
          if (!failure || failure.committed) bucket.set(key, failure?.committedObject ?? { body: bytes, metadata });
        }
        if (failure) throw failure.error;
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
async function withIsolatedStagingDirectory(run: (stagingRoot: string) => Promise<void>) {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'boardsesh-ota-stream-test-'));
  vi.stubEnv('TMPDIR', stagingRoot);
  try {
    await run(stagingRoot);
    expect(await readdir(stagingRoot)).toEqual([]);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
function expectUploadStreamsClosed() {
  expect(storage.uploadBodies).not.toHaveLength(0);
  for (const body of storage.uploadBodies) {
    expect(body.destroyed).toBe(true);
    expect(body.closed).toBe(true);
    expect(Reflect.get(body, 'fd')).toBeNull();
  }
}
beforeEach(() => {
  liveEndpoint = R2;
  storage.buckets.clear();
  storage.calls.length = 0;
  storage.putFailures.length = 0;
  storage.backoffs.length = 0;
  storage.putAttempts.length = 0;
  storage.activeReads.clear();
  storage.readPeaks.clear();
  storage.putPreconditions.length = 0;
  storage.raceBeforePut = false;
  storage.raceObject = null;
  storage.getFailureEndpoint = '';
  storage.getFailureKey = '';
  storage.getFailure = null;
  storage.putFailure = null;
  storage.returnBeforeDrain = false;
  storage.earlyPutFailure = null;
  storage.earlyPutWinner = null;
  storage.uploadBodies.length = 0;
  storage.sourceGets = 0;
  storage.mutateSourceAfterGet = 0;
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
    expect(storage.putPreconditions).toEqual(['*']);
    expectUploadStreamsClosed();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SHA-256, and metadata (preserve-archives)'));
  });
  it.each([{ flags: [] }, { flags: ['--verify-only'] }])('reverse $flags is read-only', async ({ flags }) => {
    for (const bucket of storage.buckets.values()) bucket.set('current', object('shared'));
    storage.buckets.get(LEGACY)!.set('archive', object('keep'));
    await main(['--', '--reverse', ...flags]);
    expect(writes()).toEqual([]);
    if (flags.length === 0)
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Migration object concurrency:'));
    else expect(console.log).toHaveBeenCalledWith('Migration object concurrency: 4.');
  });
  it.each([{ mismatch: 'content' }, { mismatch: 'metadata' }])(
    'rollback refuses existing $mismatch conflicts without overwriting',
    async ({ mismatch }) => {
      const current = object('correct');
      storage.buckets.get(R2)!.set('current', current);
      storage.buckets.get(R2)!.set('later-missing', object('another asset'));
      const conflict =
        mismatch === 'content'
          ? { ...current, body: Buffer.from('corrupt') }
          : { ...current, metadata: { ...current.metadata, CacheControl: 'public' } };
      storage.buckets.get(LEGACY)!.set('current', conflict);
      await expect(main(['--reverse', '--apply'])).rejects.toThrow(/Destination object conflicts/);
      expect(writes()).toEqual([]);
      expect(storage.buckets.get(LEGACY)!.get('current')).toBe(conflict);
      expect(storage.buckets.get(LEGACY)!.has('later-missing')).toBe(false);
    },
  );
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
  it('rollback refuses an existing size conflict before any copy write', async () => {
    storage.buckets.get(R2)!.set('current', object('source bytes'));
    const conflict = object('short');
    storage.buckets.get(LEGACY)!.set('current', conflict);
    storage.buckets.get(R2)!.set('later-missing', object('another asset'));

    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/Destination object conflicts with source size/);

    expect(writes()).toEqual([]);
    expect(storage.buckets.get(LEGACY)!.get('current')).toBe(conflict);
    expect(storage.buckets.get(LEGACY)!.has('later-missing')).toBe(false);
  });
  it('fails closed on a destination read error before copying missing objects', async () => {
    storage.buckets.get(R2)!.set('current', object('shared bytes'));
    const retained = object('shared bytes');
    storage.buckets.get(LEGACY)!.set('current', retained);
    storage.buckets.get(R2)!.set('later-missing', object('another asset'));
    storage.getFailureEndpoint = LEGACY;
    storage.getFailureKey = 'current';
    storage.getFailure = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };

    await expect(main(['--reverse', '--apply'])).rejects.toMatchObject({ name: 'AccessDenied' });

    expect(writes()).toEqual([]);
    expect(storage.buckets.get(LEGACY)!.get('current')).toBe(retained);
    expect(storage.buckets.get(LEGACY)!.has('later-missing')).toBe(false);
  });
  it('keeps an identical existing destination object without a PUT', async () => {
    const source = object('identical');
    const destination = object('identical');
    storage.buckets.get(R2)!.set('current', source);
    storage.buckets.get(LEGACY)!.set('current', destination);

    await main(['--reverse', '--apply']);

    expect(writes()).toEqual([]);
    expect(storage.buckets.get(LEGACY)!.get('current')).toBe(destination);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('0 copied, 1 unchanged'));
  });
  it('accepts a concurrent create only after its complete fingerprint matches', async () => {
    const source = object('new update');
    const concurrent = object('new update');
    storage.buckets.get(R2)!.set('new-runtime/bundle', source);
    storage.raceBeforePut = true;
    storage.raceObject = concurrent;

    await main(['--reverse', '--apply']);

    expect(writes()).toHaveLength(1);
    expect(storage.putPreconditions).toEqual(['*']);
    expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')).toBe(concurrent);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('0 copied, 1 unchanged'));
  });
  it('closes an unread upload body before accepting an identical early 412 winner', async () => {
    const source = object('identical update');
    const winner = object('identical update');
    storage.buckets.get(R2)!.set('new-runtime/bundle', source);
    storage.returnBeforeDrain = true;
    storage.earlyPutWinner = winner;
    storage.earlyPutFailure = { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };

    await withIsolatedStagingDirectory(async () => {
      await main(['--reverse', '--apply']);

      expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')).toBe(winner);
      expect(writes()).toHaveLength(1);
      expect(storage.putPreconditions).toEqual(['*']);
      expectUploadStreamsClosed();
    });
  });
  it.each(['content', 'metadata', 'size'] as const)(
    'closes an unread upload body and preserves the winner after an early 412 %s conflict',
    async (mismatch) => {
      const source = object('source update');
      const winner =
        mismatch === 'size'
          ? object('x')
          : mismatch === 'content'
            ? object('different update')
            : { ...object('source update'), metadata: { ...object('source update').metadata, CacheControl: 'public' } };
      storage.buckets.get(R2)!.set('new-runtime/bundle', source);
      storage.returnBeforeDrain = true;
      storage.earlyPutWinner = winner;
      storage.earlyPutFailure = { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };

      await withIsolatedStagingDirectory(async () => {
        await expect(main(['--reverse', '--apply'])).rejects.toThrow(/created during copy conflicts/);

        expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')).toBe(winner);
        expect(writes()).toHaveLength(1);
        expect(storage.putPreconditions).toEqual(['*']);
        expectUploadStreamsClosed();
      });
    },
  );
  it.each([403, 409])(
    'closes an unread upload body after early HTTP %i and preserves the provider error',
    async (status) => {
      const providerError = Object.assign(new Error(`HTTP ${status}`), {
        name: status === 403 ? 'AccessDenied' : 'ConditionalRequestConflict',
        $metadata: { httpStatusCode: status },
      });
      storage.buckets.get(R2)!.set('new-runtime/bundle', object('new update'));
      storage.returnBeforeDrain = true;
      storage.earlyPutFailure = providerError;

      await withIsolatedStagingDirectory(async () => {
        await expect(main(['--reverse', '--apply'])).rejects.toBe(providerError);

        expect(storage.buckets.get(LEGACY)!.has('new-runtime/bundle')).toBe(false);
        expect(writes()).toHaveLength(1);
        expect(storage.putPreconditions).toEqual(['*']);
        expectUploadStreamsClosed();
      });
    },
  );
  it('refuses a conflicting concurrent create without replacing the winner', async () => {
    const source = object('new update');
    const concurrent = object('different!');
    storage.buckets.get(R2)!.set('new-runtime/bundle', source);
    storage.raceBeforePut = true;
    storage.raceObject = concurrent;

    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/created during copy conflicts/);

    expect(writes()).toHaveLength(1);
    expect(storage.putPreconditions).toEqual(['*']);
    expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')).toBe(concurrent);
  });
  it('refuses a same-content concurrent create when portable metadata differs', async () => {
    const source = object('new update');
    const concurrent = {
      ...object('new update'),
      metadata: { ...object('new update').metadata, CacheControl: 'public' },
    };
    storage.buckets.get(R2)!.set('new-runtime/bundle', source);
    storage.raceBeforePut = true;
    storage.raceObject = concurrent;

    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/created during copy conflicts/);

    expect(writes()).toHaveLength(1);
    expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')).toBe(concurrent);
  });
  it('does not treat a non-412 provider error as a verified create collision', async () => {
    storage.buckets.get(R2)!.set('new-runtime/bundle', object('new update'));
    const providerError = { name: 'ConditionalRequestConflict', $metadata: { httpStatusCode: 409 } };
    storage.putFailure = providerError;

    await expect(main(['--reverse', '--apply'])).rejects.toBe(providerError);

    expect(storage.putPreconditions).toEqual(['*']);
    expect(storage.buckets.get(LEGACY)!.has('new-runtime/bundle')).toBe(false);
    expect(
      storage.calls.filter(({ endpoint, operation }) => endpoint === LEGACY && operation === 'GetObjectCommand'),
    ).toEqual([]);
  });
  it('joins workers and removes staging files after a conflicting race', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'boardsesh-ota-cleanup-test-'));
    vi.stubEnv('TMPDIR', stagingRoot);
    storage.buckets.get(R2)!.set('new-runtime/bundle', object('new update'));
    storage.raceBeforePut = true;
    storage.raceObject = object('different!');

    try {
      await expect(main(['--reverse', '--apply'])).rejects.toThrow(/created during copy conflicts/);
      expect(await readdir(stagingRoot)).toEqual([]);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
  it('detects a source change between verification passes', async () => {
    storage.buckets.get(R2)!.set('new-runtime/bundle', object('original'));
    storage.mutateSourceAfterGet = 2;

    await expect(main(['--reverse', '--apply'])).rejects.toThrow(/OTA storage migration verification failed/);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Source object changed during verification'));
    expect(storage.buckets.get(R2)!.get('new-runtime/bundle')!.body.toString()).toBe('changed!');
    expect(storage.buckets.get(LEGACY)!.get('new-runtime/bundle')!.body.toString()).toBe('original');
    expect(storage.putPreconditions).toEqual(['*']);
  });
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

describe('OTA migration concurrency', () => {
  it('preserves four workers by default and supports both boundaries', () => {
    expect(parseMigrationOptions([])).toEqual({ mode: 'inventory', reverse: false, concurrency: 4 });
    for (const concurrency of [1, 32, 64]) {
      expect(parseMigrationOptions(['--reverse', '--apply', '--concurrency', String(concurrency)])).toEqual({
        mode: 'copy',
        reverse: true,
        concurrency,
      });
    }
  });
  it.each(['0', '65', '-1', '1.5', '1e1', 'NaN', 'Infinity', '', ' 4', '04', '999999999999999999999'])(
    'rejects invalid concurrency %j before any provider requests',
    async (requested) => {
      await expect(main(['--concurrency', requested])).rejects.toThrow('integer from 1 to 64');
      expect(fetch).not.toHaveBeenCalled();
      expect(storage.calls).toEqual([]);
    },
  );
  it('rejects missing values and repeated concurrency flags', () => {
    expect(() => parseMigrationOptions(['--concurrency'])).toThrow('integer from 1 to 64');
    expect(() => parseMigrationOptions(['--concurrency', '--apply'])).toThrow('integer from 1 to 64');
    expect(() => parseMigrationOptions(['--concurrency', '4', '--concurrency', '8'])).toThrow('repeated');
  });
  it.each([1, 6])('bounds copy and every full verification pass to %i workers', async (concurrency) => {
    liveEndpoint = LEGACY;
    for (let index = 0; index < 9; index += 1)
      storage.buckets.get(LEGACY)!.set(`runtime/asset-${index}`, object(`asset ${index}`));
    await main(['--', '--apply', '--concurrency', String(concurrency)]);
    expect(writes()).toHaveLength(9);
    expect(storage.readPeaks.get(LEGACY)).toEqual([concurrency, concurrency, concurrency]);
    expect(storage.readPeaks.get(R2)).toEqual([0, concurrency]);
    expect(
      storage.calls.filter(({ endpoint, operation }) => endpoint === LEGACY && operation === 'GetObjectCommand'),
    ).toHaveLength(27);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SHA-256, and metadata (exact)'));
  });
  it.each([1, 6])('bounds existing-destination preflight to %i workers', async (concurrency) => {
    for (const bucket of storage.buckets.values())
      for (let index = 0; index < 9; index += 1) bucket.set(`asset-${index}`, object(`asset ${index}`));

    await main(['--', '--reverse', '--apply', '--concurrency', String(concurrency)]);

    expect(writes()).toEqual([]);
    expect(storage.readPeaks.get(R2)?.[0]).toBe(concurrency);
    expect(storage.readPeaks.get(LEGACY)?.[0]).toBe(concurrency);
  });
  it('uses the requested worker limit in read-only verification', async () => {
    liveEndpoint = LEGACY;
    for (const bucket of storage.buckets.values())
      for (let index = 0; index < 9; index += 1) bucket.set(`asset-${index}`, object(`asset ${index}`));
    await main(['--', '--verify-only', '--concurrency', '6']);
    expect(writes()).toEqual([]);
    expect(storage.readPeaks.get(LEGACY)).toEqual([6, 6]);
    expect(storage.readPeaks.get(R2)).toEqual([6]);
  });
});

describe('OTA migration package-script argument separator', () => {
  it('accepts exactly one leading separator with all supported modes', () => {
    for (const flags of [[], ['--apply'], ['--verify-only'], ['--reverse', '--apply', '--concurrency', '64']])
      expect(parseMigrationOptions(['--', ...flags])).toEqual(parseMigrationOptions(flags));
  });
  it.each([
    { flags: ['--', '--'] },
    { flags: ['--apply', '--'] },
    { flags: ['--', '--apply', '--'] },
    { flags: ['--concurrency', '--', '64'] },
    { flags: ['--', '--concurrency', '64', '--'] },
  ])('rejects misplaced or repeated separators: $flags', async ({ flags }) => {
    await expect(main(flags)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
  });
  it('accepts arguments forwarded by the actual vp package-script entrypoint', () => {
    const result = spawnSync('vp', ['run', 'storage:migrate-ota', '--', '--apply', '--concurrency', '64'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, RAILWAY_TOKEN: '', RAILWAY_PROJECT_ID: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Missing required environment variable: RAILWAY_TOKEN');
    expect(`${result.stdout}${result.stderr}`).not.toContain('Unknown argument');
  }, 25_000);
});

describe('OTA migration whole-object PUT retries', () => {
  it.each([
    { failure: { error: { name: 'InternalError', $metadata: { httpStatusCode: 500 } } } },
    { failure: { error: { code: 'ECONNRESET' }, partial: true } },
    { failure: { error: { code: 'ECONNABORTED' }, partial: true } },
    { failure: { error: { name: 'TimeoutError' }, partial: true } },
    { failure: { error: { name: 'RequestTimeout', $metadata: { httpStatusCode: 408 } } } },
    { failure: { error: { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }, committed: true } },
  ])('reopens identical staged bytes after a transient failure: $failure', async ({ failure }) => {
    liveEndpoint = LEGACY;
    const current = object('full OTA bundle'.repeat(20_000));
    storage.buckets.get(LEGACY)!.set('runtime/bundle', current);
    storage.putFailures.push(failure);
    await main(['--apply', '--concurrency', '1']);
    expect(writes()).toHaveLength(2);
    expect(storage.putAttempts[0].body).not.toBe(storage.putAttempts[1].body);
    expect(storage.putAttempts.every(({ body }) => body.destroyed)).toBe(true);
    expectUploadStreamsClosed();
    expect(storage.putAttempts[1].bytes).toEqual(current.body);
    for (const { input } of storage.putAttempts)
      expect(input).toMatchObject({
        IfNoneMatch: '*',
        ContentLength: current.body.length,
        ContentMD5: createHash('md5').update(current.body).digest('base64'),
        ...current.metadata,
      });
    expect(storage.buckets.get(R2)!.get('runtime/bundle')).toMatchObject(current);
    // Copy, initial source SHA-256 pass, then final source-stability SHA-256 pass.
    expect(storage.readPeaks.get(LEGACY)).toEqual([1, 1, 1]);
    expect(storage.backoffs).toHaveLength(1);
    expect(storage.backoffs[0]).toBeGreaterThanOrEqual(187.5);
    expect(storage.backoffs[0]).toBeLessThanOrEqual(312.5);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SHA-256, and metadata (exact)'));
  });
  it('awaits actual closure of every unread body before retry and staging cleanup', async () => {
    storage.buckets.get(R2)!.set('runtime/bundle', object('bundle'));
    const failure = { name: 'InternalError', $metadata: { httpStatusCode: 500 } };
    storage.returnBeforeDrain = true;
    storage.earlyPutFailure = failure;
    await withIsolatedStagingDirectory(async () => {
      await expect(main(['--reverse', '--apply', '--concurrency', '1'])).rejects.toEqual(failure);
      expect(writes()).toHaveLength(4);
      expect(storage.putPreconditions).toEqual(['*', '*', '*', '*']);
      expectUploadStreamsClosed();
    });
  });
  it('rejects a conflicting conditional winner after an ambiguous committed upload', async () => {
    liveEndpoint = LEGACY;
    storage.buckets.get(LEGACY)!.set('runtime/bundle', object('desired'));
    const concurrent = object('different winner');
    storage.putFailures.push({
      error: { name: 'InternalError', $metadata: { httpStatusCode: 500 } },
      committed: true,
      committedObject: concurrent,
    });
    await expect(main(['--apply', '--concurrency', '1'])).rejects.toThrow(/created during copy conflicts with source/);
    expect(writes()).toHaveLength(2);
    expect(storage.putPreconditions).toEqual(['*', '*']);
    expect(storage.buckets.get(R2)!.get('runtime/bundle')).toBe(concurrent);
    expectUploadStreamsClosed();
  });
  it('stops after four transient attempts without deleting any objects', async () => {
    liveEndpoint = LEGACY;
    storage.buckets.get(LEGACY)!.set('runtime/bundle', object('bundle'));
    const failure = { name: 'SlowDown', $metadata: { httpStatusCode: 503 } };
    for (let attempt = 0; attempt < 5; attempt += 1) storage.putFailures.push({ error: failure });
    await expect(main(['--apply', '--concurrency', '1'])).rejects.toEqual(failure);
    expect(writes()).toHaveLength(4);
    expect(storage.backoffs).toHaveLength(3);
    for (const [index, milliseconds] of storage.backoffs.entries()) {
      expect(milliseconds).toBeGreaterThanOrEqual(187.5 * 2 ** index);
      expect(milliseconds).toBeLessThanOrEqual(312.5 * 2 ** index);
    }
    expect(storage.putAttempts.every(({ body }) => body.destroyed)).toBe(true);
    expectUploadStreamsClosed();
    expect(storage.buckets.get(LEGACY)!.size).toBe(1);
    expect(storage.buckets.get(R2)!.size).toBe(0);
  });
  it.each([
    { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
    { name: 'BadDigest', $metadata: { httpStatusCode: 400 } },
    { name: 'TimeoutError', $metadata: { httpStatusCode: 400 } },
    { code: 'ENOENT' },
    { name: 'Error', message: 'Unknown streaming failure' },
  ])('does not retry permanent or unclassified failures: %j', async (failure) => {
    liveEndpoint = LEGACY;
    storage.buckets.get(LEGACY)!.set('runtime/bundle', object('bundle'));
    storage.putFailures.push({ error: failure });
    await expect(main(['--apply', '--concurrency', '1'])).rejects.toEqual(failure);
    expect(writes()).toHaveLength(1);
    expect(storage.backoffs).toEqual([]);
    expect(storage.putAttempts[0].body.destroyed).toBe(true);
  });
});
