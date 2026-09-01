import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shim calls requireOptionalNativeModule from expo-modules-core to look
// up the native binary. We control what it returns per test by reassigning
// the variable the mock factory closes over before each import.
type NativeMock = {
  renderHoldsOverlayWithMarkers?: unknown;
  renderHoldsOverlay?: unknown;
  renderComposite?: (configJson: string, backgroundPaths: string[], cacheKey: string) => Promise<string>;
} | null;

let nativeMock: NativeMock = null;

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => nativeMock,
}));

// The Boardsesh capability probe reads the two PNGs the native side wrote back
// off disk to compare them, so the suite needs a filesystem with real contents —
// more than the repo-wide expo-file-system stub (size + mtime only) offers. This
// in-memory one stores bytes per `file://` URI and is seeded per test via
// `probeFiles`, which maps a render's returned URI to the "PNG" behind it.
const probeFiles = new Map<string, string>();
const deletedProbeFiles: string[] = [];

vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists(): boolean {
      return probeFiles.has(this.uri);
    }
    get size(): number | null {
      return probeFiles.get(this.uri)?.length ?? null;
    }
    base64(): Promise<string> {
      const contents = probeFiles.get(this.uri);
      if (contents === undefined) return Promise.reject(new Error(`no such file: ${this.uri}`));
      return Promise.resolve(contents);
    }
    delete(): void {
      deletedProbeFiles.push(this.uri);
      probeFiles.delete(this.uri);
    }
  },
}));

// Resetting modules between tests guarantees the shim re-evaluates its
// top-level `requireOptionalNativeModule(...)` call against the freshly
// assigned `nativeMock`. Without this, the first import would freeze a
// single nativeMock reference for every subsequent test.
async function loadShim() {
  vi.resetModules();
  return await import('../../../modules/board-renderer/src/index');
}

/**
 * A native mock whose `renderHoldsOverlay` writes a distinct file per cache key
 * and returns its URI, with the contents chosen by the config's `render_mode`.
 * That is exactly the axis the probe measures: `boardseshPixels === classicPixels`
 * is a library that ignored `render_mode`.
 */
function nativeRendererWriting(classicPixels: string, boardseshPixels: string) {
  return vi.fn((configJson: string, cacheKey: string) => {
    const requestsAura = (JSON.parse(configJson) as { render_mode?: string }).render_mode === 'aura';
    const uri = `file:///cache/board-thumbnails/${cacheKey}.png`;
    probeFiles.set(uri, requestsAura ? boardseshPixels : classicPixels);
    return Promise.resolve(uri);
  });
}

const BOARDSESH_CONFIG_JSON = JSON.stringify({
  render_mode: 'aura',
  veil: { color: '#0B0B10', opacity: 0.6 },
  hold_state_map: { 2: { color: '#6980FF' } },
});

beforeEach(() => {
  nativeMock = null;
  probeFiles.clear();
  deletedProbeFiles.length = 0;
});

