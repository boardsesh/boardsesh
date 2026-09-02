// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Issue #4495: a renderer that refuses marker overrides used to blank the
// overlay for EVERY climb — the hook recorded the signature and its effect
// early-returned forever, even though the code comments, the web README and
// this suite's sibling all promised it "falls back to default rendering".
// A refusal is about marker GEOMETRY, so the fallback keeps the user's colours
// and drops only the shape/size/brush overrides.

vi.mock('../../providers/theme-provider', () => ({
  useAppColorScheme: () => 'light',
}));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: vi.fn(() => ({ exists: false })),
  Paths: { cache: { uri: 'file:///cache/' } },
}));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    boardWidth: 1000,
    boardHeight: 1200,
    holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
  })),
}));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({
  reportError: reportErrorMock,
  addErrorBreadcrumb: vi.fn(),
}));

// A climber who set BOTH a colour and a marker shape. Referentially stable so
// the overlay effect only re-fires on a real input change.
const markerOverrides = vi.hoisted(() => ({
  colors: { HAND: '#ff0000' } as Record<string, string>,
  shapes: { HAND: 'square' } as Record<string, string>,
  brushThickness: 2,
  shapeSize: 1.5,
}));

vi.mock('../../lib/hold-color-overrides', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/hold-color-overrides')>();
  const stableOverrides = {
    overrides: markerOverrides.colors,
    shapes: markerOverrides.shapes,
    brushThickness: markerOverrides.brushThickness,
    shapeSize: markerOverrides.shapeSize,
    renderSignature: original.buildHoldRenderOverrideSignature({
      colors: markerOverrides.colors,
      shapes: markerOverrides.shapes,
      brushThickness: markerOverrides.brushThickness,
      shapeSize: markerOverrides.shapeSize,
    } as Parameters<typeof original.buildHoldRenderOverrideSignature>[0]),
  };
  return { ...original, useHoldColorOverrides: () => stableOverrides };
});

const {
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_COLOR_SIGNATURE,
  DEFAULT_HOLD_SHAPE_SIZE,
  buildHoldColorOverrideSignature,
  buildHoldRenderOverrideSignature,
} = await import('../../lib/hold-color-overrides');
const { getBoardStrokeWidthMultiplier } = await import('@boardsesh/board-constants/hold-states');

const {
  useNativeClimbRender,
  buildCacheKey,
  resolveEffectiveRenderOverrides,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _resetWarmupForTests,
  _setNativeModuleForTests,
  _unsupportedRenderSignaturesForTests,
  _markRenderSignatureUnsupportedForTests,
  _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS,
} = await import('../use-native-climb-render');

const BASE = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  filledStyle: false,
};
const FRAMES = 'p1100r12p1200r13';

const FULL_SIGNATURE = buildHoldRenderOverrideSignature({
  colors: markerOverrides.colors,
  shapes: markerOverrides.shapes,
  brushThickness: markerOverrides.brushThickness,
  shapeSize: markerOverrides.shapeSize,
} as Parameters<typeof buildHoldRenderOverrideSignature>[0]);
const COLOR_ONLY_SIGNATURE = buildHoldColorOverrideSignature(markerOverrides.colors);

function cacheKeyFor(signature: string): string {
  return buildCacheKey(
    BASE.boardName,
    BASE.layoutId,
    BASE.sizeId,
    BASE.setIds,
    FRAMES,
    BASE.filledStyle,
    undefined,
    signature,
  );
}

