import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { BoardDetails } from '@/app/lib/types';
import type { RenderResponse } from '../board-render.worker';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above the module-under-test import
// ---------------------------------------------------------------------------

// Mock the capacitor-utils module
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isCapacitor: vi.fn(() => false),
}));

// Mock getImageUrl to return a predictable path
vi.mock('@/app/components/board-renderer/util', () => ({
  getImageUrl: vi.fn(
    (imageUrl: string, board: string, thumbnail?: boolean) =>
      `/images/${board}/${thumbnail ? 'thumbs/' : ''}${imageUrl}`,
  ),
}));

// Mock HOLD_STATE_MAP
vi.mock('@/app/components/board-renderer/types', () => ({
  HOLD_STATE_MAP: {
    kilter: {
      42: { name: 'STARTING', color: '#00FF00' },
      43: { name: 'HAND', color: '#00FFFF' },
      44: { name: 'FINISH', color: '#FF00FF' },
      45: { name: 'FOOT', color: '#FFAA00' },
    },
    tension: {
      1: { name: 'STARTING', color: '#00FF00', displayColor: '#00DD00' },
      2: { name: 'HAND', color: '#0000FF', displayColor: '#4444FF' },
    },
    moonboard: {
      42: { name: 'STARTING', color: '#00FF00' },
    },
  },
}));

// ---------------------------------------------------------------------------
// Fake Worker class for jsdom (no real Web Workers)
// ---------------------------------------------------------------------------

type FakeWorkerOnMessage = ((event: MessageEvent<RenderResponse>) => void) | null;

class FakeWorker {
  onmessage: FakeWorkerOnMessage = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

// Track all instantiated workers so tests can trigger their onmessage
const fakeWorkerInstances: FakeWorker[] = [];

// ---------------------------------------------------------------------------
// Global stubs (OffscreenCanvas, Worker, createImageBitmap, fetch, location)
// ---------------------------------------------------------------------------

// Save the original URL constructor so we can restore it
const OriginalURL = globalThis.URL;

function stubGlobals() {
  // OffscreenCanvas stub
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: class OffscreenCanvas {},
    writable: true,
    configurable: true,
  });

  // Worker stub — captures instances for later inspection.
  // The source code does `new Worker(new URL('./board-render.worker.ts', import.meta.url))`.
  // We need the Worker constructor to accept any argument shape.
  const WorkerMock = vi.fn().mockImplementation(function (this: FakeWorker) {
    this.onmessage = null;
    this.onerror = null;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    fakeWorkerInstances.push(this);
  }) as unknown as typeof Worker;

  Object.defineProperty(globalThis, 'Worker', {
    value: WorkerMock,
    writable: true,
    configurable: true,
  });

  // Patch the URL constructor so that `new URL('./board-render.worker.ts', import.meta.url)`
  // works in the test environment (vitest's import.meta.url can be a file:// path, which
  // may get mangled by vitest's internal URL$1 wrapper).
  const PatchedURL = function UrlProxy(input: string | URL, base?: string | URL) {
    try {
      return new OriginalURL(input, base);
    } catch {
      // If the base is invalid (common in vitest transforms), return a
      // dummy URL that still has a valid .href
      return new OriginalURL(`http://localhost:3000/${String(input)}`);
    }
  } as unknown as typeof URL;
  // Copy static properties (e.g. URL.createObjectURL) from the original
  Object.setPrototypeOf(PatchedURL, OriginalURL);
  PatchedURL.prototype = OriginalURL.prototype;
  Object.defineProperty(globalThis, 'URL', {
    value: PatchedURL,
    writable: true,
    configurable: true,
  });

  // createImageBitmap stub — returns a minimal object that looks like ImageBitmap
  (globalThis as Record<string, unknown>).createImageBitmap = vi.fn(
    () =>
      Promise.resolve({
        width: 100,
        height: 100,
        close: vi.fn(),
      }) as unknown as Promise<ImageBitmap>,
  );

  // fetch stub — returns a fake blob for image preloading
  (globalThis as Record<string, unknown>).fetch = vi.fn(() =>
    Promise.resolve({
      blob: () => Promise.resolve(new Blob(['fake-image'], { type: 'image/png' })),
    }),
  );

  // Ensure window.location.origin is set
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost:3000', href: 'http://localhost:3000' },
      writable: true,
      configurable: true,
    });
  }
}

