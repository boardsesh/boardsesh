// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readOverlayFromCache,
  writeOverlayToCache,
  hydrateOverlayCache,
  snapshotOverlayEntries,
  deleteOverlayFromCache,
  releaseAllObjectUrls,
  getRenderedObjectUrl,
  _overlayCacheStoreForTests,
} from '../../../modules/board-renderer/src/overlay-cache-store.web';
import { renderHoldsOverlay, _webRendererForTests } from '../../../modules/board-renderer/src/index.web';
import { currentOverlayVersionPrefix } from '../../hooks/renderer-version';

// --- Fakes for the browser storage/encoding APIs jsdom does not implement ---

class FakeResponse {
  constructor(private readonly body: Blob) {}
  blob(): Promise<Blob> {
    return Promise.resolve(this.body);
  }
}

// The real Cache API accepts a Request or a URL string for match/put/delete;
// keys() returns Request objects. Normalize both shapes to the URL string key.
const requestUrl = (request: string | { url: string }): string => (typeof request === 'string' ? request : request.url);

function makeCacheStorage() {
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
  return { caches: { open: vi.fn(() => Promise.resolve(cache)) }, cache, store };
}

let objectUrlCounter = 0;
let createObjectUrl: ReturnType<typeof vi.fn>;
let revokeObjectUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  objectUrlCounter = 0;
  createObjectUrl = vi.fn(() => `blob:overlay/${++objectUrlCounter}`);
  revokeObjectUrl = vi.fn();
  vi.stubGlobal('Response', FakeResponse);
  vi.stubGlobal('Blob', class FakeBlob {});
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
});