describe('renderHoldsOverlay shim', () => {
  it('uses the new path when renderHoldsOverlay is a real working function', async () => {
    const renderHolds = vi.fn().mockResolvedValue('file:///out/new.png');
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderHoldsOverlay: renderHolds, renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    const result = await renderHoldsOverlay('{"json":true}', 'cache-key-1');

    expect(result).toBe('file:///out/new.png');
    expect(renderHolds).toHaveBeenCalledWith('{"json":true}', 'cache-key-1');
    expect(renderComposite).not.toHaveBeenCalled();
  });

  it('uses the marker-aware path for marker override configs', async () => {
    const renderMarkers = vi.fn().mockResolvedValue('file:///out/markers.png');
    const renderHolds = vi.fn().mockResolvedValue('file:///out/new.png');
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderHoldsOverlayWithMarkers: renderMarkers, renderHoldsOverlay: renderHolds, renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    const configJson = JSON.stringify({
      stroke_width_multiplier: 1,
      shape_size_multiplier: 1.5,
      hold_state_map: {
        12: { color: '#ff0000' },
      },
    });
    const result = await renderHoldsOverlay(configJson, 'cache-key-marker');

    expect(result).toBe('file:///out/markers.png');
    expect(renderMarkers).toHaveBeenCalledWith(configJson, 'cache-key-marker');
    expect(renderHolds).not.toHaveBeenCalled();
    expect(renderComposite).not.toHaveBeenCalled();
  });

  it('issue #2202: a non-default stroke_width_multiplier alone does not require the marker-aware renderer', async () => {
    // Grasshopper's board-level stroke boost (1.35x) makes stroke_width_multiplier
    // non-1 even for a user with zero accessibility overrides. Unlike
    // shape_size_multiplier/shape, this must NOT force renderHoldsOverlayWithMarkers
    // — otherwise every Grasshopper render throws MARKER_RENDERER_UNAVAILABLE_MESSAGE
    // on any native binary older than the marker-accessibility release, leaving the
    // overlay permanently blank instead of falling back to the classic renderer.
    const renderMarkers = vi.fn().mockResolvedValue('file:///out/markers.png');
    const renderHolds = vi.fn().mockResolvedValue('file:///out/classic.png');
    nativeMock = { renderHoldsOverlayWithMarkers: renderMarkers, renderHoldsOverlay: renderHolds };

    const { renderHoldsOverlay } = await loadShim();
    const configJson = JSON.stringify({
      stroke_width_multiplier: 1.35,
      shape_size_multiplier: 1,
      hold_state_map: {
        2: { color: '#4455FF' },
      },
    });
    const result = await renderHoldsOverlay(configJson, 'cache-key-grasshopper-stroke');

    expect(result).toBe('file:///out/classic.png');
    expect(renderHolds).toHaveBeenCalledWith(configJson, 'cache-key-grasshopper-stroke');
    expect(renderMarkers).not.toHaveBeenCalled();
  });

  it('issue #2202: a non-default stroke_width_multiplier still falls back to renderComposite on old binaries', async () => {
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    const configJson = JSON.stringify({
      stroke_width_multiplier: 1.35,
      shape_size_multiplier: 1,
      hold_state_map: {
        2: { color: '#4455FF' },
      },
    });
    const result = await renderHoldsOverlay(configJson, 'cache-key-grasshopper-old-binary');

    expect(result).toBe('file:///out/old.png');
    expect(renderComposite).toHaveBeenCalledWith(configJson, [], 'cache-key-grasshopper-old-binary');
  });

  it('falls through to renderComposite when renderHoldsOverlay rejects with "is not a function"', async () => {
    // Simulates the NativeModulesProxy-lies-about-method-presence case:
    // typeof says it is a function, but invocation rejects.
    const renderHolds = vi.fn().mockRejectedValue(new TypeError('renderHoldsOverlay is not a function on this binary'));
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderHoldsOverlay: renderHolds, renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    const result = await renderHoldsOverlay('{"json":true}', 'cache-key-2');

    expect(result).toBe('file:///out/old.png');
    expect(renderHolds).toHaveBeenCalledTimes(1);
    // The whole point of the fix: empty backgroundPaths + same configJson + same cacheKey.
    expect(renderComposite).toHaveBeenCalledWith('{"json":true}', [], 'cache-key-2');
  });

  it('falls through when renderHoldsOverlay throws synchronously with a missing-method error', async () => {
    const renderHolds = vi.fn(() => {
      throw new Error('Unknown method: renderHoldsOverlay');
    });
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderHoldsOverlay: renderHolds, renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    const result = await renderHoldsOverlay('{"json":true}', 'cache-key-3');

    expect(result).toBe('file:///out/old.png');
    expect(renderComposite).toHaveBeenCalledWith('{"json":true}', [], 'cache-key-3');
  });

  it('propagates real render errors instead of swallowing them', async () => {
    // OOM/disk-full/bad-JSON errors must NOT be misread as "method missing"
    // — the hook's catch block needs to log them.
    const renderHolds = vi.fn().mockRejectedValue(new Error('Out of memory while rasterizing overlay'));
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderHoldsOverlay: renderHolds, renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    await expect(renderHoldsOverlay('{"json":true}', 'cache-key-4')).rejects.toThrow(
      'Out of memory while rasterizing overlay',
    );
    expect(renderComposite).not.toHaveBeenCalled();
  });

  it('uses renderComposite directly when renderHoldsOverlay is not a function on the binary', async () => {
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    const result = await renderHoldsOverlay('{"json":true}', 'cache-key-5');

    expect(result).toBe('file:///out/old.png');
    expect(renderComposite).toHaveBeenCalledWith('{"json":true}', [], 'cache-key-5');
  });

  it('does not fall back to renderComposite for marker override configs old binaries cannot honor', async () => {
    const renderComposite = vi.fn().mockResolvedValue('file:///out/old.png');
    nativeMock = { renderComposite };

    const { renderHoldsOverlay } = await loadShim();
    await expect(
      renderHoldsOverlay(
        JSON.stringify({
          stroke_width_multiplier: 1.5,
          shape_size_multiplier: 1.8,
          hold_state_map: {
            12: { color: '#ff0000', shape: 'triangle-up' },
          },
        }),
        'cache-key-custom-marker',
      ),
    ).rejects.toThrow(/rebuilt BoardRenderer native binary/);
    expect(renderComposite).not.toHaveBeenCalled();
  });

  it('does not use overlay-only binaries for marker override configs', async () => {
    const renderHolds = vi.fn().mockResolvedValue('file:///out/default-markers.png');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { renderHoldsOverlay } = await loadShim();
    await expect(
      renderHoldsOverlay(
        JSON.stringify({
          stroke_width_multiplier: 1,
          shape_size_multiplier: 1,
          hold_state_map: {
            12: { color: '#ff0000', shape: 'diamond' },
          },
        }),
        'cache-key-custom-marker',
      ),
    ).rejects.toThrow(/rebuilt BoardRenderer native binary/);
    expect(renderHolds).not.toHaveBeenCalled();
  });

  it('throws when the native module is not linked at all', async () => {
    nativeMock = null;
    const { renderHoldsOverlay } = await loadShim();
    await expect(renderHoldsOverlay('{"json":true}', 'cache-key-6')).rejects.toThrow(
      /BoardRenderer native module is not available/,
    );
  });

  it('throws when neither function is exposed', async () => {
    nativeMock = {};
    const { renderHoldsOverlay } = await loadShim();
    await expect(renderHoldsOverlay('{"json":true}', 'cache-key-7')).rejects.toThrow(/no usable render function/);
  });
});

