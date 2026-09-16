import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetFileSystem, __setDownloadHandler } from '../../../../test/expo-file-system-stub';
import type { ModelStoreIo } from '../model-store';
import {
  DOWNLOAD_TIMEOUT_MS,
  MANIFEST_TIMEOUT_MS,
  MAX_CACHED_VERSIONS,
  MEDIA_BASE_URL,
  MODEL_CACHE_DIR,
  ensureModel,
  expoModelStoreIo,
  resetVerifiedModelCache,
  sweepModelVersions,
} from '../model-store';

const VERSION = '2026-09-15';
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: VERSION,
    family: 'rfdetr',
    config: 'nano-untiled-1024',
    input: {
      width: 768,
      height: 768,
      layout: 'NCHW',
      dtype: 'float32',
      letterbox: 'stretch',
      normalization: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
    },
    outputs: {
      boxes: { name: null, format: 'cxcywh-normalized' },
      logits: { name: null, activation: 'sigmoid', classes: 1 },
    },
    thresholds: { default: 0.6, sweep: [0.3, 0.5, 0.6] },
    files: [{ path: 'model-int8.onnx', bytes: 31_300_000, sha256: SHA, dtype: 'int8' }],
    training: { dataset: 'spray walls', licence: 'CC BY 4.0', epochs: 10, trainedOn: 'm5-max-mps', date: '2026-09-15' },
    licence: 'Apache-2.0',
    ...overrides,
  };
}

interface FakeIoOptions {
  manifest?: unknown;
  /** Digest `hashFile` reports, or null for an unreadable file. */
  digest?: string | null;
  /** Versions already on disk, newest first. */
  cached?: string[];
  /** Files already present, keyed `<version>/<name>`. */
  present?: string[];
  downloadFails?: boolean;
}

interface FakeIo extends ModelStoreIo {
  calls: { fetched: string[]; downloaded: string[]; removed: string[]; hashed: number };
}

function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const cached = [...(options.cached ?? [])];
  const present = new Set(options.present ?? []);
  const calls = { fetched: [] as string[], downloaded: [] as string[], removed: [] as string[], hashed: 0 };

  return {
    calls,
    async fetchJson(url) {
      calls.fetched.push(url);
      return 'manifest' in options ? options.manifest : manifestBody();
    },
    async download(url, version, fileName) {
      calls.downloaded.push(url);
      if (options.downloadFails) return null;
      present.add(`${version}/${fileName}`);
      if (!cached.includes(version)) cached.unshift(version);
      return `file:///cache/hold-detector/${version}/${fileName}`;
    },
    find(version, fileName) {
      return present.has(`${version}/${fileName}`) ? `file:///cache/hold-detector/${version}/${fileName}` : null;
    },
    async hashFile() {
      calls.hashed += 1;
      return options.digest === undefined ? SHA : options.digest;
    },
    listVersions() {
      return [...cached];
    },
    removeVersion(version) {
      calls.removed.push(version);
      const at = cached.indexOf(version);
      if (at >= 0) cached.splice(at, 1);
      for (const key of [...present]) if (key.startsWith(`${version}/`)) present.delete(key);
    },
  };
}

// The verified set is module state, so a test that left an entry behind would
// make the next one's "did it re-hash?" assertion meaningless.
beforeEach(() => {
  resetVerifiedModelCache();
});

