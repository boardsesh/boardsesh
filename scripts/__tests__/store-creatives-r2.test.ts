import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createCreativeStore,
  parseCreativeManifest,
  runCreativeStorage,
  sha256Creative,
  type CreativeManifest,
  type CreativeStore,
} from '../store-creatives-r2';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'store-r2-'));
  directories.push(root);
  const manifest = JSON.parse(readFileSync('app-stores/apple/creative-assets.json', 'utf8')) as CreativeManifest;
  const file = '.boardsesh/app-store-creatives/moonboard/en-US/search-results.mp4';
  const proof = '.boardsesh/app-store-creatives/moonboard/en-US/search-results.manifest.json';
  const video = Buffer.from('video');
  const provenance = Buffer.from('{}');
  for (const [path, bytes] of [
    [file, video],
    [proof, provenance],
  ] as const) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  manifest.variants.moonboard.assets = [
    {
      locale: 'en-US',
      placement: 'search-results',
      file,
      sha256: sha256Creative(video),
      provenance: proof,
      provenanceSha256: sha256Creative(provenance),
      specId: 'search',
      placementGroup: 'search',
    },
  ];
  const objects = new Map<string, Uint8Array>();
  const store: CreativeStore = {
    head: vi.fn(async (key) => objects.has(key)),
    put: vi.fn(async (key, bytes) => {
      objects.set(key, bytes);
    }),
    copy: vi.fn(async (source, destination) => {
      objects.set(destination, objects.get(source)!);
    }),
    get: vi.fn(async (key) => {
      if (!objects.has(key)) throw new Error('missing');
      return objects.get(key)!;
    }),
  };
  return { root, manifest, objects, store, video, file };
}
describe('content-addressed store creative storage', () => {
  it('accepts the storage manifest and rejects unsafe paths, duplicate identities, release schema, and incomplete poster hashes', () => {
    const { manifest } = fixture();
    expect(parseCreativeManifest(manifest)).toEqual(manifest);
    for (const update of [
      { file: '.boardsesh/app-store-creatives/moonboard/en-US/../../bad.mp4' },
      { poster: '.boardsesh/app-store-creatives/moonboard/en-US/poster.jpg' },
    ]) {
      const broken = structuredClone(manifest);
      Object.assign(broken.variants.moonboard.assets[0], update);
      expect(() => parseCreativeManifest(broken)).toThrow();
    }
    const duplicate = structuredClone(manifest);
    duplicate.variants.moonboard.assets.push(duplicate.variants.moonboard.assets[0]);
    expect(() => parseCreativeManifest(duplicate)).toThrow('Duplicate');
    expect(() => parseCreativeManifest({ ...manifest, release: 'old' })).toThrow('schema');
  });
  it('uploads once, promotes server-side, then fetches verified originals', async () => {
    const { root, manifest, objects, store, video, file } = fixture();
    expect(await runCreativeStorage({ action: 'upload-candidates', root, manifest, store })).toEqual({
      objects: 2,
      changed: 2,
    });
    expect(await runCreativeStorage({ action: 'upload-candidates', root, manifest, store })).toEqual({
      objects: 2,
      changed: 0,
    });
    expect(await runCreativeStorage({ action: 'promote', manifest, store })).toEqual({ objects: 2, changed: 2 });
    expect(store.copy).toHaveBeenCalledTimes(2);
    const output = join(root, 'download');
    await runCreativeStorage({ action: 'fetch', root, output, manifest, store });
    expect(readFileSync(join(output, 'moonboard/en-US/search-results.mp4'))).toEqual(video);
    expect(objects.has(`approved/${manifest.variants.moonboard.assets[0].sha256}.mp4`)).toBe(true);
    expect(existsSync(join(root, file))).toBe(true);
  });
  it('refuses expired candidates and preserves authorization errors', async () => {
    const { manifest, store } = fixture();
    await expect(runCreativeStorage({ action: 'promote', manifest, store })).rejects.toThrow('expired');
    const denied = createCreativeStore({
      send: async () => {
        throw { $metadata: { httpStatusCode: 403 } };
      },
    } as unknown as Parameters<typeof createCreativeStore>[0]);
    await expect(denied.head('candidates/missing')).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });
  it('verifies all upload bytes before any write and removes partial or stale downloads on mismatch', async () => {
    const { root, manifest, objects, store, file } = fixture();
    writeFileSync(join(root, file), 'corrupt');
    await expect(runCreativeStorage({ action: 'upload-candidates', root, manifest, store })).rejects.toThrow('SHA256');
    expect(store.put).not.toHaveBeenCalled();
    const output = join(root, 'download');
    mkdirSync(output);
    writeFileSync(join(output, 'stale'), 'old');
    objects.set(`approved/${manifest.variants.moonboard.assets[0].sha256}.mp4`, Buffer.from('corrupt'));
    await expect(runCreativeStorage({ action: 'fetch', root, output, manifest, store })).rejects.toThrow('SHA256');
    expect(existsSync(output)).toBe(false);
  });
  it('dry run promotion checks candidates without copying', async () => {
    const { manifest, store, objects } = fixture();
    for (const asset of manifest.variants.moonboard.assets) {
      objects.set(`candidates/${asset.sha256}.mp4`, Buffer.from('video'));
      objects.set(`candidates/${asset.provenanceSha256}.json`, Buffer.from('{}'));
    }
    expect(await runCreativeStorage({ action: 'promote', manifest, store, placement: 'search', dryRun: true })).toEqual(
      { objects: 2, changed: 0 },
    );
    expect(store.head).toHaveBeenCalled();
    expect(store.copy).not.toHaveBeenCalled();
    objects.clear();
    await expect(runCreativeStorage({ action: 'promote', manifest, store, dryRun: true })).rejects.toThrow('expired');
  });
});
