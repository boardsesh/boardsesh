import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
  published: [] as string[],
  writtenBytes: 0,
  diskBytes: 1024 * 1024 * 1024,
  fetch: vi.fn(),
  hash: (_bytes: Uint8Array): string => '',
  asset: {
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 25,
    geometryId: '0'.repeat(64),
    formatRevision: 2,
    atlasFormatRevision: 2,
    outputWidth: 1080,
    outputHeight: 1504,
    sha256: '',
    bytes: 4,
    maxReach: 60,
    pulseReach: 1.35,
    objectKey: '',
  },
}));

vi.mock('expo/fetch', () => ({ fetch: runtime.fetch }));
vi.mock('../../../offline/offline-sync-adapter', () => ({ isOnUnmeteredNetwork: async () => true }));
vi.mock('../generated/manifest.json', () => ({ default: { version: 1, assets: [runtime.asset] } }));
vi.mock('expo-file-system', () => {
  function uri(parts: (string | { uri: string })[]) {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    create() {
      runtime.directories.add(this.uri);
    }
    get exists() {
      return runtime.directories.has(this.uri);
    }
    list() {
      return [...runtime.files.keys()]
        .filter((path) => path.startsWith(`${this.uri}/`) && !path.slice(this.uri.length + 1).includes('/'))
        .map((path) => new File(path));
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get size() {
      return runtime.files.get(this.uri)?.byteLength ?? 0;
    }
    get exists() {
      return runtime.files.has(this.uri);
    }
    get lastModified() {
      return 1;
    }
    create() {
      runtime.files.set(this.uri, new Uint8Array());
    }
    delete() {
      runtime.files.delete(this.uri);
    }
    writeSync(contents: string) {
      runtime.files.set(this.uri, new TextEncoder().encode(contents));
    }
    async digest() {
      return runtime.hash(runtime.files.get(this.uri) ?? new Uint8Array());
    }
    moveSync(destination: File) {
      runtime.files.set(destination.uri, runtime.files.get(this.uri) ?? new Uint8Array());
      runtime.files.delete(this.uri);
      // Expo's native File object follows its new address after relocation.
      this.uri = destination.uri;
      runtime.published.push(destination.uri);
    }
    open() {
      return {
        writeBytes: async (chunk: Uint8Array) => {
          const current = runtime.files.get(this.uri) ?? new Uint8Array();
          const appended = new Uint8Array(current.byteLength + chunk.byteLength);
          appended.set(current);
          appended.set(chunk, current.byteLength);
          runtime.files.set(this.uri, appended);
          runtime.writtenBytes += chunk.byteLength;
        },
        close() {},
      };
    }
  }
  return {
    File,
    Directory,
    FileMode: { WriteOnly: 'w' },
    Paths: {
      cache: 'file:///cache',
      get availableDiskSpace() {
        return runtime.diskBytes;
      },
    },
  };
});

function response(chunks: Uint8Array[], interrupted = false): Response {
  const result = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (interrupted) controller.error(new Error('connection lost'));
        else controller.close();
      },
    }),
    { headers: { 'content-length': '4' } },
  );
  Object.defineProperty(result, 'url', { value: `https://assets.boardsesh.com/${runtime.asset.objectKey}` });
  return result;
}

beforeEach(() => {
  vi.resetModules();
  runtime.files.clear();
  runtime.directories.clear();
  runtime.published = [];
  runtime.writtenBytes = 0;
  runtime.diskBytes = 1024 * 1024 * 1024;
  runtime.fetch.mockReset();
  runtime.hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  runtime.asset.sha256 = runtime.hash(new Uint8Array([1, 2, 3, 4]));
  runtime.asset.objectKey = `static/v1/${runtime.asset.sha256}.aura`;
});

describe('native Aura acceleration storage', () => {
  it('streams bounded chunks and publishes only the complete checksum-verified file', async () => {
    runtime.fetch.mockResolvedValue(response([new Uint8Array([1, 2]), new Uint8Array([3, 4])]));
    const { auraGeometryCache } = await import('../native-store');
    await auraGeometryCache.prefetch(runtime.asset, []);
    const path = auraGeometryCache.chooseLocal(runtime.asset);
    expect(path).toBe(`file:///cache/aura-geometry-v2/${runtime.asset.sha256}.aura`);
    expect(runtime.published).toEqual([path]);
    expect([...runtime.files.keys()].some((file) => file.endsWith('.part'))).toBe(false);
  });

  it('discards truncated and checksum-mismatched bodies before publication', async () => {
    for (const chunks of [[new Uint8Array([1, 2])], [new Uint8Array([9, 8, 7, 6])]]) {
      runtime.fetch.mockResolvedValue(response(chunks));
      const { auraGeometryCache } = await import('../native-store');
      await auraGeometryCache.prefetch(runtime.asset, []);
      expect(auraGeometryCache.chooseLocal(runtime.asset)).toBeNull();
      expect(runtime.published).toEqual([]);
      expect(runtime.files.size).toBe(0);
    }
  });

  it('rejects an oversized body before writing beyond the declared ceiling', async () => {
    runtime.fetch.mockResolvedValue(response([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]));
    const { auraGeometryCache } = await import('../native-store');
    await auraGeometryCache.prefetch(runtime.asset, []);
    expect(runtime.writtenBytes).toBeLessThanOrEqual(runtime.asset.bytes);
    expect(runtime.published).toEqual([]);
    expect(runtime.files.size).toBe(0);
  });

  it('leaves generation available after disk exhaustion and interrupted downloads', async () => {
    runtime.diskBytes = 0;
    const { auraGeometryCache } = await import('../native-store');
    await auraGeometryCache.prefetch(runtime.asset, []);
    expect(runtime.fetch).not.toHaveBeenCalled();
    runtime.diskBytes = 1024 * 1024 * 1024;
    runtime.fetch.mockResolvedValue(response([new Uint8Array([1, 2])], true));
    await auraGeometryCache.prefetch(runtime.asset, []);
    expect(auraGeometryCache.chooseLocal(runtime.asset)).toBeNull();
    expect(runtime.files.size).toBe(0);
  });

  it('removes interrupted leftovers and writes only complete offline-retention preferences', async () => {
    runtime.files.set('file:///cache/aura-geometry-v2/old.part', new Uint8Array([1, 2]));
    runtime.fetch.mockResolvedValue(response([new Uint8Array([1, 2, 3, 4])]));
    const { auraGeometryCache, rememberAuraOfflineScopes, selectAuraGeometryPaths } = await import('../native-store');
    await auraGeometryCache.prefetch(runtime.asset, []);
    expect(runtime.files.has('file:///cache/aura-geometry-v2/old.part')).toBe(false);
    rememberAuraOfflineScopes([runtime.asset, runtime.asset, { boardType: 'spray', layoutId: 1, sizeId: 1 }]);
    expect(new TextDecoder().decode(runtime.files.get('file:///cache/aura-generated-v2/.offline-scopes.json'))).toBe(
      '["kilter/8-25"]',
    );
    expect(selectAuraGeometryPaths(runtime.asset, 1080, 1504)).toMatchObject({
      geometryAssetSha256: runtime.asset.sha256,
      generatedGeometryDirectory: 'file:///cache/aura-generated-v2',
    });
    expect(selectAuraGeometryPaths(runtime.asset, 768, 1070).geometryAssetPath).toBeNull();
  });
});