describe('ensureModel', () => {
  it('downloads, verifies and returns a handle', async () => {
    const io = fakeIo();
    const stages: string[] = [];

    const handle = await ensureModel(VERSION, { io, onStage: (stage) => stages.push(stage) });

    expect(handle).toEqual({
      version: VERSION,
      manifest: expect.objectContaining({ version: VERSION, config: 'nano-untiled-1024' }),
      uri: `file:///cache/hold-detector/${VERSION}/model-int8.onnx`,
      trainedInputSize: 768,
      defaultThreshold: 0.6,
      bytes: 31_300_000,
    });
    expect(stages).toEqual(['manifest', 'download', 'verify']);
    expect(io.calls.fetched).toEqual([`${MEDIA_BASE_URL}/models/hold-detector/${VERSION}/manifest.json`]);
    expect(io.calls.downloaded).toEqual([`${MEDIA_BASE_URL}/models/hold-detector/${VERSION}/model-int8.onnx`]);
  });

  it('skips the download when the file is already cached', async () => {
    const io = fakeIo({ cached: [VERSION], present: [`${VERSION}/model-int8.onnx`] });

    const handle = await ensureModel(VERSION, { io });

    expect(handle?.version).toBe(VERSION);
    expect(io.calls.downloaded).toEqual([]);
  });

  it('returns null and deletes the version when the sha256 does not match', async () => {
    const io = fakeIo({ digest: OTHER_SHA });

    const handle = await ensureModel(VERSION, { io });

    expect(handle).toBeNull();
    // Not just null: the bad bytes must go, or the next launch takes them as a
    // cache hit and never re-downloads.
    expect(io.calls.removed).toEqual([VERSION]);
    expect(io.find(VERSION, 'model-int8.onnx')).toBeNull();
  });

  it('returns null and deletes the version when the file cannot be read back', async () => {
    const io = fakeIo({ digest: null });

    expect(await ensureModel(VERSION, { io })).toBeNull();
    expect(io.calls.removed).toEqual([VERSION]);
  });

  it('returns null when offline, without touching the disk', async () => {
    const io = fakeIo({ manifest: null });

    expect(await ensureModel(VERSION, { io })).toBeNull();
    expect(io.calls.downloaded).toEqual([]);
    expect(io.calls.removed).toEqual([]);
  });

  it('returns null when the download fails part-way', async () => {
    const io = fakeIo({ downloadFails: true });

    expect(await ensureModel(VERSION, { io })).toBeNull();
  });

  it('returns null when the manifest does not validate', async () => {
    const io = fakeIo({ manifest: manifestBody({ schemaVersion: 2 }) });

    expect(await ensureModel(VERSION, { io })).toBeNull();
    expect(io.calls.downloaded).toEqual([]);
  });

  it('returns null when the manifest names a different version than its prefix', async () => {
    const io = fakeIo({ manifest: manifestBody({ version: '2026-01-01' }) });

    expect(await ensureModel(VERSION, { io })).toBeNull();
  });

  it('returns null when the manifest ships no int8 export', async () => {
    const io = fakeIo({
      manifest: manifestBody({
        files: [{ path: 'model-fp32.onnx', bytes: 107_000_000, sha256: SHA, dtype: 'fp32' }],
      }),
    });

    expect(await ensureModel(VERSION, { io })).toBeNull();
    expect(io.calls.downloaded).toEqual([]);
  });

  it('evicts down to two versions after a successful load', async () => {
    const io = fakeIo({ cached: ['2026-09-10', '2026-09-05', '2026-08-01'] });

    const handle = await ensureModel(VERSION, { io });

    expect(handle?.version).toBe(VERSION);
    // The new version plus the most recently modified other one survive.
    expect(io.listVersions().sort()).toEqual([VERSION, '2026-09-10'].sort());
    expect(io.calls.removed).toEqual(['2026-09-05', '2026-08-01']);
  });
});

describe('ensureModel verification cache', () => {
  it('does not re-hash the same bytes twice in one process', async () => {
    const io = fakeIo();

    await ensureModel(VERSION, { io });
    const stages: string[] = [];
    const second = await ensureModel(VERSION, { io, onStage: (stage) => stages.push(stage) });

    expect(second?.version).toBe(VERSION);
    expect(io.calls.hashed).toBe(1);
    // The screen must not claim to be verifying when it is not.
    expect(stages).toEqual(['manifest']);
  });

  it('re-hashes after a cold start', async () => {
    const io = fakeIo();

    await ensureModel(VERSION, { io });
    resetVerifiedModelCache();
    await ensureModel(VERSION, { io });

    expect(io.calls.hashed).toBe(2);
  });

  it('re-hashes when the manifest starts expecting different bytes', async () => {
    // The manifest is the one mutable pointer: a re-publish can change the
    // expected digest under a version tag, and a pass recorded against the old
    // one says nothing about the new.
    const first = fakeIo();
    await ensureModel(VERSION, { io: first });

    const republished = fakeIo({
      manifest: manifestBody({
        files: [{ path: 'model-int8.onnx', bytes: 31_300_000, sha256: OTHER_SHA, dtype: 'int8' }],
      }),
      digest: OTHER_SHA,
      cached: [VERSION],
      present: [`${VERSION}/model-int8.onnx`],
    });
    const handle = await ensureModel(VERSION, { io: republished });

    expect(handle?.version).toBe(VERSION);
    expect(republished.calls.hashed).toBe(1);
  });

  it('does not remember a version whose digest did not match', async () => {
    const bad = fakeIo({ digest: OTHER_SHA });
    expect(await ensureModel(VERSION, { io: bad })).toBeNull();

    const good = fakeIo();
    await ensureModel(VERSION, { io: good });

    expect(good.calls.hashed).toBe(1);
  });
});

