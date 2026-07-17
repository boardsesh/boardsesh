// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
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

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));

vi.mock('../../lib/hold-color-overrides', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/hold-color-overrides')>();
  const stableOverrides = {
    overrides: { HAND: '#123456' },
    shapes: { FOOT: 'diamond' },
    brushThickness: 1.5,
    shapeSize: 1.8,
    renderSignature: 'hand-123456.foot-diamond.brush-1.5.size-1.8',
  };
  return { ...original, useHoldColorOverrides: () => stableOverrides };
});

const fakeRenderer = {
  boardRendererNative: {},
  renderHoldsOverlay: vi.fn(async (_configJson: string, cacheKey: string) => {
    if (!cacheKey.endsWith('_markers-default')) {
      throw new Error('Marker shape, size, and brush overrides require a rebuilt BoardRenderer native binary');
    }
    return 'file:///fallback-overlay.png';
  }),
};

const { useNativeClimbRender, _inflightRendersForTests, _renderedOverlaysForTests, _setNativeModuleForTests } =
  await import('../use-native-climb-render');

describe('useNativeClimbRender marker fallback', () => {
  beforeEach(() => {
    fakeRenderer.renderHoldsOverlay.mockClear();
    _inflightRendersForTests.clear();
    _renderedOverlaysForTests.clear();
    _setNativeModuleForTests(fakeRenderer as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('retries once with default marker geometry while preserving custom colors', async () => {
    const { result } = renderHook(() =>
      useNativeClimbRender({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '24',
        frames: 'p1r12',
      }),
    );

    await waitFor(() => expect(result.current.overlayUri).toBe('file:///fallback-overlay.png'));
    expect(fakeRenderer.renderHoldsOverlay).toHaveBeenCalledTimes(2);
    const fallbackCall = fakeRenderer.renderHoldsOverlay.mock.calls[1];
    expect(fallbackCall?.[1]).toMatch(/_markers-default$/);
    const fallbackConfig = JSON.parse(fallbackCall?.[0] ?? '{}') as {
      stroke_width_multiplier: number;
      shape_size_multiplier: number;
      hold_state_map: Record<string, { color: string; shape?: string }>;
    };
    expect(fallbackConfig.stroke_width_multiplier).toBe(1);
    expect(fallbackConfig.shape_size_multiplier).toBe(1);
    expect(Object.values(fallbackConfig.hold_state_map).some((state) => state.color === '#123456')).toBe(true);
    expect(Object.values(fallbackConfig.hold_state_map).some((state) => state.shape != null)).toBe(false);
  });
});
