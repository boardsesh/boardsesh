// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listOverlayCacheEntries } from '../overlay-cache-warmup.web';
import {
  hydrateOverlayCache,
  writeOverlayToCache,
  _overlayCacheStoreForTests,
} from '../../../modules/board-renderer/src/overlay-cache-store.web';

class FakeResponse {
  constructor(private readonly body: Blob) {}
  blob(): Promise<Blob> {
    return Promise.resolve(this.body);
  }
}

const requestUrl = (request: string | { url: string }): string => (typeof request === 'string' ? request : request.url);

function installCaches() {
  const store = new Map<string, FakeResponse>();
  const cache = {
    put: vi.fn((request: string | { url: string }, response: FakeResponse) => {
      store.set(requestUrl(request), response);
      return Promise.resolve();
    }),
    match: vi.fn((request: string | { url: string }) => Promise.resolve(store.get(requestUrl(request)))),
    delete: vi.fn((request: string | { url: string }) => Promise.resolve(store.delete(requestUrl(request)))),
    keys: vi.fn(() => Promise.resolve(Array.from(store.keys()).map((url) => ({ url })))),
  };
  vi.stubGlobal('caches', { open: vi.fn(() => Promise.resolve(cache)) });
  return { store, cache };
}

let objectUrlCounter = 0;
let revokeObjectUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  objectUrlCounter = 0;
  revokeObjectUrl = vi.fn();
  vi.stubGlobal('Response', FakeResponse);
  vi.stubGlobal('Blob', class FakeBlob {});
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:warm/${++objectUrlCounter}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
  _overlayCacheStoreForTests.renderedObjectUrls.clear();
  _overlayCacheStoreForTests.resetHydration();
});

afterEach(() => {
  _overlayCacheStoreForTests.renderedObjectUrls.clear();
  _overlayCacheStoreForTests.resetHydration();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('listOverlayCacheEntries (web warmup)', () => {
  it('returns null before anything has hydrated', () => {
    installCaches();
    expect(listOverlayCacheEntries('board-thumbnails')).toBeNull();
  });

  it('surfaces hydrated overlays as version-prefixed .png entries the hook can match', async () => {
    installCaches();
    await writeOverlayToCache('v3_s_wfull_kilter_1_2_25_zzz', new Blob() as Blob);
    _overlayCacheStoreForTests.renderedObjectUrls.clear();
    _overlayCacheStoreForTests.resetHydration();

    await hydrateOverlayCache();

    const entries = listOverlayCacheEntries('board-thumbnails');
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries?.[0].name).toBe('v3_s_wfull_kilter_1_2_25_zzz.png');
    expect(entries?.[0].uri).toMatch(/^blob:warm\//);
    expect(typeof entries?.[0].delete).toBe('function');
  });

  it('exposes a delete that drops the persisted overlay (stale-version cleanup)', async () => {
    const { store } = installCaches();
    await writeOverlayToCache('v1_s_wfull_kilter_1_2_25_stale', new Blob() as Blob);
    _overlayCacheStoreForTests.renderedObjectUrls.clear();
    _overlayCacheStoreForTests.resetHydration();
    await hydrateOverlayCache();

    const entries = listOverlayCacheEntries('board-thumbnails');
    entries?.[0].delete?.();
    // delete is fire-and-forget; let its microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(revokeObjectUrl).toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});
