// @vitest-environment jsdom
import { createElement, useLayoutEffect, type CSSProperties, type ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HoldColorOverrides } from '../../lib/hold-color-overrides';

const renderer = vi.hoisted(() => ({
  apiVersion: 5,
  enabled: true,
  fillAvailable: true,
  requests: [] as Array<{
    frames: string;
    gpuSurface?: boolean;
    filledStyle?: boolean;
    prefetch?: boolean;
    holdColorOverride?: HoldColorOverrides;
    markStyleOverride?: string;
    extraHoldStates?: Record<number, { color: string }>;
  }>,
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    style,
    pointerEvents,
    onLayout,
  }: {
    children?: ReactNode;
    style?: CSSProperties | CSSProperties[];
    pointerEvents?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    useLayoutEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 300, height: 400 } } });
    }, [onLayout]);
    return createElement(
      'div',
      {
        style: Array.isArray(style) ? Object.assign({}, ...style) : style,
        'data-pointer-events': pointerEvents,
      },
      children,
    );
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'ios' },
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img', { alt: 'heatmap' }) }));
vi.mock('../../../modules/climb-overlay-gpu/src', () => ({
  NativeFrameClimbOverlayGPU: () => null,
  NativeMotionClimbOverlayGPU: () => null,
}));
vi.mock('../../lib/board-render/gpu-native-capability', () => ({
  get climbOverlayGpuApiVersion() {
    return renderer.apiVersion;
  },
}));
vi.mock('../../providers/feature-flags-provider', () => ({ useGpuClimbOverlayEnabled: () => renderer.enabled }));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../hooks/use-board-accessibility-summary', () => ({ useBoardAccessibilitySummary: () => 'Quantum climb' }));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { fill: '#ddd' } }) }));
vi.mock('../../lib/board-render/warm-board-art-memory', () => ({
  isBoardArtInMemory: () => true,
  warmBoardArtMemory: vi.fn(),
}));
vi.mock('../../theme/tokens', () => ({ borderRadius: { md: 8 } }));
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: (request: (typeof renderer.requests)[number]) => {
    renderer.requests.push(request);
    return {
      overlayUri: '/quantum-overlay.png',
      overlayLoadKey: 'quantum-overlay',
      overlayCacheKey: 'quantum-cache',
      overlayImmediate: true,
      overlayUnavailable: false,
      onOverlayLoad: vi.fn(),
      onOverlayError: vi.fn(),
      backgroundPaths: ['/quantum-xl.webp'],
      backgroundsLoading: false,
      missingBackgroundCount: 0,
      artworkIdentity: { colorScheme: 'dark' },
      boardseshRendererAvailable: renderer.fillAvailable,
      rendererUnavailable: false,
      gpuConfigJson: request.gpuSurface ? 'quantum-config' : null,
      gpuStatus: request.gpuSurface ? 'ready' : 'unavailable',
    };
  },
}));
vi.mock('../GpuClimbOverlay', () => ({
  GpuClimbOverlay: ({ displayMirrored }: { displayMirrored: boolean }) =>
    createElement('div', { 'data-testid': 'quantum-gpu', 'data-mirrored': String(displayMirrored) }),
}));
vi.mock('../board/MoonBoardGridLabels', () => ({ MoonBoardGridLabels: () => null }));
vi.mock('../LayeredClimbImage', () => ({
  LayeredClimbImage: ({
    liveOverlay,
    underOverlay,
    mirrored,
  }: {
    liveOverlay?: { node: ReactNode };
    underOverlay?: ReactNode;
    mirrored?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'standard-board', 'data-mirrored': String(mirrored) },
      underOverlay,
      liveOverlay?.node,
    ),
}));

import { BoardImageNative } from '../BoardImageNative';
import { ClimbListThumbnail, ClimbListThumbnailPrewarm } from '../ClimbListThumbnail';
import { HeatmapOverlay } from '../board/HeatmapOverlay';

const BOARD = {
  boardName: 'quantum' as const,
  frames: 'p1000001r12',
  layoutId: 9101,
  sizeId: 9201,
  setIds: '1',
  boardWidth: 1536,
  boardHeight: 1552,
};

beforeEach(() => {
  renderer.requests = [];
  renderer.enabled = true;
  renderer.fillAvailable = true;
  renderer.apiVersion = 5;
});
afterEach(cleanup);