describe('resolveEffectiveRenderOverrides', () => {
  beforeEach(() => {
    _unsupportedRenderSignaturesForTests.clear();
  });

  it('passes the climber’s settings through untouched while the renderer accepts them', () => {
    const resolved = resolveEffectiveRenderOverrides(
      markerOverrides.colors,
      markerOverrides.shapes,
      1.5,
      0.5,
      FULL_SIGNATURE,
    );

    expect(resolved.signature).toBe(FULL_SIGNATURE);
    expect(resolved.shapes).toBe(markerOverrides.shapes);
    expect(resolved.brushThickness).toBe(1.5);
    expect(resolved.shapeSize).toBe(0.5);
  });

  it('keeps the colours and drops the marker geometry once the renderer refuses', () => {
    _markRenderSignatureUnsupportedForTests(FULL_SIGNATURE);

    const resolved = resolveEffectiveRenderOverrides(
      markerOverrides.colors,
      markerOverrides.shapes,
      1.5,
      0.5,
      FULL_SIGNATURE,
    );

    expect(resolved.signature).toBe(COLOR_ONLY_SIGNATURE);
    expect(resolved.colors).toBe(markerOverrides.colors);
    expect(resolved.shapes).toEqual({});
    expect(resolved.brushThickness).toBe(DEFAULT_HOLD_BRUSH_THICKNESS);
    expect(resolved.shapeSize).toBe(DEFAULT_HOLD_SHAPE_SIZE);
  });

  it('falls all the way back to the board palette when colours alone are refused too', () => {
    _markRenderSignatureUnsupportedForTests(FULL_SIGNATURE);
    _markRenderSignatureUnsupportedForTests(COLOR_ONLY_SIGNATURE);

    const resolved = resolveEffectiveRenderOverrides(
      markerOverrides.colors,
      markerOverrides.shapes,
      1.5,
      0.5,
      FULL_SIGNATURE,
    );

    expect(resolved.signature).toBe(DEFAULT_HOLD_COLOR_SIGNATURE);
    expect(resolved.colors).toEqual({});
    expect(resolved.shapes).toEqual({});
  });
});

describe('useNativeClimbRender marker-capability fallback', () => {
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(),
  };

  beforeEach(() => {
    _resetWarmupForTests();
    _renderedOverlaysForTests.clear();
    _inflightRendersForTests.clear();
    _unsupportedRenderSignaturesForTests.clear();
    reportErrorMock.mockClear();
    nativeModule.renderHoldsOverlay.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('re-renders with colours only instead of leaving the overlay blank', async () => {
    const refusedKey = cacheKeyFor(FULL_SIGNATURE);
    const fallbackKey = cacheKeyFor(COLOR_ONLY_SIGNATURE);
    nativeModule.renderHoldsOverlay.mockImplementation(async (_configJson: string, cacheKey: string) => {
      if (cacheKey === refusedKey) throw new Error(_MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS);
      return 'file:///overlay-colors-only.png';
    });

    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES }));

    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay-colors-only.png'));

    const requestedKeys = nativeModule.renderHoldsOverlay.mock.calls.map(([, cacheKey]) => cacheKey);
    expect(requestedKeys).toContain(refusedKey);
    expect(requestedKeys).toContain(fallbackKey);
    expect(_unsupportedRenderSignaturesForTests.has(FULL_SIGNATURE)).toBe(true);
    // The refusal is a designed fallback, not a defect worth paging on.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('sends the degraded config, not the full one, under the fallback cache key', async () => {
    const refusedKey = cacheKeyFor(FULL_SIGNATURE);
    nativeModule.renderHoldsOverlay.mockImplementation(async (_configJson: string, cacheKey: string) => {
      if (cacheKey === refusedKey) throw new Error(_MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS);
      return 'file:///overlay-colors-only.png';
    });

    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES }));
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay-colors-only.png'));

    const fallbackCall = nativeModule.renderHoldsOverlay.mock.calls.find(([, cacheKey]) => cacheKey !== refusedKey) as [
      string,
      string,
    ];
    const fallbackConfig = JSON.parse(fallbackCall[0]) as {
      stroke_width_multiplier: number;
      shape_size_multiplier: number;
      hold_state_map: Record<string, { color: string; shape?: string }>;
    };

    expect(fallbackConfig.shape_size_multiplier).toBe(DEFAULT_HOLD_SHAPE_SIZE);
    // Brush thickness is the third field an older renderer cannot honour, and it
    // is the one that reaches the config as a product with the board's own
    // default — so assert the resolved number, not just "not 2".
    expect(fallbackConfig.stroke_width_multiplier).toBe(
      DEFAULT_HOLD_BRUSH_THICKNESS * getBoardStrokeWidthMultiplier('kilter'),
    );
    expect(Object.values(fallbackConfig.hold_state_map).some((state) => state.shape !== undefined)).toBe(false);
    // Colours survive — they are what every renderer has always honoured.
    expect(Object.values(fallbackConfig.hold_state_map).some((state) => state.color === '#ff0000')).toBe(true);
  });
});