function cleanupGlobals() {
  fakeWorkerInstances.length = 0;
  delete (globalThis as Record<string, unknown>).OffscreenCanvas;
  // Restore Worker to undefined so SSR-like checks fail
  Object.defineProperty(globalThis, 'Worker', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  // Restore original URL
  Object.defineProperty(globalThis, 'URL', {
    value: OriginalURL,
    writable: true,
    configurable: true,
  });
  delete (globalThis as Record<string, unknown>).createImageBitmap;
  delete (globalThis as Record<string, unknown>).fetch;
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const mockBoardDetails = {
  board_name: 'kilter' as const,
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 2],
  boardWidth: 1080,
  boardHeight: 1504,
  holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 15 }],
  images_to_holds: { 'test-image.png': [[1]] },
  edge_left: 0,
  edge_right: 1080,
  edge_bottom: 0,
  edge_top: 1504,
} as unknown as BoardDetails;

// ---------------------------------------------------------------------------
// Helpers to find render messages in fake workers
// ---------------------------------------------------------------------------

function isRenderMessage(msg: unknown): msg is Record<string, unknown> & { id: number; frames: string } {
  const m = msg as Record<string, unknown>;
  return typeof m.id === 'number' && 'frames' in m;
}

function findWorkerWithRenderMsg(frames?: string): FakeWorker | undefined {
  return fakeWorkerInstances.find((w) =>
    w.postMessage.mock.calls.some((call) => {
      const msg = call[0] as Record<string, unknown>;
      if (!isRenderMessage(msg)) return false;
      return frames === undefined || msg.frames === frames;
    }),
  );
}

function findRenderCall(worker: FakeWorker, frames?: string): Record<string, unknown> | undefined {
  const call = worker.postMessage.mock.calls.find((c) => {
    const msg = c[0] as Record<string, unknown>;
    if (!isRenderMessage(msg)) return false;
    return frames === undefined || msg.frames === frames;
  });
  return call ? (call[0] as Record<string, unknown>) : undefined;
}

function resolveWorkerRequest(worker: FakeWorker, requestId: number, bitmap: ImageBitmap): void {
  worker.onmessage!(
    new MessageEvent('message', {
      data: { id: requestId, bitmap },
    }),
  );
}

function rejectWorkerRequest(worker: FakeWorker, requestId: number, errorMessage: string): void {
  worker.onmessage!(
    new MessageEvent('message', {
      data: { id: requestId, error: errorMessage },
    }),
  );
}

function makeFakeBitmap(tag?: string): ImageBitmap {
  return { width: 100, height: 100, close: vi.fn(), _tag: tag } as unknown as ImageBitmap;
}

// ==========================================================================
// 1. isWorkerRenderingSupported
// ==========================================================================

describe('isWorkerRenderingSupported', () => {
  afterEach(() => {
    cleanupGlobals();
    vi.resetModules();
  });

  it('returns false when OffscreenCanvas is missing', async () => {
    // Worker exists but OffscreenCanvas does not
    Object.defineProperty(globalThis, 'Worker', {
      value: class {},
      writable: true,
      configurable: true,
    });

    const { isWorkerRenderingSupported } = await import('../worker-manager');
    expect(isWorkerRenderingSupported()).toBe(false);
  });

  it('returns false when Worker is missing', async () => {
    // OffscreenCanvas exists but Worker does not
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: class OffscreenCanvas {},
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'Worker', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { isWorkerRenderingSupported } = await import('../worker-manager');
    expect(isWorkerRenderingSupported()).toBe(false);
  });

  it('returns true when both OffscreenCanvas and Worker are available', async () => {
    stubGlobals();

    const { isWorkerRenderingSupported } = await import('../worker-manager');
    expect(isWorkerRenderingSupported()).toBe(true);
  });
});

// ==========================================================================
// 2. useCanvasRendererReady
// ==========================================================================

describe('useCanvasRendererReady', () => {
  afterEach(() => {
    cleanupGlobals();
    vi.resetModules();
  });

  it('returns true after mount when browser supports it', async () => {
    stubGlobals();
    const { useCanvasRendererReady } = await import('../worker-manager');
    const { result } = renderHook(() => useCanvasRendererReady());
    expect(result.current).toBe(true);
  });

  it('stays false when browser does not support OffscreenCanvas', async () => {
    // Only set Worker, no OffscreenCanvas
    Object.defineProperty(globalThis, 'Worker', {
      value: class {},
      writable: true,
      configurable: true,
    });

    const { useCanvasRendererReady } = await import('../worker-manager');
    const { result } = renderHook(() => useCanvasRendererReady());
    expect(result.current).toBe(false);
  });

  it('subsequent hook instances start with true immediately after first mount', async () => {
    stubGlobals();
    const { useCanvasRendererReady } = await import('../worker-manager');

    // First instance — triggers the useEffect that sets globalCanvasReady
    const { result: first } = renderHook(() => useCanvasRendererReady());
    expect(first.current).toBe(true);

    // Second instance — should initialise with true immediately (no false→true flash)
    let initialValue: boolean | undefined;
    renderHook(() => {
      const ready = useCanvasRendererReady();
      if (initialValue === undefined) {
        initialValue = ready;
      }
      return ready;
    });
    expect(initialValue).toBe(true);
  });
});

