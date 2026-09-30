import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  inventoryAssets,
  migrateStaticAssets,
  parseMigrationMode,
  type AssetStore,
  type StoredAsset,
} from './static-asset-migration';
import { assertMigrationEndpoints, boundedAssetBody, migrationErrorMessage } from '../migrate-static-assets';

const contents = Buffer.from('historical asset no longer in the current catalog');
const key = `static/v1/${createHash('sha256').update(contents).digest('hex')}.webp`;
function storedAsset(body: Uint8Array = contents): StoredAsset {
  return {
    bytes: body.byteLength,
    body: (async function* () {
      yield body;
    })(),
    contentType: 'image/webp',
    cacheControl: 'public, max-age=31536000, immutable',
    contentDisposition: 'inline',
    contentLanguage: 'en',
    contentEncoding: 'identity',
    expires: new Date('2030-01-01'),
    metadata: { source: 'historical' },
  };
}
function memoryStore(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map(Object.entries(initial));
  const store: AssetStore = {
    list: vi.fn(async () => ({ keys: [...objects.keys()], truncated: false })),
    get: vi.fn(async (objectKey) => (objects.has(objectKey) ? storedAsset(objects.get(objectKey)) : undefined)),
    put: vi.fn(async (objectKey, body) => {
      if (objects.has(objectKey)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(objectKey, body);
    }),
  };
  return store;
}

describe('historical immutable assets migration', () => {
  it.each([
    `Missing buffered source asset: ${key}`,
    `Asset GET is not a readable stream: ${key}`,
    'Asset listing contains an object without a key',
  ])('preserves actionable internal diagnostics: %s', (message) => {
    expect(migrationErrorMessage(new Error(message))).toBe(message);
  });
  it('hides unknown SDK errors and limits internal diagnostic length', () => {
    const genericMessage = 'Storage request failed; check credentials, endpoint, and connectivity';
    expect(migrationErrorMessage(new Error('Request failed: Authorization=secret'))).toBe(genericMessage);
    expect(migrationErrorMessage({ request: { authorization: 'secret' } })).toBe(genericMessage);
    expect(migrationErrorMessage(new Error(`Unknown immutable asset key: ${'a'.repeat(300)}`))).toHaveLength(240);
  });
  it('defaults to dry run and rejects ambiguous or unknown flags', () => {
    expect(parseMigrationMode([])).toBe('dry-run');
    expect(parseMigrationMode(['--', '--dry-run'])).toBe('dry-run');
    expect(parseMigrationMode(['--', '--apply'])).toBe('apply');
    expect(parseMigrationMode(['--verify-only'])).toBe('verify-only');
    expect(() => parseMigrationMode(['--apply', '--dry-run'])).toThrow('exactly one');
    expect(() => parseMigrationMode(['--delete'])).toThrow('Supported flags');
    expect(() => parseMigrationMode(['--', '--', '--dry-run'])).toThrow('Supported flags');
  });
  it('inventories without reading or writing objects in dry run', async () => {
    const source = memoryStore({ [key]: contents, 'static/v1/manifest.json': Buffer.from('{}') });
    const destination = memoryStore();
    await expect(migrateStaticAssets(source, destination, 'dry-run')).resolves.toEqual({
      sourceObjects: 1,
      missingObjects: 1,
      copiedObjects: 0,
    });
    expect(source.get).not.toHaveBeenCalled();
    expect(destination.put).not.toHaveBeenCalled();
  });
  it('copies historical objects with all portable metadata and checksum then reruns without PUTs', async () => {
    const source = memoryStore({ [key]: contents });
    const destination = memoryStore();
    expect((await migrateStaticAssets(source, destination, 'apply')).copiedObjects).toBe(1);
    expect(destination.put).toHaveBeenCalledWith(
      key,
      contents,
      expect.objectContaining({
        contentType: 'image/webp',
        contentDisposition: 'inline',
        contentEncoding: 'identity',
        contentLanguage: 'en',
        expires: new Date('2030-01-01'),
        metadata: { source: 'historical' },
      }),
      createHash('sha256').update(contents).digest('base64'),
    );
    expect((await migrateStaticAssets(source, destination, 'apply')).copiedObjects).toBe(0);
    expect(destination.put).toHaveBeenCalledTimes(3);
    await expect(migrateStaticAssets(source, destination, 'verify-only')).resolves.toMatchObject({ copiedObjects: 0 });
  });
  it('rejects unknown keys before any writes', async () => {
    const source = memoryStore({ [key]: contents, 'static/v1/unknown.png': contents });
    const destination = memoryStore();
    await expect(migrateStaticAssets(source, destination, 'apply')).rejects.toThrow('Unknown immutable');
    expect(destination.put).not.toHaveBeenCalled();
  });
  it('rejects unknown destination keys before writes', async () => {
    const destination = memoryStore({ 'static/v1/unknown.png': contents });
    await expect(migrateStaticAssets(memoryStore({ [key]: contents }), destination, 'apply')).rejects.toThrow(
      'Unknown immutable',
    );
    expect(destination.put).not.toHaveBeenCalled();
  });
  it('rejects same-sized corrupt destination bodies without overwrite', async () => {
    const destination = memoryStore({ [key]: Buffer.alloc(contents.length) });
    await expect(migrateStaticAssets(memoryStore({ [key]: contents }), destination, 'apply')).rejects.toThrow(
      'Corrupt immutable',
    );
    expect(destination.put).not.toHaveBeenCalled();
  });
  it('rejects corrupt source objects before upload', async () => {
    const destination = memoryStore();
    await expect(
      migrateStaticAssets(memoryStore({ [key]: Buffer.alloc(contents.length) }), destination, 'apply'),
    ).rejects.toThrow('Corrupt immutable');
    expect(destination.put).not.toHaveBeenCalled();
  });
  it('rejects metadata differences even with matching bytes', async () => {
    const destination = memoryStore({ [key]: contents });
    destination.get = vi.fn(async () => ({ ...storedAsset(), cacheControl: 'no-cache' }));
    await expect(migrateStaticAssets(memoryStore({ [key]: contents }), destination, 'verify-only')).rejects.toThrow(
      'metadata mismatch',
    );
  });
  it('fails missing verify-only objects without writing', async () => {
    const destination = memoryStore();
    await expect(migrateStaticAssets(memoryStore({ [key]: contents }), destination, 'verify-only')).rejects.toThrow(
      'Missing historical assets',
    );
    expect(destination.put).not.toHaveBeenCalled();
  });
  it.each([false, true])('verifies a raced conditional-write object (corrupt=%s)', async (corrupt) => {
    const destination = memoryStore();
    let written = false;
    destination.put = vi.fn(async () => {
      written = true;
      throw { $metadata: { httpStatusCode: 412 } };
    });
    destination.get = vi.fn(async () =>
      written ? storedAsset(corrupt ? Buffer.alloc(contents.length) : contents) : undefined,
    );
    const migration = migrateStaticAssets(memoryStore({ [key]: contents }), destination, 'apply');
    if (corrupt) await expect(migration).rejects.toThrow('Corrupt immutable');
    else await expect(migration).resolves.toMatchObject({ copiedObjects: 0 });
  });
  it('resumes an interrupted copy without overwriting the completed object', async () => {
    const destination = memoryStore();
    const originalGet = destination.get;
    let interrupted = false;
    destination.get = async (objectKey) => {
      if (!interrupted && vi.mocked(destination.put).mock.calls.length) {
        interrupted = true;
        throw new Error('Interrupted');
      }
      return originalGet(objectKey);
    };
    const source = memoryStore({ [key]: contents });
    await expect(migrateStaticAssets(source, destination, 'apply')).rejects.toThrow('Interrupted');
    await expect(migrateStaticAssets(source, destination, 'apply')).resolves.toMatchObject({ copiedObjects: 0 });
    expect(destination.put).toHaveBeenCalledTimes(2);
  });
  it('follows listing pages and excludes the mutable manifest', async () => {
    const source = memoryStore();
    source.list = vi
      .fn()
      .mockResolvedValueOnce({ keys: ['static/v1/manifest.json'], truncated: true, nextToken: 'next' })
      .mockResolvedValueOnce({ keys: [key], truncated: false });
    await expect(inventoryAssets(source)).resolves.toEqual([key]);
    expect(source.list).toHaveBeenLastCalledWith('next');
  });
  it('rejects empty source inventory outside dry run', async () => {
    await expect(migrateStaticAssets(memoryStore(), memoryStore(), 'apply')).rejects.toThrow('Empty historical');
  });
  it('proves provider conditional writes even when all objects already exist', async () => {
    const destination = memoryStore({ [key]: contents });
    destination.put = vi.fn(async () => {});
    await expect(migrateStaticAssets(memoryStore({ [key]: contents }), destination, 'apply')).rejects.toThrow(
      'Conditional-write protection',
    );
  });
  it('accepts only R2 destination and legacy source account endpoints', () => {
    const r2 = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
    expect(() => assertMigrationEndpoints('https://fly.storage.tigris.dev', r2)).not.toThrow();
    expect(() => assertMigrationEndpoints('https://t3.storage.dev', r2)).not.toThrow();
    expect(() => assertMigrationEndpoints('https://arbitrary.example', r2)).toThrow('pre-cutover');
    expect(() => assertMigrationEndpoints(r2, r2)).toThrow('pre-cutover');
    expect(() => assertMigrationEndpoints('https://user:secret@fly.storage.tigris.dev', r2)).toThrow('pre-cutover');
    expect(() => assertMigrationEndpoints('https://fly.storage.tigris.dev/other', r2)).toThrow('pre-cutover');
    expect(() => assertMigrationEndpoints('https://fly.storage.tigris.dev', 'https://fly.storage.tigris.dev')).toThrow(
      'R2 HTTPS',
    );
  });
  it('destroys a stalled response body after the explicit read deadline', async () => {
    vi.useFakeTimers();
    try {
      const body = new PassThrough();
      const consume = (async () => {
        for await (const _chunk of boundedAssetBody(body, key, 100)) {
          /* Drain the body. */
        }
      })();
      const failure = expect(consume).rejects.toThrow('Asset body read timed out');
      await vi.advanceTimersByTimeAsync(100);
      await failure;
      expect(body.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('reads a normal response and destroys it without leaving a timeout', async () => {
    const body = Readable.from([contents]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of boundedAssetBody(body, key, 100)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(contents);
    expect(body.destroyed).toBe(true);
  });
  it('rejects and destroys a response whose deadline elapsed before consumption', async () => {
    vi.useFakeTimers();
    try {
      const body = new PassThrough();
      const bounded = boundedAssetBody(body, key, 100);
      await vi.advanceTimersByTimeAsync(100);
      const consume = (async () => {
        for await (const _chunk of bounded) {
          /* Drain the body. */
        }
      })();
      await expect(consume).rejects.toThrow('Asset body read timed out');
      expect(body.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([undefined, 'repeated'])('rejects incomplete or looping pagination (%s)', async (nextToken) => {
    const source = memoryStore();
    source.list = vi.fn(async () => ({ keys: [], truncated: true, nextToken }));
    await expect(inventoryAssets(source)).rejects.toThrow('continuation token');
  });
});