/**
 * Issue #2202. `render_mode` cannot be gated on a method name the way marker
 * overrides were: RenderConfig has no `deny_unknown_fields` and every Boardsesh
 * field is `#[serde(default)]`, so a library built before the mode existed takes
 * the same config, drops every key, and draws classic without erroring. The
 * probe asks the behavioural question instead — render the same tiny config in
 * both modes and see whether the library painted the veil.
 */
describe('probeBoardseshRendererSupport', () => {
  it('is true when the two render modes produce different output', async () => {
    nativeMock = { renderHoldsOverlay: nativeRendererWriting('transparent-8x8', 'opaque-white-8x8') };

    const { probeBoardseshRendererSupport } = await loadShim();
    await expect(probeBoardseshRendererSupport()).resolves.toBe(true);
  });

  it('is false when a stale library draws the same thing for both modes', async () => {
    // The silent-fallback case: serde ignored `render_mode` and `veil`, so both
    // renders are the classic empty overlay.
    nativeMock = { renderHoldsOverlay: nativeRendererWriting('transparent-8x8', 'transparent-8x8') };

    const { probeBoardseshRendererSupport } = await loadShim();
    await expect(probeBoardseshRendererSupport()).resolves.toBe(false);
  });

  it('is false when the native module is not linked at all', async () => {
    nativeMock = null;
    const { probeBoardseshRendererSupport } = await loadShim();
    await expect(probeBoardseshRendererSupport()).resolves.toBe(false);
  });

  it('is false when the probe render fails outright', async () => {
    nativeMock = { renderHoldsOverlay: vi.fn().mockRejectedValue(new Error('No space left on device')) };
    const { probeBoardseshRendererSupport } = await loadShim();
    await expect(probeBoardseshRendererSupport()).resolves.toBe(false);
  });

  it('renders exactly twice however many times it is called, and re-runs after a reset', async () => {
    const renderHolds = nativeRendererWriting('transparent-8x8', 'opaque-white-8x8');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { probeBoardseshRendererSupport, _resetBoardseshProbeForTests } = await loadShim();
    // Concurrent + sequential callers all share the one in-flight promise.
    const [first, second] = await Promise.all([probeBoardseshRendererSupport(), probeBoardseshRendererSupport()]);
    const third = await probeBoardseshRendererSupport();

    expect([first, second, third]).toEqual([true, true, true]);
    expect(renderHolds).toHaveBeenCalledTimes(2);

    _resetBoardseshProbeForTests();
    await expect(probeBoardseshRendererSupport()).resolves.toBe(true);
    expect(renderHolds).toHaveBeenCalledTimes(4);
  });

  it('uses two distinct cache keys and deletes both probe PNGs afterwards', async () => {
    // A shared cache key would make the native module's on-disk cache answer the
    // second render with the FIRST render's PNG — identical output, and a probe
    // that can never say true.
    const renderHolds = nativeRendererWriting('transparent-8x8', 'opaque-white-8x8');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { probeBoardseshRendererSupport } = await loadShim();
    await probeBoardseshRendererSupport();

    const usedCacheKeys = renderHolds.mock.calls.map(([, cacheKey]) => cacheKey);
    expect(new Set(usedCacheKeys).size).toBe(2);
    // Not the `v<RENDERER_VERSION>_` prefix the hook's warm-up scan adopts.
    for (const cacheKey of usedCacheKeys) expect(cacheKey).toMatch(/^boardsesh-probe-/);
    expect(deletedProbeFiles).toHaveLength(2);
    expect(probeFiles.size).toBe(0);
  });

  it('cleans up the first probe PNG even when the second render throws', async () => {
    let renderCount = 0;
    const renderHolds = vi.fn((configJson: string, cacheKey: string) => {
      renderCount += 1;
      if (renderCount === 2) return Promise.reject(new Error('Out of memory while rasterizing overlay'));
      const uri = `file:///cache/board-thumbnails/${cacheKey}.png`;
      probeFiles.set(uri, 'transparent-8x8');
      return Promise.resolve(uri);
    });
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { probeBoardseshRendererSupport } = await loadShim();
    await expect(probeBoardseshRendererSupport()).resolves.toBe(false);
    expect(deletedProbeFiles).toHaveLength(1);
    expect(probeFiles.size).toBe(0);
  });
});