// ==========================================================================
// 3. renderBoard
// ==========================================================================

describe('renderBoard', () => {
  beforeEach(() => {
    stubGlobals();
  });

  afterEach(() => {
    cleanupGlobals();
    vi.resetModules();
  });

  it('rejects during SSR (no window)', async () => {
    // Temporarily remove window to simulate SSR
    const origWindow = globalThis.window;
    // @ts-expect-error -- intentionally removing window for SSR simulation
    delete globalThis.window;

    // Fresh import so the module sees no window at call time
    const { renderBoard } = await import('../worker-manager');
    await expect(
      renderBoard({
        boardDetails: mockBoardDetails,
        frames: 'p1r42p2r43',
        mirrored: false,
      }),
    ).rejects.toThrow('renderBoard is not available during SSR');

    globalThis.window = origWindow;
  });

  it('posts a render message to a worker and resolves with the bitmap', async () => {
    const { renderBoard } = await import('../worker-manager');

    const renderPromise = renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p1r42p2r43',
      mirrored: false,
    });

    // Wait for image preloading to settle and render message to be posted
    await vi.waitFor(() => {
      expect(findWorkerWithRenderMsg('p1r42p2r43')).toBeTruthy();
    });

    const worker = findWorkerWithRenderMsg('p1r42p2r43')!;
    const request = findRenderCall(worker, 'p1r42p2r43')!;
    const requestId = request.id as number;

    const fakeBitmap = makeFakeBitmap('render-test');
    resolveWorkerRequest(worker, requestId, fakeBitmap);

    const result = await renderPromise;
    expect(result).toBe(fakeBitmap);
  });

  it('returns a cached bitmap on repeated calls with the same options', async () => {
    const { renderBoard } = await import('../worker-manager');

    const options = {
      boardDetails: mockBoardDetails,
      frames: 'p1r42',
      mirrored: false,
    };

    // First call — resolve from worker
    const firstPromise = renderBoard(options);

    await vi.waitFor(() => {
      expect(findWorkerWithRenderMsg('p1r42')).toBeTruthy();
    });

    const worker = findWorkerWithRenderMsg('p1r42')!;
    const request = findRenderCall(worker, 'p1r42')!;
    const requestId = request.id as number;

    const fakeBitmap = makeFakeBitmap('cached');
    resolveWorkerRequest(worker, requestId, fakeBitmap);

    const firstResult = await firstPromise;
    expect(firstResult).toBe(fakeBitmap);

    // Second call — should resolve immediately from cache without posting a new message
    const postMessageCallCountBefore = fakeWorkerInstances.reduce((sum, w) => sum + w.postMessage.mock.calls.length, 0);

    const secondResult = await renderBoard(options);
    expect(secondResult).toBe(fakeBitmap);

    // No additional postMessage calls should have occurred (cache hit)
    const postMessageCallCountAfter = fakeWorkerInstances.reduce((sum, w) => sum + w.postMessage.mock.calls.length, 0);
    expect(postMessageCallCountAfter).toBe(postMessageCallCountBefore);
  });

  it('deduplicates identical in-flight requests (same cache key returns same promise)', async () => {
    const { renderBoard } = await import('../worker-manager');

    const options = {
      boardDetails: mockBoardDetails,
      frames: 'p10r42p20r43',
      mirrored: false,
    };

    const promise1 = renderBoard(options);
    const promise2 = renderBoard(options);

    // Both should return the exact same promise object (deduplication)
    expect(promise1).toBe(promise2);

    // Resolve to clean up
    await vi.waitFor(() => {
      expect(findWorkerWithRenderMsg('p10r42p20r43')).toBeTruthy();
    });

    const worker = findWorkerWithRenderMsg('p10r42p20r43')!;
    const request = findRenderCall(worker, 'p10r42p20r43')!;
    const requestId = request.id as number;

    const fakeBitmap = makeFakeBitmap('dedup');
    resolveWorkerRequest(worker, requestId, fakeBitmap);

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toBe(result2);
    expect(result1).toBe(fakeBitmap);
  });

  it('distributes requests round-robin across workers', async () => {
    const { renderBoard } = await import('../worker-manager');

    // Make 3 distinct requests so they won't be deduplicated
    const framesList = ['p1r42', 'p2r43', 'p3r44'];
    const promises = framesList.map((frames) =>
      renderBoard({ boardDetails: mockBoardDetails, frames, mirrored: false }),
    );

    // Wait for all 3 workers to be created
    await vi.waitFor(() => {
      expect(fakeWorkerInstances.length).toBeGreaterThanOrEqual(3);
    });

    // Wait for all 3 render messages to be posted
    await vi.waitFor(() => {
      const workersWithRenderMsg = fakeWorkerInstances.filter((w) =>
        w.postMessage.mock.calls.some((call) => isRenderMessage(call[0])),
      );
      expect(workersWithRenderMsg.length).toBe(3);
    });

    // Each of the 3 workers should have received exactly one render request
    const workersWithRenderMsg = fakeWorkerInstances.filter((w) =>
      w.postMessage.mock.calls.some((call) => isRenderMessage(call[0])),
    );
    expect(workersWithRenderMsg.length).toBe(3);

    // Resolve all requests
    for (const worker of fakeWorkerInstances) {
      for (const call of worker.postMessage.mock.calls) {
        const msg = call[0] as Record<string, unknown>;
        if (isRenderMessage(msg)) {
          resolveWorkerRequest(worker, msg.id as number, makeFakeBitmap());
        }
      }
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r).toHaveProperty('width');
    });
  });

  it('uses different cache keys for mirrored vs non-mirrored', async () => {
    const { renderBoard } = await import('../worker-manager');

    const baseOptions = {
      boardDetails: mockBoardDetails,
      frames: 'p1r42',
    };

    const promise1 = renderBoard({ ...baseOptions, mirrored: false });
    const promise2 = renderBoard({ ...baseOptions, mirrored: true });

    // These should NOT be the same promise (different cache keys)
    expect(promise1).not.toBe(promise2);

    // Resolve both to clean up
    await vi.waitFor(() => {
      const renderMsgCount = fakeWorkerInstances.reduce(
        (count, w) => count + w.postMessage.mock.calls.filter((call) => isRenderMessage(call[0])).length,
        0,
      );
      expect(renderMsgCount).toBeGreaterThanOrEqual(2);
    });

    for (const worker of fakeWorkerInstances) {
      for (const call of worker.postMessage.mock.calls) {
        const msg = call[0] as Record<string, unknown>;
        if (isRenderMessage(msg)) {
          resolveWorkerRequest(worker, msg.id as number, makeFakeBitmap());
        }
      }
    }

    await Promise.all([promise1, promise2]);
  });

  it('uses different cache keys for thumbnail vs full-size', async () => {
    const { renderBoard } = await import('../worker-manager');

    const baseOptions = {
      boardDetails: mockBoardDetails,
      frames: 'p1r42',
      mirrored: false,
    };

    const promiseFull = renderBoard({ ...baseOptions, thumbnail: false });
    const promiseThumb = renderBoard({ ...baseOptions, thumbnail: true });

    // Different cache keys => different promises
    expect(promiseFull).not.toBe(promiseThumb);

    // Resolve both to clean up
    await vi.waitFor(() => {
      const renderMsgCount = fakeWorkerInstances.reduce(
        (count, w) => count + w.postMessage.mock.calls.filter((call) => isRenderMessage(call[0])).length,
        0,
      );
      expect(renderMsgCount).toBeGreaterThanOrEqual(2);
    });

    for (const worker of fakeWorkerInstances) {
      for (const call of worker.postMessage.mock.calls) {
        const msg = call[0] as Record<string, unknown>;
        if (isRenderMessage(msg)) {
          resolveWorkerRequest(worker, msg.id as number, makeFakeBitmap());
        }
      }
    }

    await Promise.all([promiseFull, promiseThumb]);
  });

  it('rejects when a worker responds with an error', async () => {
    const { renderBoard } = await import('../worker-manager');

    const renderPromise = renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p99r42',
      mirrored: false,
    });

    await vi.waitFor(() => {
      expect(findWorkerWithRenderMsg('p99r42')).toBeTruthy();
    });

    const worker = findWorkerWithRenderMsg('p99r42')!;
    const request = findRenderCall(worker, 'p99r42')!;
    const requestId = request.id as number;

    rejectWorkerRequest(worker, requestId, 'WASM init failed');

    await expect(renderPromise).rejects.toThrow('WASM init failed');
  });

  it('sends the correct render request shape to the worker', async () => {
    const { renderBoard } = await import('../worker-manager');

    renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p1r42p2r43',
      mirrored: true,
      thumbnail: true,
    });

    await vi.waitFor(() => {
      expect(findWorkerWithRenderMsg('p1r42p2r43')).toBeTruthy();
    });

    const worker = findWorkerWithRenderMsg('p1r42p2r43')!;
    const request = findRenderCall(worker, 'p1r42p2r43')!;

    expect(request).toMatchObject({
      boardWidth: 1080,
      boardHeight: 1504,
      outputWidth: 300, // THUMBNAIL_WIDTH when thumbnail=true
      frames: 'p1r42p2r43',
      mirrored: true,
      thumbnail: true,
      origin: 'http://localhost:3000',
    });

    // Verify holds are mapped correctly
    const holds = request.holds as Array<Record<string, unknown>>;
    expect(holds).toEqual([{ id: 1, mirrored_hold_id: null, cx: 100, cy: 200, r: 15 }]);

    // Verify holdStateMap contains kilter states
    const holdStateMap = request.holdStateMap as Record<number, { color: string }>;
    expect(holdStateMap[42]).toEqual({ color: '#00FF00' });
    expect(holdStateMap[43]).toEqual({ color: '#00FFFF' });

    // Verify backgroundUrls are absolute
    const bgUrls = request.backgroundUrls as string[];
    expect(bgUrls.length).toBeGreaterThan(0);
    bgUrls.forEach((url) => {
      expect(url).toMatch(/^http:\/\/localhost:3000\//);
    });
  });

  it('sets outputWidth to boardWidth when thumbnail is false', async () => {
    const { renderBoard } = await import('../worker-manager');

    renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p5r42',
      mirrored: false,
      thumbnail: false,
    });

    await vi.waitFor(() => {
      expect(findWorkerWithRenderMsg('p5r42')).toBeTruthy();
    });

    const worker = findWorkerWithRenderMsg('p5r42')!;
    const request = findRenderCall(worker, 'p5r42')!;

    expect(request.outputWidth).toBe(1080); // boardWidth, not thumbnail width
  });
});