describe('Quantum standard Aura path', () => {
  it.each([
    [9101, 9201],
    [9101, 9202],
    [9101, 9203],
    [9104, 9204],
  ])('requests GPU rendering for released model %i/%i', (layoutId, sizeId) => {
    render(createElement(BoardImageNative, { ...BOARD, layoutId, sizeId, playSurface: true }));
    expect(renderer.requests.at(-1)?.gpuSurface).toBe(true);
    expect(screen.getAllByTestId('standard-board').length).toBeGreaterThan(0);
    expect(screen.getByTestId('quantum-gpu')).toBeTruthy();
  });

  it.each([0, 2, 3, 4])('uses the standard PNG path below API5 (API%i)', (apiVersion) => {
    renderer.apiVersion = apiVersion;
    render(createElement(BoardImageNative, { ...BOARD, playSurface: true }));
    expect(renderer.requests.at(-1)?.gpuSurface).toBe(false);
    expect(screen.queryByTestId('quantum-gpu')).toBeNull();
    expect(screen.getAllByTestId('standard-board').length).toBeGreaterThan(0);
  });

  it.each(['player', 'thumbnail'] as const)('ignores stale Quantum mirroring on the %s', (surface) => {
    render(
      surface === 'player'
        ? createElement(BoardImageNative, { ...BOARD, playSurface: true, mirrored: true })
        : createElement(ClimbListThumbnail, { ...BOARD, mirrored: true }),
    );
    for (const layer of screen.getAllByTestId('standard-board')) {
      expect(layer.getAttribute('data-mirrored')).toBe('false');
    }
    if (surface === 'player') expect(screen.getByTestId('quantum-gpu').getAttribute('data-mirrored')).toBe('false');
  });

  it('preserves mirrored rendering for supported Tension climbs', () => {
    render(
      createElement(BoardImageNative, {
        ...BOARD,
        boardName: 'tension',
        layoutId: 9,
        playSurface: true,
        mirrored: true,
      }),
    );
    expect(screen.getByTestId('quantum-gpu').getAttribute('data-mirrored')).toBe('true');
    for (const layer of screen.getAllByTestId('standard-board')) {
      expect(layer.getAttribute('data-mirrored')).toBe('true');
    }
  });

  it('keeps the Quantum heatmap dot fallback in unmirrored physical coordinates', () => {
    renderer.fillAvailable = false;
    const { container } = render(
      createElement(HeatmapOverlay, {
        ...BOARD,
        mirrored: true,
        boardWidth: 100,
        boardHeight: 100,
        holdTargets: [{ id: 1000001, cx: 20, cy: 40, r: 10 }],
        layer: {
          cells: [{ holdId: 1000001, bucket: 4, code: 904, color: '#ff8800' }],
          codeColors: { 904: { color: '#ff8800' } },
          legend: { kind: 'count', edgeValues: [1, 2, 3, 4, 5], total: 5 },
        },
      }),
    );
    const dot = container.querySelector<HTMLElement>('[data-pointer-events="none"] > div');
    expect(dot?.style.left).toBe('20%');
  });

  it('honours the GPU switch and preserves per-session and preview colours', () => {
    renderer.enabled = false;
    const overrides = { STARTING: '#abcdef' };
    const view = render(createElement(BoardImageNative, { ...BOARD, playSurface: true, holdColorOverride: overrides }));
    expect(renderer.requests.at(-1)).toMatchObject({ gpuSurface: false, holdColorOverride: overrides });
    view.rerender(createElement(BoardImageNative, { ...BOARD, holdColorOverride: {} }));
    expect(renderer.requests.at(-1)?.holdColorOverride).toEqual({});
  });

  it('renders and prewarms list thumbnails through the standard raster hook', () => {
    render(createElement(ClimbListThumbnail, BOARD));
    expect(screen.getAllByTestId('standard-board').length).toBeGreaterThan(0);
    expect(renderer.requests.at(-1)?.filledStyle).toBe(true);
    render(createElement(ClimbListThumbnailPrewarm, BOARD));
    expect(renderer.requests.at(-1)).toMatchObject({ filledStyle: true, prefetch: true });
  });

  it('requests silhouette fills for the authoring heatmap under the lit climb', () => {
    render(
      createElement(BoardImageNative, {
        ...BOARD,
        underOverlay: createElement(HeatmapOverlay, {
          ...BOARD,
          holdTargets: [{ id: 1000001, cx: 50, cy: 60, r: 10 }],
          layer: {
            cells: [{ holdId: 1000001, bucket: 4, code: 904, color: '#ff8800' }],
            codeColors: { 904: { color: '#ff8800' } },
            legend: { kind: 'count', edgeValues: [1, 2, 3, 4, 5], total: 5 },
          },
        }),
      }),
    );
    expect(renderer.requests).toContainEqual(
      expect.objectContaining({
        frames: 'p1000001r904',
        markStyleOverride: 'fill',
        extraHoldStates: { 904: { color: '#ff8800' } },
      }),
    );
    expect(screen.getByRole('img', { name: 'heatmap' })).toBeTruthy();
  });
});