describe('renderHoldsOverlay Boardsesh gate', () => {
  it('refuses a Boardsesh config on a library that ignores render_mode', async () => {
    const renderHolds = nativeRendererWriting('transparent-8x8', 'transparent-8x8');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { renderHoldsOverlay, BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE } = await loadShim();
    await expect(renderHoldsOverlay(BOARDSESH_CONFIG_JSON, 'cache-key-boardsesh')).rejects.toThrow(
      BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE,
    );
    // Only the two probe renders ran; the real config never reached the binary.
    expect(renderHolds).toHaveBeenCalledTimes(2);
    expect(renderHolds.mock.calls.every(([, cacheKey]) => cacheKey.startsWith('boardsesh-probe-'))).toBe(true);
  });

  it('passes a Boardsesh config straight through on a capable library', async () => {
    const renderHolds = nativeRendererWriting('transparent-8x8', 'opaque-white-8x8');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { renderHoldsOverlay } = await loadShim();
    const result = await renderHoldsOverlay(BOARDSESH_CONFIG_JSON, 'cache-key-boardsesh');

    expect(result).toBe('file:///cache/board-thumbnails/cache-key-boardsesh.png');
    expect(renderHolds).toHaveBeenLastCalledWith(BOARDSESH_CONFIG_JSON, 'cache-key-boardsesh');
  });

  it('leaves classic configs untouched: no probe, no extra native calls', async () => {
    const renderHolds = nativeRendererWriting('transparent-8x8', 'opaque-white-8x8');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { renderHoldsOverlay } = await loadShim();
    const classicConfigJson = JSON.stringify({ render_mode: 'classic', hold_state_map: { 2: { color: '#4444FF' } } });
    const result = await renderHoldsOverlay(classicConfigJson, 'cache-key-classic');

    expect(result).toBe('file:///cache/board-thumbnails/cache-key-classic.png');
    expect(renderHolds).toHaveBeenCalledTimes(1);
    expect(renderHolds).toHaveBeenCalledWith(classicConfigJson, 'cache-key-classic');
  });

  it('leaves a config with no render_mode at all untouched', async () => {
    const renderHolds = nativeRendererWriting('transparent-8x8', 'opaque-white-8x8');
    nativeMock = { renderHoldsOverlay: renderHolds };

    const { renderHoldsOverlay } = await loadShim();
    await renderHoldsOverlay('{"hold_state_map":{}}', 'cache-key-no-mode');

    expect(renderHolds).toHaveBeenCalledTimes(1);
    expect(renderHolds).toHaveBeenCalledWith('{"hold_state_map":{}}', 'cache-key-no-mode');
  });
});