// ==========================================================================
// 4. Worker pool size
// ==========================================================================

describe('worker pool size', () => {
  afterEach(() => {
    cleanupGlobals();
    vi.resetModules();
  });

  it('creates 3 workers in a normal browser environment', async () => {
    stubGlobals();
    const { renderBoard } = await import('../worker-manager');

    renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p1r42',
      mirrored: false,
    });

    await vi.waitFor(() => {
      // The pool is lazy-initialized on first renderBoard call
      expect(fakeWorkerInstances.length).toBe(3);
    });
  });

  it('creates 5 workers in a Capacitor environment', async () => {
    stubGlobals();

    // Override isCapacitor to return true before importing worker-manager
    const { isCapacitor } = await import('@/app/lib/ble/capacitor-utils');
    vi.mocked(isCapacitor).mockReturnValue(true);

    const { renderBoard } = await import('../worker-manager');

    renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p1r42',
      mirrored: false,
    });

    await vi.waitFor(() => {
      expect(fakeWorkerInstances.length).toBe(5);
    });
  });
});

// ==========================================================================
// 5. LRU cache behavior
// ==========================================================================

describe('LRU cache behavior', () => {
  afterEach(() => {
    cleanupGlobals();
    vi.resetModules();
  });

  it('moves accessed entries to the end of the cache (LRU reorder)', async () => {
    stubGlobals();
    const { renderBoard } = await import('../worker-manager');

    // Helper: fire a render and resolve it immediately
    async function doRender(frames: string): Promise<ImageBitmap> {
      const promise = renderBoard({
        boardDetails: mockBoardDetails,
        frames,
        mirrored: false,
      });

      await vi.waitFor(() => {
        expect(findWorkerWithRenderMsg(frames)).toBeTruthy();
      });

      const worker = findWorkerWithRenderMsg(frames)!;
      const request = findRenderCall(worker, frames)!;
      const requestId = request.id as number;
      const fakeBitmap = makeFakeBitmap(frames);

      resolveWorkerRequest(worker, requestId, fakeBitmap);

      return promise;
    }

    // Render two different frames to populate cache
    const bitmap1 = await doRender('p1r42');
    const bitmap2 = await doRender('p2r43');

    // Access bitmap1 again — should come from cache
    const cachedBitmap1 = await renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p1r42',
      mirrored: false,
    });

    // Should be the same object (cache hit)
    expect(cachedBitmap1).toBe(bitmap1);

    // bitmap2 should also still be cached
    const cachedBitmap2 = await renderBoard({
      boardDetails: mockBoardDetails,
      frames: 'p2r43',
      mirrored: false,
    });
    expect(cachedBitmap2).toBe(bitmap2);
  });
});