describe('sweepModelVersions', () => {
  it('keeps the named version even when it is the oldest on disk', () => {
    const io = fakeIo({ cached: ['2026-09-10', '2026-09-05', VERSION] });

    const removed = sweepModelVersions(io, VERSION);

    expect(io.listVersions()).toContain(VERSION);
    expect(io.listVersions()).toHaveLength(MAX_CACHED_VERSIONS);
    expect(removed).toEqual(['2026-09-05']);
  });

  it('removes nothing when the cache is already within budget', () => {
    const io = fakeIo({ cached: [VERSION] });

    expect(sweepModelVersions(io, VERSION)).toEqual([]);
  });
});

describe('expoModelStoreIo.fetchJson', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The stall this exists for: a connection that is open and silent. It never
  // rejects on its own, and the benchmark screen shows a spinner with no cancel,
  // so before the deadline the only way out was to kill the app.
  it('resolves null once the deadline passes on a fetch that never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // Deliberately never settles, and ignores the abort signal the way a
            // platform fetch that drops signal support would.
          }),
      ),
    );

    const pending = expoModelStoreIo.fetchJson(`${MEDIA_BASE_URL}/models/hold-detector/x/manifest.json`);
    await vi.advanceTimersByTimeAsync(MANIFEST_TIMEOUT_MS + 1);

    await expect(pending).resolves.toBeNull();
  });

  it('passes an abort signal so the socket is actually torn down', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { signal?: unknown }) => ({
      ok: true,
      json: async () => ({ schemaVersion: 1 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expoModelStoreIo.fetchJson('https://example.test/manifest.json');

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('still returns a parsed body well inside the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1 }) })),
    );

    await expect(expoModelStoreIo.fetchJson('https://example.test/manifest.json')).resolves.toEqual({
      schemaVersion: 1,
    });
  });

  // Headers in a second, body never. The deadline has to cover the body read too,
  // or it has already cleared its timer by the time the stall starts.
  it('resolves null once the deadline passes on a body that never arrives', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })),
    );

    const pending = expoModelStoreIo.fetchJson('https://example.test/manifest.json');
    await vi.advanceTimersByTimeAsync(MANIFEST_TIMEOUT_MS + 1);

    await expect(pending).resolves.toBeNull();
  });
});

describe('expoModelStoreIo.download', () => {
  afterEach(() => {
    __resetFileSystem();
    vi.useRealTimers();
  });

  it('hands the native transfer an abort signal, so a timeout cancels the bytes too', async () => {
    let handed: AbortSignal | undefined;
    __setDownloadHandler((_url, _destination, options) => {
      handed = options?.signal;
    });

    const uri = await expoModelStoreIo.download('https://example.test/model-int8.onnx', VERSION, 'model-int8.onnx');

    expect(uri).toBe(`cache/${MODEL_CACHE_DIR}/${VERSION}/model-int8.onnx`);
    expect(handed).toBeInstanceOf(AbortSignal);
  });

  it('resolves null once the deadline passes on a transfer that never settles', async () => {
    vi.useFakeTimers();
    __setDownloadHandler(() => new Promise(() => {}));

    const pending = expoModelStoreIo.download('https://example.test/model-int8.onnx', VERSION, 'model-int8.onnx');
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS + 1);

    await expect(pending).resolves.toBeNull();
  });
});
