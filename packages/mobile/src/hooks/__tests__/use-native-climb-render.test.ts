import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';

// The hook asks the theme provider for the app's colour scheme (issue #3885) —
// deliberately not react-native's useColorScheme(), which follows the OS. Stub
// the provider so these tests don't need a rendered ThemeProvider; the pure
// helpers exercised here take the scheme as an argument anyway.
vi.mock('../../providers/theme-provider', () => ({
  useAppColorScheme: () => 'light',
}));

// expo-file-system: stub Directory/Paths so the eager warm-up's
// `new Directory(Paths.cache, 'board-thumbnails').list()` runs without
// hitting a real filesystem. The default mock returns an empty list.
// Entries expose a `delete` spy so the warm-up's opportunistic cleanup
// of stale-version PNGs can be observed.
type MockEntry = { uri: string; name: string; delete: ReturnType<typeof vi.fn> };
type MockBoardRenderData = {
  boardWidth: number;
  boardHeight: number;
  holdsData: { id: number; mirroredHoldId: number | null; cx: number; cy: number; r: number }[];
};
const getBoardRenderDataMock = vi.hoisted(() => vi.fn<() => MockBoardRenderData | null>(() => null));
const directoryListSpy = vi.fn<() => MockEntry[]>(() => []);
class MockDirectory {
  uri: string;
  exists = true;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  }
  list = () => directoryListSpy();
}
function makeMockEntry(name: string): MockEntry {
  return { uri: `file:///mock/cache/board-thumbnails/${name}`, name, delete: vi.fn() };
}
vi.mock('expo-file-system', () => ({
  Directory: MockDirectory,
  Paths: { cache: { uri: '/mock/cache' } },
}));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: getBoardRenderDataMock,
}));

vi.mock('../../lib/background-image-cache', () => ({
  // Match the new BackgroundLookupResult shape: `null` means
  // getBoardRenderData itself failed; an object with `paths` +
  // `missingCount` is returned otherwise. The default mock simulates the
  // "render data missing" path used by the existing buildCacheKey /
  // inflight-render tests.
  ensureBackgroundsCached: vi.fn().mockResolvedValue(null),
  tryGetBackgroundPathsSync: vi.fn().mockReturnValue(null),
}));

// Simulate the Expo Go / dev-build-without-Rust-libs case: requireNativeModule
// throws. The hook's try/catch around require() should swallow this so
// overlayUri stays null and backgroundPaths is whatever the sync seed got.
vi.mock('../../../modules/board-renderer/src/index', () => {
  throw new Error('Native module not available (simulated Expo Go)');
});

import { overlayNameMatchesScope } from '../../lib/cache-sweep-plan';

const {
  buildCacheKey,
  buildBoardKey,
  getOrStartInflightRender,
  _inflightRendersForTests,
  _renderedOverlaysForTests,
  _cacheRenderedOverlayForTests,
  _getRenderedOverlayForTests,
  _invalidateRenderedOverlayForTests,
  _resetWarmupForTests,
  _runWarmupForTests,
  _getBoardConfigForTests,
  _withLitHoldGeometryForTests,
} = await import('../use-native-climb-render');