afterEach(() => {
  _overlayCacheStoreForTests.renderedObjectUrls.clear();
  _overlayCacheStoreForTests.resetHydration();
  _webRendererForTests.resetWorker();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installCaches() {
  const harness = makeCacheStorage();
  vi.stubGlobal('caches', harness.caches);
  return harness;
}

describe('overlay-cache-store persist + rehydrate', () => {
  it('round-trips: a written overlay is read back as a fresh object URL', async () => {
    installCaches();
    const blob = new Blob() as Blob;

    await writeOverlayToCache('v3_s_wfull_kilter_1_2_25_abc', blob);
    // A fresh session: no in-memory URL yet.
    _overlayCacheStoreForTests.renderedObjectUrls.clear();

    const url = await readOverlayFromCache('v3_s_wfull_kilter_1_2_25_abc');
    expect(url).toBe('blob:overlay/1');
    // The read retains the URL so a repeat lookup reuses it (no double-mint).
    expect(getRenderedObjectUrl('v3_s_wfull_kilter_1_2_25_abc')).toBe('blob:overlay/1');
    expect(await readOverlayFromCache('v3_s_wfull_kilter_1_2_25_abc')).toBe('blob:overlay/1');
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('returns undefined on a cache miss', async () => {
    installCaches();
    expect(await readOverlayFromCache('missing-key')).toBeUndefined();
  });

  it('degrades to in-memory-only when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    // Neither write nor read throws when storage is absent.
    await expect(writeOverlayToCache('k', new Blob() as Blob)).resolves.toBeUndefined();
    expect(await readOverlayFromCache('k')).toBeUndefined();
  });
});

describe('overlay-cache-store hydration + snapshot (warmup contract)', () => {
  it('hydrates persisted overlays into entries the shared hook can consume', async () => {
    const { cache } = installCaches();
    await writeOverlayToCache('v3_s_wfull_kilter_1_2_25_aaa', new Blob() as Blob);
    await writeOverlayToCache('v3_f_w400_kilter_1_2_25_bbb', new Blob() as Blob);
    // Simulate a reload: drop the in-memory URLs, keep the persisted bytes.
    _overlayCacheStoreForTests.renderedObjectUrls.clear();

    await hydrateOverlayCache();

    const entries = snapshotOverlayEntries();
    expect(entries).toHaveLength(2);
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(byName['v3_s_wfull_kilter_1_2_25_aaa.png'].uri).toMatch(/^blob:overlay\//);
    expect(byName['v3_f_w400_kilter_1_2_25_bbb.png'].uri).toMatch(/^blob:overlay\//);
    // keys() drove the enumeration.
    expect(cache.keys).toHaveBeenCalled();
  });

  it('deletes a persisted overlay and revokes its object URL', async () => {
    const { store } = installCaches();
    await writeOverlayToCache('v2_s_wfull_kilter_1_2_25_old', new Blob() as Blob);
    _overlayCacheStoreForTests.renderedObjectUrls.clear();
    await hydrateOverlayCache();
    expect(snapshotOverlayEntries()).toHaveLength(1);

    await deleteOverlayFromCache('v2_s_wfull_kilter_1_2_25_old');

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:overlay/1');
    expect(snapshotOverlayEntries()).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('prunes the Cache API beyond the hydrate limit so it can not grow unbounded', async () => {
    const { store } = installCaches();
    const limit = _overlayCacheStoreForTests.OVERLAY_HYDRATE_LIMIT;
    // Seed limit + 2 overlays in insertion order (oldest first). A Map preserves
    // insertion order, so cache.keys() returns them oldest → newest.
    for (let index = 0; index < limit + 2; index++) {
      await writeOverlayToCache(`overlay-key-${String(index).padStart(4, '0')}`, new Blob() as Blob);
    }
    _overlayCacheStoreForTests.renderedObjectUrls.clear();

    await hydrateOverlayCache();

    // The two oldest entries are evicted; the store is capped at the limit.
    expect(store.size).toBe(limit);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('overlay-key-0000'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('overlay-key-0001'))).toBe(false);
    expect(
      store.has(_overlayCacheStoreForTests.overlayKeyUrl(`overlay-key-${String(limit + 1).padStart(4, '0')}`)),
    ).toBe(true);
    // Only the most-recent limit entries hydrate into memory.
    expect(snapshotOverlayEntries()).toHaveLength(limit);
  });

  it('flushes shared web entries when the native and web renderer contract moves to v11', async () => {
    const { store } = installCaches();
    await writeOverlayToCache('v2_s_wfull_kilter_1_2_25_old', new Blob() as Blob);
    await writeOverlayToCache('v4_s_wfull_kilter_1_2_25_pre_atomic', new Blob() as Blob);
    // Drawn by the stale WASM artifact at the wrong stroke width (issue #4495).
    await writeOverlayToCache('v5_s_wfull_kilter_1_2_25_wrong_stroke', new Blob() as Blob);
    // Drawn before the Boardsesh drawing landed (issue #2202).
    await writeOverlayToCache('v6_s_wfull_kilter_1_2_25_pre_boardsesh', new Blob() as Blob);
    // Drawn before an annotated hold lit its LED base plate.
    await writeOverlayToCache('v7_s_wfull_kilter_1_2_25_pre_plate', new Blob() as Blob);
    // v8 was claimed by the Woods white-key branch, which landed on this same
    // line, so no shipped build ever published it — its PNGs are as invalid
    // here as any other generation's.
    await writeOverlayToCache('v8_s_wfull_kilter_1_2_25_never_published', new Blob() as Blob);
    // Drawn with the LED base plate lit — the build-6 look v11 exists to evict.
    await writeOverlayToCache('v9_s_wfull_kilter_1_2_25_lit_plate', new Blob() as Blob);
    await writeOverlayToCache('v12_s_wfull_kilter_1_2_25_keep', new Blob() as Blob);
    await writeOverlayToCache('v1_f_w400_kilter_1_2_25_ancient', new Blob() as Blob);
    _overlayCacheStoreForTests.renderedObjectUrls.clear();

    expect(currentOverlayVersionPrefix()).toBe('v12_');
    await hydrateOverlayCache(currentOverlayVersionPrefix());

    // Stale-version PNGs are deleted from the Cache API, not hydrated — so they
    // never burn a hydrate slot and are always reclaimed regardless of the
    // warm-up race.
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v2_s_wfull_kilter_1_2_25_old'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v4_s_wfull_kilter_1_2_25_pre_atomic'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v5_s_wfull_kilter_1_2_25_wrong_stroke'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v6_s_wfull_kilter_1_2_25_pre_boardsesh'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v1_f_w400_kilter_1_2_25_ancient'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v7_s_wfull_kilter_1_2_25_pre_plate'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v8_s_wfull_kilter_1_2_25_never_published'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v9_s_wfull_kilter_1_2_25_lit_plate'))).toBe(false);
    expect(store.has(_overlayCacheStoreForTests.overlayKeyUrl('v12_s_wfull_kilter_1_2_25_keep'))).toBe(true);
    const entries = snapshotOverlayEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('v12_s_wfull_kilter_1_2_25_keep.png');
  });

  it('releaseAllObjectUrls revokes every retained URL', async () => {
    installCaches();
    await writeOverlayToCache('k1', new Blob() as Blob);
    await writeOverlayToCache('k2', new Blob() as Blob);
    _overlayCacheStoreForTests.renderedObjectUrls.clear();
    await hydrateOverlayCache();
    expect(snapshotOverlayEntries()).toHaveLength(2);

    releaseAllObjectUrls();

    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    expect(snapshotOverlayEntries()).toHaveLength(0);
  });
});

describe('renderHoldsOverlay Cache-API integration', () => {
  // A fake render Worker so the render path never needs the real WASM core: it
  // acknowledges each request with an 8-byte-header PNG stand-in. This also
  // exercises the worker-offload happy path.
  function installFakeWorker() {
    const postMessage = vi.fn();
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(
        public url: string,
        public options: unknown,
      ) {}
      postMessage(message: { id: number; configJson: string }) {
        postMessage(message);
        queueMicrotask(() => {
          this.onmessage?.({ data: { id: message.id, png: new ArrayBuffer(8) } } as MessageEvent);
        });
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    return { postMessage };
  }

  // A worker that accepts the post but never answers — models a wedged worker so
  // the render request can only resolve via the 8s timeout.
  function installStuckWorker() {
    const postMessage = vi.fn();
    const terminate = vi.fn();
    class StuckWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(
        public url: string,
        public options: unknown,
      ) {}
      postMessage(message: { id: number; configJson: string }) {
        postMessage(message);
        // Intentionally never calls onmessage.
      }
      terminate() {
        terminate();
      }
    }
    vi.stubGlobal('Worker', StuckWorker);
    return { postMessage, terminate };
  }

  const overlayConfig = JSON.stringify({ hold_state_map: {}, holds: [], frames: 'p1r1' });

  it('returns the persisted overlay on a hit without rendering (survives reload)', async () => {
    installCaches();
    const { postMessage } = installFakeWorker();
    // Seed the cache as if a prior session rendered this climb.
    await writeOverlayToCache('v3_s_wfull_kilter_1_2_25_hit', new Blob() as Blob);
    _overlayCacheStoreForTests.renderedObjectUrls.clear();

    const url = await renderHoldsOverlay(overlayConfig, 'v3_s_wfull_kilter_1_2_25_hit');

    expect(url).toMatch(/^blob:overlay\//);
    // Cache hit short-circuits before the worker is ever asked to render.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('falls through to a render on a miss and persists the bytes under cacheKey', async () => {
    const { cache } = installCaches();
    const { postMessage } = installFakeWorker();

    const url = await renderHoldsOverlay(overlayConfig, 'v3_s_wfull_kilter_1_2_25_miss');

    expect(url).toMatch(/^blob:overlay\//);
    // The miss drove a worker render...
    expect(postMessage).toHaveBeenCalledTimes(1);
    // ...and persisted the result so the next reload is a hit. Persistence is
    // fire-and-forget, so wait for the write to settle.
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalled());
    const persistedKey = cache.put.mock.calls[0][0] as string;
    expect(persistedKey).toContain(encodeURIComponent('v3_s_wfull_kilter_1_2_25_miss'));
  });

  it('renders a marker config instead of refusing it', async () => {
    const { cache } = installCaches();
    const { postMessage } = installFakeWorker();

    // shape_size_multiplier used to be refused outright because the committed
    // WASM predated the field (issue #4495). The rebuilt artifact honours it,
    // so this must render and persist like any other config.
    const url = await renderHoldsOverlay(
      JSON.stringify({ shape_size_multiplier: 1.5, hold_state_map: {} }),
      'v7_s_wfull_kilter_1_2_25_marker',
    );

    expect(url).toMatch(/^blob:overlay\//);
    expect(postMessage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalled());
  });

  it('terminates and disables the worker after a render times out, so later misses skip it', async () => {
    installCaches();
    const { postMessage, terminate } = installStuckWorker();
    _webRendererForTests.resetWorker();
    vi.useFakeTimers();
    try {
      // First render posts to the worker; it never answers, so only the timeout
      // can settle it. Falls back to the main thread (which has no WASM in the
      // test) — swallow that rejection; the worker lifecycle is what we assert.
      const firstRender = _webRendererForTests.renderPngBlob(overlayConfig).catch(() => undefined);
      expect(postMessage).toHaveBeenCalledTimes(1);

      // Elapse the 8s budget: the wedged worker is terminated and disabled.
      await vi.advanceTimersByTimeAsync(8000);
      expect(terminate).toHaveBeenCalledTimes(1);

      // A later cache miss must not re-post to the wedged worker — it renders on
      // the main thread straight away instead of eating another timeout.
      const secondRender = _webRendererForTests.renderPngBlob(overlayConfig).catch(() => undefined);
      expect(postMessage).toHaveBeenCalledTimes(1);

      await Promise.allSettled([firstRender, secondRender]);
    } finally {
      vi.useRealTimers();
      _webRendererForTests.resetWorker();
    }
  });
});