function asRecord(value: unknown): Record<string, unknown> {
  expect(value && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

function getStateInfoByName(
  holdStateMap: Record<string, unknown>,
  stateName: string,
  board: BoardName = 'kilter',
): Record<string, unknown> | undefined {
  const stateCode = Object.entries(HOLD_STATE_MAP[board]).find(([, stateInfo]) => stateInfo.name === stateName)?.[0];
  if (!stateCode) return undefined;
  return asRecord(holdStateMap[stateCode]);
}

describe('buildCacheKey', () => {
  it('hashes the frames component so the key fits in a filename', () => {
    const key = buildCacheKey('kilter', 1, 10, '24,25', 'p1r42p2r43');
    // v<version>_<style>_w<width>_<board>_<layout>_<size>_<sets>_<8-hex-hash>
    // style defaults to 's' (stroke-only / non-filled); width defaults to
    // 'full' (native board width, used by the play view).
    expect(key).toMatch(/^v\d+_s_wfull_kilter_1_10_24,25_[0-9a-f]{8}$/);
  });

  // The board-removal sweep (issue #3647) matches PNG names against an
  // OfflineBoardScope's `boardType`, while the name itself carries `boardName`
  // from here. They are the same string today; if that ever drifts, the sweep
  // silently deletes nothing rather than failing loudly — so pin the identity
  // against the real key builder rather than a hand-written filename.
  it('produces a name the offline-scope sweep can match', () => {
    const scope = { boardType: 'kilter', layoutId: 1, sizeId: 10 };
    const name = `${buildCacheKey(scope.boardType, scope.layoutId, scope.sizeId, '24,25', 'p1r42', true, 400)}.png`;
    expect(overlayNameMatchesScope(name, scope)).toBe(true);
    expect(overlayNameMatchesScope(name, { ...scope, sizeId: 100 })).toBe(false);
  });

  it('defaults to the full-width token and switches to a numeric token when renderWidth is set', () => {
    // Small surfaces pass a renderWidth so the overlay is rasterized small;
    // the token keeps that PNG separate from the play view's native-width
    // one, so neither is reused at the wrong resolution.
    expect(buildCacheKey('kilter', 1, 10, '24', 'p1r42')).toMatch(/_wfull_/);
    expect(buildCacheKey('kilter', 1, 10, '24', 'p1r42', false, 400)).toMatch(/_w400_/);
  });

  it('produces distinct keys for the small and full overlay widths', () => {
    const full = buildCacheKey('kilter', 1, 10, '24', 'p1r42', true);
    const small = buildCacheKey('kilter', 1, 10, '24', 'p1r42', true, 400);
    expect(small).not.toBe(full);
  });

  it('uses RENDERER_VERSION v12 to invalidate overlays with the hard Aura seam baked in', () => {
    // v5 kept a newly built native client from trusting a v4 file that the old
    // direct-to-destination write may have truncated. v6 (issue #4495) dropped
    // every overlay the stale web WASM drew at the wrong stroke width. v7
    // (issue #2202) drops the PNGs the Boardsesh rollout wrote from dev
    // binaries whose drawing was still moving. v11 drops overlays drawn before
    // an annotated hold lit its base plate instead of its whole silhouette —
    // the key describes the settings a render was asked for, not the pixels
    // that came back, and the plate is not a setting.
    expect(buildCacheKey('kilter', 1, 10, '24', 'p1r42')).toMatch(/^v12_/);
  });

  it('uses a distinct style token so filled (list) and stroke (play view) never collide', () => {
    // The list thumbnail renders the filled hold style; the full-size play
    // view renders stroke-only. They share board/layout/size/sets/frames, so
    // without the style token they would map to one PNG and whichever
    // rendered first would win. The token keeps them as separate cache slots.
    const stroke = buildCacheKey('kilter', 1, 10, '24,25', 'p1r42', false);
    const filled = buildCacheKey('kilter', 1, 10, '24,25', 'p1r42', true);
    expect(filled).not.toBe(stroke);
    expect(stroke).toMatch(/^v\d+_s_/);
    expect(filled).toMatch(/^v\d+_f_/);
  });

  it('produces different keys for different frames', () => {
    expect(buildCacheKey('kilter', 1, 10, '24', 'p1r42')).not.toBe(buildCacheKey('kilter', 1, 10, '24', 'p2r43'));
  });

  it('uses custom colour override signatures in the frame hash', () => {
    const defaultKey = buildCacheKey('kilter', 1, 10, '24', 'p1r42');
    const customKey = buildCacheKey('kilter', 1, 10, '24', 'p1r42', false, undefined, 'hand-123456');
    expect(customKey).not.toBe(defaultKey);
    expect(customKey).toMatch(/^v\d+_s_wfull_kilter_1_10_24_[0-9a-f]{8}$/);
  });

  it('uses shape and brush render signatures in the frame hash', () => {
    const defaultKey = buildCacheKey('kilter', 1, 10, '24', 'p1r42');
    const customKey = buildCacheKey(
      'kilter',
      1,
      10,
      '24',
      'p1r42',
      false,
      undefined,
      'colors-hand-123456.foot-diamond.brush-1.5.size-1.8',
    );
    expect(customKey).not.toBe(defaultKey);
    expect(customKey).toMatch(/^v\d+_s_wfull_kilter_1_10_24_[0-9a-f]{8}$/);
  });

  it('ignores custom render signatures for empty frames', () => {
    const defaultKey = buildCacheKey('kilter', 1, 10, '24', '');
    const customKey = buildCacheKey(
      'kilter',
      1,
      10,
      '24',
      '',
      false,
      undefined,
      'colors-hand-123456.foot-diamond.brush-1.5.size-1.8',
    );
    expect(customKey).toBe(defaultKey);
  });

  it('produces different keys for different boards', () => {
    expect(buildCacheKey('kilter', 1, 10, '24', 'p1r42')).not.toBe(buildCacheKey('tension', 1, 10, '24', 'p1r42'));
  });

  it('is deterministic', () => {
    const keyA = buildCacheKey('kilter', 1, 10, '24,25', 'p1r42p2r43');
    const keyB = buildCacheKey('kilter', 1, 10, '24,25', 'p1r42p2r43');
    expect(keyA).toBe(keyB);
  });

  it('does not collide on similar parameter values', () => {
    expect(buildCacheKey('kilter', 1, 10, '24', 'p1r42')).not.toBe(buildCacheKey('kilter', 11, 0, '24', 'p1r42'));
  });

  it('produces a bounded-length key for very long frame strings', () => {
    // iOS/Android cap filenames at 255 bytes; a busy climb's frames string can
    // grow well past that without hashing.
    const longFrames = 'p1234r42'.repeat(500);
    const key = buildCacheKey('kilter', 1, 10, '24', longFrames);
    expect(key.length).toBeLessThan(64);
  });

  it('canonicalizes setIds so equivalent set orderings share a cache key', () => {
    // '25,24' and '24,25' describe the same set selection — they must hash
    // to the same key so we don't double-render and double-cache the same
    // climb. The canonical form is ascending numeric.
    expect(buildCacheKey('kilter', 1, 10, '24,25', 'p1r42')).toBe(buildCacheKey('kilter', 1, 10, '25,24', 'p1r42'));
  });

  it('drops zero/empty setId entries during canonicalization', () => {
    // Mirrors getBoardConfig's split(',').map(Number).filter(Boolean) so the
    // cache key matches the config the renderer actually uses.
    expect(buildCacheKey('kilter', 1, 10, '0,24,25', 'p1r42')).toBe(buildCacheKey('kilter', 1, 10, '24,25', 'p1r42'));
  });
});

describe('_getBoardConfigForTests', () => {
  beforeEach(() => {
    getBoardRenderDataMock.mockReturnValue({
      boardWidth: 1000,
      boardHeight: 1200,
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
    });
  });

  it('includes marker shapes, brush thickness, and shape size in the native config payload', () => {
    const boardConfig = _getBoardConfigForTests(
      'kilter',
      1,
      10,
      '24',
      false,
      undefined,
      { HAND: '#123456' },
      { FOOT: 'diamond' },
      1.5,
      1.8,
      'colors-hand-123456.foot-diamond.brush-1.5.size-1.8',
    );

    expect(boardConfig).not.toBeNull();
    const configBase = asRecord(boardConfig?.configBase);
    expect(configBase.mirrored).toBe(false);
    expect(configBase.stroke_width_multiplier).toBe(1.5);
    expect(configBase.shape_size_multiplier).toBe(1.8);

    const holdStateMap = asRecord(configBase.hold_state_map);
    expect(getStateInfoByName(holdStateMap, 'HAND')?.color).toBe('#123456');
    expect(getStateInfoByName(holdStateMap, 'FOOT')?.shape).toBe('diamond');
  });

  it('issue #2202: prefers the calibrated displayColor over the raw LED color, and boosts Grasshopper stroke width', () => {
    const boardConfig = _getBoardConfigForTests('grasshopper', 1, 10, '24', false);

    expect(boardConfig).not.toBeNull();
    const configBase = asRecord(boardConfig?.configBase);
    const holdStateMap = asRecord(configBase.hold_state_map);

    // Not the raw LED color '#0000FF' — that's far too dark against
    // Grasshopper's busy board photo.
    expect(getStateInfoByName(holdStateMap, 'HAND', 'grasshopper')?.color).toBe('#4455FF');
    // Default brushThickness (1) × Grasshopper's board default (1.35).
    expect(configBase.stroke_width_multiplier).toBe(1.35);
  });

  it('issue #2202: layers the board default under the user brush-thickness override, not instead of it', () => {
    // getBoardConfig memoizes by (board, layout, size, setIds, style, width,
    // renderSignature) — renderSignature must reflect the non-default
    // brushThickness below, or this call collides with the all-defaults
    // grasshopper case above and silently reuses its cached config.
    const boardConfig = _getBoardConfigForTests(
      'grasshopper',
      1,
      10,
      '24',
      false,
      undefined,
      {},
      {},
      1.5,
      1,
      'brush-1.5',
    );

    expect(boardConfig).not.toBeNull();
    const configBase = asRecord(boardConfig?.configBase);
    // 1.5 (user brush thickness) × 1.35 (Grasshopper default).
    expect(configBase.stroke_width_multiplier).toBeCloseTo(2.025);
  });

  it('leaves Kilter (no render-defaults entry) at exactly the user brush thickness', () => {
    const boardConfig = _getBoardConfigForTests('kilter', 1, 10, '24', false, undefined, {}, {}, 1.5, 1, 'brush-1.5');

    expect(boardConfig).not.toBeNull();
    const configBase = asRecord(boardConfig?.configBase);
    expect(configBase.stroke_width_multiplier).toBe(1.5);
  });
});

// The background-paths state in useNativeClimbRender is keyed by
// buildBoardKey so a FlashList row recycle (same hook instance, new
// props) can't surface the previous climb's paths. We can't easily
// exercise the React state through the hook without a renderer, but we
// can lock in the key-shape contract — that's the gate the hook uses to
// decide "is this stored entry for the current climb's board?"
describe('buildBoardKey', () => {
  it('is identical for the same board config regardless of frames', () => {
    // Two climbs on the same board/layout/size/setIds must share a
    // boardKey so the hook doesn't needlessly re-resolve backgrounds
    // when a list row recycles to a different climb on the same board.
    expect(buildBoardKey('kilter', 1, 10, '24,25')).toBe(buildBoardKey('kilter', 1, 10, '24,25'));
  });

  it('differs when boardName changes', () => {
    expect(buildBoardKey('kilter', 1, 10, '24,25')).not.toBe(buildBoardKey('tension', 1, 10, '24,25'));
  });

  it('differs when layoutId changes', () => {
    expect(buildBoardKey('kilter', 1, 10, '24,25')).not.toBe(buildBoardKey('kilter', 2, 10, '24,25'));
  });

  it('differs when sizeId changes', () => {
    expect(buildBoardKey('kilter', 1, 10, '24,25')).not.toBe(buildBoardKey('kilter', 1, 11, '24,25'));
  });

  it('differs when setIds changes', () => {
    expect(buildBoardKey('kilter', 1, 10, '24,25')).not.toBe(buildBoardKey('kilter', 1, 10, '26,27'));
  });

  it('does not collide on similar numeric values', () => {
    // Without a separator, "1-10" and "11-0" would both serialise to
    // "110". Guard against any regression that drops the dashes.
    expect(buildBoardKey('kilter', 1, 10, '24')).not.toBe(buildBoardKey('kilter', 11, 0, '24'));
  });

  it('differs by variant so a recycled row cannot mix thumb and full paths', () => {
    // A FlashList row recycled between a thumb context (list) and a full
    // context must re-resolve, not surface the previous size's paths.
    expect(buildBoardKey('kilter', 1, 10, '24', 'thumb')).not.toBe(buildBoardKey('kilter', 1, 10, '24', 'full'));
  });

  it('defaults to the full variant', () => {
    expect(buildBoardKey('kilter', 1, 10, '24')).toBe(buildBoardKey('kilter', 1, 10, '24', 'full'));
  });

  it('differs by colour scheme so a theme flip re-resolves the art (issue #3885)', () => {
    // The near-black MoonBoard layers resolve to `.dark.webp` siblings in dark
    // mode. Without this term, flipping the theme mid-session would leave the
    // previous scheme's paths on screen until some other prop happened to change.
    expect(buildBoardKey('moonboard', 1, 10, '1', 'full', 'dark')).not.toBe(
      buildBoardKey('moonboard', 1, 10, '1', 'full', 'light'),
    );
  });

  it('defaults to the light scheme', () => {
    expect(buildBoardKey('kilter', 1, 10, '24')).toBe(buildBoardKey('kilter', 1, 10, '24', 'full', 'light'));
  });
});

// The dedup + cap contract was extracted into a plain helper specifically
// so it can be tested without a working React renderer. The hook-level
// pieces that still need React (mountedRef guard, setState after settle)
// are covered by manual QA on device.
describe('getOrStartInflightRender', () => {
  beforeEach(() => {
    _inflightRendersForTests.clear();
  });

  it('starts a render and returns its promise on first call', async () => {
    const startRender = vi.fn().mockResolvedValue('file:///out/a.png');
    const result = await getOrStartInflightRender('key-a', startRender);
    expect(result.uri).toBe('file:///out/a.png');
    expect(startRender).toHaveBeenCalledTimes(1);
  });

  it('reuses the in-flight promise instead of starting a second render', async () => {
    let resolveFn: ((value: string) => void) | undefined;
    const startRender = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const first = getOrStartInflightRender('key-a', startRender);
    const second = getOrStartInflightRender('key-a', startRender);

    expect(first).toBe(second);
    expect(startRender).toHaveBeenCalledTimes(1);

    resolveFn?.('file:///out/a.png');
    expect((await first).uri).toBe('file:///out/a.png');
  });

  it('removes the entry once the render settles successfully', async () => {
    await getOrStartInflightRender('key-a', () => Promise.resolve('file:///out/a.png'));
    // Drain microtasks so the .finally cleanup runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(_inflightRendersForTests.has('key-a')).toBe(false);
  });

  it('removes the entry when the render rejects, without surfacing as unhandled', async () => {
    const promise = getOrStartInflightRender('key-a', () => Promise.reject(new Error('render failed')));
    // Caller is expected to handle the rejection — match the hook's
    // .catch(() => {}) pattern.
    await expect(promise).rejects.toThrow('render failed');
    await Promise.resolve();
    expect(_inflightRendersForTests.has('key-a')).toBe(false);
  });

  it('evicts the oldest entry when the cap is reached', async () => {
    // Each render hangs forever so entries stay in the map and we can
    // observe the cap behaviour. INFLIGHT_RENDERS_MAX = 50 in the module.
    const neverResolves = () => new Promise<string>(() => {});

    for (let entryIndex = 0; entryIndex < 50; entryIndex++) {
      void getOrStartInflightRender(`key-${entryIndex}`, neverResolves);
    }
    expect(_inflightRendersForTests.size).toBe(50);
    expect(_inflightRendersForTests.has('key-0')).toBe(true);

    // Inserting one more should evict key-0 (insertion order = oldest).
    void getOrStartInflightRender('key-50', neverResolves);
    expect(_inflightRendersForTests.size).toBe(50);
    expect(_inflightRendersForTests.has('key-0')).toBe(false);
    expect(_inflightRendersForTests.has('key-50')).toBe(true);
  });
});

// Verifies the eager warm-up that populates renderedOverlays from the
// on-disk PNG cache. This is what makes a drawer open instantly when the
// PNG already exists from a prior session: useState's initializer reads
// from this map synchronously.
describe('renderedOverlays warm-up from disk cache', () => {
  beforeEach(() => {
    _resetWarmupForTests();
    directoryListSpy.mockReset();
  });

  it('exposes the populated map so a fresh hook init can hit it synchronously', () => {
    expect(_renderedOverlaysForTests).toBeInstanceOf(Map);
    _cacheRenderedOverlayForTests('v12_kilter_1_10_24_deadbeef', 'file:///prior/session.png');
    expect(_renderedOverlaysForTests.get('v12_kilter_1_10_24_deadbeef')?.uri).toBe('file:///prior/session.png');
    _renderedOverlaysForTests.delete('v12_kilter_1_10_24_deadbeef');
  });

  it('mints a new generation when a render replaces the same URI', () => {
    const first = _cacheRenderedOverlayForTests('key-a', 'file:///same.png');
    const replacement = _cacheRenderedOverlayForTests('key-a', 'file:///same.png');

    expect(replacement.generation).toBeGreaterThan(first.generation);
    expect(replacement.uri).toBe(first.uri);
  });

  it('invalidates only an exact URI and generation', () => {
    const stale = _cacheRenderedOverlayForTests('key-a', 'file:///same.png');
    const replacement = _cacheRenderedOverlayForTests('key-a', 'file:///same.png');

    expect(_invalidateRenderedOverlayForTests('key-a', stale)).toBe(false);
    expect(_getRenderedOverlayForTests('key-a')).toEqual(replacement);
    expect(_invalidateRenderedOverlayForTests('key-a', replacement)).toBe(true);
    expect(_renderedOverlaysForTests.has('key-a')).toBe(false);
  });

  it('bounds the sync cache and promotes reads in LRU order', () => {
    for (let entryIndex = 0; entryIndex < 200; entryIndex++) {
      _cacheRenderedOverlayForTests(`key-${entryIndex}`, `file:///overlay-${entryIndex}.png`);
    }
    _getRenderedOverlayForTests('key-0');
    _cacheRenderedOverlayForTests('key-200', 'file:///overlay-200.png');

    expect(_renderedOverlaysForTests.size).toBe(200);
    expect(_renderedOverlaysForTests.has('key-0')).toBe(true);
    expect(_renderedOverlaysForTests.has('key-1')).toBe(false);
  });

  it('only loads PNGs whose name starts with the current RENDERER_VERSION prefix', () => {
    // Mix older leftovers (v4 files written before atomic publication, v5 files
    // the stale WASM drew at the wrong stroke width, v6 files from before the
    // Boardsesh drawing, v7 files from before the LED base plate) with current
    // v12 entries. The warm-up must surface only v12 keys; every older file is
    // invalid.
    const v1Entry = makeMockEntry('v1_kilter_1_10_24_aaaaaaaa.png');
    const v2Entry = makeMockEntry('v2_kilter_1_10_24_bbbbbbbb.png');
    const v3Entry = makeMockEntry('v3_kilter_1_10_24_eeeeeeee.png');
    const v4Entry = makeMockEntry('v4_kilter_1_10_24_ffffffff.png');
    const v5Entry = makeMockEntry('v5_kilter_1_10_24_99999999.png');
    const v6Entry = makeMockEntry('v6_kilter_1_10_24_77777777.png');
    const v7Entry = makeMockEntry('v7_kilter_1_10_24_66666666.png');
    // v8 was claimed by the Woods white-key branch, which landed on this same
    // line, so no shipped build ever published it — only a dev build of that
    // branch can have written one. Kept in the fixture anyway: a generation
    // being unreachable in the wild is not a reason for the sweep to trust it.
    const v8Entry = makeMockEntry('v8_kilter_1_10_24_55555555.png');
    // v9 is what TestFlight build 6 wrote, with the LED plate lit. Those PNGs
    // are on real devices and are the whole reason v12 exists.
    const v9Entry = makeMockEntry('v9_kilter_1_10_24_litplate.png');
    const currentEntryA = makeMockEntry('v12_kilter_1_10_24_cccccccc.png');
    const currentEntryB = makeMockEntry('v12_tension_2_8_15_dddddddd.png');
    directoryListSpy.mockReturnValue([
      v1Entry,
      v2Entry,
      v3Entry,
      v4Entry,
      v5Entry,
      v6Entry,
      v7Entry,
      v8Entry,
      v9Entry,
      currentEntryA,
      currentEntryB,
    ]);

    _runWarmupForTests();

    expect(_renderedOverlaysForTests.has('v12_kilter_1_10_24_cccccccc')).toBe(true);
    expect(_renderedOverlaysForTests.has('v12_tension_2_8_15_dddddddd')).toBe(true);
    expect(_renderedOverlaysForTests.has('v1_kilter_1_10_24_aaaaaaaa')).toBe(false);
    expect(_renderedOverlaysForTests.has('v2_kilter_1_10_24_bbbbbbbb')).toBe(false);
    expect(_renderedOverlaysForTests.has('v3_kilter_1_10_24_eeeeeeee')).toBe(false);
    expect(_renderedOverlaysForTests.has('v4_kilter_1_10_24_ffffffff')).toBe(false);
    expect(_renderedOverlaysForTests.has('v5_kilter_1_10_24_99999999')).toBe(false);
    expect(_renderedOverlaysForTests.has('v6_kilter_1_10_24_77777777')).toBe(false);
    expect(_renderedOverlaysForTests.has('v7_kilter_1_10_24_66666666')).toBe(false);
    expect(_renderedOverlaysForTests.has('v8_kilter_1_10_24_55555555')).toBe(false);
    expect(_renderedOverlaysForTests.has('v9_kilter_1_10_24_litplate')).toBe(false);
    // Only the two v12 entries should be present — no stragglers from
    // future-version PNGs slipping in either.
    expect(_renderedOverlaysForTests.size).toBe(2);
  });

  it('opportunistically deletes stale-version PNG files to reclaim disk', () => {
    const v1Entry = makeMockEntry('v1_kilter_1_10_24_aaaaaaaa.png');
    const v2Entry = makeMockEntry('v2_kilter_1_10_24_bbbbbbbb.png');
    const v4Entry = makeMockEntry('v4_kilter_1_10_24_stale.png');
    const v5Entry = makeMockEntry('v5_kilter_1_10_24_wrongstroke.png');
    const v6Entry = makeMockEntry('v6_kilter_1_10_24_preboardsesh.png');
    const v7Entry = makeMockEntry('v7_kilter_1_10_24_preplate.png');
    const v8Entry = makeMockEntry('v8_kilter_1_10_24_neverpublished.png');
    const v9Entry = makeMockEntry('v9_kilter_1_10_24_litplate.png');
    const currentEntry = makeMockEntry('v12_kilter_1_10_24_cccccccc.png');
    directoryListSpy.mockReturnValue([
      v1Entry,
      v2Entry,
      v4Entry,
      v5Entry,
      v6Entry,
      v7Entry,
      v8Entry,
      v9Entry,
      currentEntry,
    ]);

    _runWarmupForTests();

    expect(v1Entry.delete).toHaveBeenCalledTimes(1);
    expect(v2Entry.delete).toHaveBeenCalledTimes(1);
    expect(v4Entry.delete).toHaveBeenCalledTimes(1);
    expect(v5Entry.delete).toHaveBeenCalledTimes(1);
    expect(v6Entry.delete).toHaveBeenCalledTimes(1);
    expect(v7Entry.delete).toHaveBeenCalledTimes(1);
    expect(v8Entry.delete).toHaveBeenCalledTimes(1);
    expect(v9Entry.delete).toHaveBeenCalledTimes(1);
    // Current-version files must never be deleted — they're the cache hits
    // the warm-up exists to surface.
    expect(currentEntry.delete).not.toHaveBeenCalled();
  });

  it('keeps loading remaining entries when a delete throws', () => {
    // A delete failure (permissions, file-already-gone race) must not abort
    // the warm-up walk: we'd lose every current-version hit that follows.
    const v1Entry = makeMockEntry('v1_kilter_1_10_24_aaaaaaaa.png');
    v1Entry.delete.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const currentEntry = makeMockEntry('v12_kilter_1_10_24_bbbbbbbb.png');
    directoryListSpy.mockReturnValue([v1Entry, currentEntry]);

    expect(() => _runWarmupForTests()).not.toThrow();
    expect(_renderedOverlaysForTests.has('v12_kilter_1_10_24_bbbbbbbb')).toBe(true);
  });
});

describe('withLitHoldGeometry', () => {
  const outline = [-1, -1, 1, -1, 1, 1, -1, 1];
  const plate = [-0.6, -0.6, 0.6, -0.6, 0.6, 0.6, -0.6, 0.6];
  const holds = [10, 20, 30].map((id) => ({ id, mirroredHoldId: null, cx: id, cy: id, r: 5 }));

  it('attaches the plate ring to a lit traced hold, and to nobody else', () => {
    const attached = _withLitHoldGeometryForTests(
      holds,
      {
        // Hold 10 is lit and traced. Hold 20 is lit with a plate ring but no
        // silhouette — the shape a half-finished annotation takes, and a ring
        // with no outer edge describes no plate. Hold 30 is traced and plated
        // but not lit.
        outlines: { 10: outline, 30: outline },
        silhouetteLightness: {},
        ledBright: {},
        ledInner: { 10: plate, 20: plate, 30: plate },
      },
      'p10r12p20r13',
    );
    const byId = new Map(attached.map((hold) => [hold.id, hold]));

    expect(byId.get(10)?.led_inner).toEqual(plate);
    expect(byId.get(20)?.led_inner).toBeUndefined();
    expect(byId.get(30)?.led_inner).toBeUndefined();
  });

  it('carries no plate ring on a shard that has no table, which is every shard today', () => {
    const attached = _withLitHoldGeometryForTests(
      holds,
      { outlines: { 10: outline }, silhouetteLightness: {}, ledBright: {} },
      'p10r12',
    );
    for (const hold of attached) {
      expect(hold.led_inner).toBeUndefined();
    }
    expect(attached.find((hold) => hold.id === 10)?.outline).toEqual(outline);
  });
});
