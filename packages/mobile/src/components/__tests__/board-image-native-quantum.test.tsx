// @vitest-environment jsdom
import { createElement, useLayoutEffect, type CSSProperties, type ReactNode, type SVGProps } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeRender = vi.hoisted(() => ({ calls: 0, runtimeLoads: 0, variants: [] as Array<string | undefined> }));

vi.mock('expo-image', () => ({
  Image: ({ testID, onDisplay, style }: { testID?: string; onDisplay?: () => void; style?: CSSProperties }) =>
    createElement('img', { 'data-testid': testID, onLoad: onDisplay, style }),
}));

type MockViewProps = {
  children?: ReactNode;
  style?: CSSProperties | CSSProperties[];
  pointerEvents?: string;
  onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
};

vi.mock('react-native', () => ({
  View: ({ children, style, pointerEvents, onLayout }: MockViewProps) => {
    useLayoutEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 300, height: 400 } } });
    }, [onLayout]);
    return createElement(
      'div',
      { style: Array.isArray(style) ? Object.assign({}, ...style) : style, 'data-pointer-events': pointerEvents },
      children,
    );
  },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'ios' },
}));

vi.mock('react-native-svg', () => {
  const element =
    (tag: string) =>
    ({ testID, ...props }: SVGProps<SVGElement> & { testID?: string }) =>
      createElement(tag, { ...props, 'data-testid': testID });
  return {
    default: element('svg'),
    Path: element('path'),
    Rect: element('rect'),
    Circle: element('circle'),
    Polygon: element('polygon'),
    G: element('g'),
  };
});

vi.mock('../../../modules/climb-overlay-gpu/src', () => ({
  NativeFrameClimbOverlayGPU: null,
  NativeMotionClimbOverlayGPU: null,
}));
vi.mock('../../providers/feature-flags-provider', () => ({ useGpuClimbOverlayEnabled: () => false }));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#ddd' },
    chartColors: { secondaryBackground: '#eeeeee', separator: '#cccccc', secondaryLabel: '#777777' },
  }),
}));
vi.mock('../../lib/board-render/warm-board-art-memory', () => ({
  isBoardArtInMemory: () => false,
  warmBoardArtMemory: vi.fn(),
}));

vi.mock('../../theme/tokens', () => ({ borderRadius: { md: 8 } }));

vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: () => {
    nativeRender.calls += 1;
    return {
      overlayUri: null,
      overlayLoadKey: null,
      onOverlayLoad: () => {},
      onOverlayError: () => {},
      backgroundPaths: [],
      missingBackgroundCount: 0,
      artworkIdentity: { colorScheme: 'dark' },
      boardseshRendererAvailable: true,
      rendererUnavailable: false,
    };
  },
}));

vi.mock('../GpuClimbOverlay', () => ({ GpuClimbOverlay: () => null }));
vi.mock('../board/MoonBoardGridLabels', () => ({ MoonBoardGridLabels: () => null }));

vi.mock('../LayeredClimbImage', () => ({
  LayeredClimbImage: () => createElement('div', { 'data-testid': 'photo-board' }),
}));

vi.mock('../quantum/quantum-board-image-loader', async () => {
  const { QuantumBoardImage } = await import('../quantum/QuantumBoardImage');
  const RuntimeImage = (props: Parameters<typeof QuantumBoardImage>[0]) => {
    nativeRender.variants.push(props.backgroundVariant);
    return createElement('div', { 'data-testid': 'quantum-board' }, createElement(QuantumBoardImage, props));
  };
  return {
    loadQuantumBoardImage: () => {
      nativeRender.runtimeLoads += 1;
      return RuntimeImage;
    },
  };
});

import { BoardImageNative } from '../BoardImageNative';
import { ClimbListThumbnail, ClimbListThumbnailPrewarm } from '../ClimbListThumbnail';
import { HeatmapOverlay } from '../board/HeatmapOverlay';
import { getQuantumGeometryBoardDetails } from '../../lib/quantum-geometry-store';
import { loadHoldColorOverrides, setHoldColorOverridesPreference } from '../../lib/hold-color-overrides';

const baseProps = {
  frames: '',
  layoutId: 9101,
  sizeId: 9201,
  setIds: '1',
  boardWidth: 1500,
  boardHeight: 1500,
};

beforeEach(async () => {
  nativeRender.calls = 0;
  nativeRender.runtimeLoads = 0;
  nativeRender.variants = [];
  await setHoldColorOverridesPreference({});
});

afterEach(cleanup);

describe('BoardImageNative Quantum routing', () => {
  it('uses full Quantum artwork without invoking the raster renderer hook', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(BoardImageNative, { ...baseProps, boardName: 'quantum' }),
    );

    expect(getByTestId('quantum-board')).toBeTruthy();
    expect(queryByTestId('photo-board')).toBeNull();
    expect(nativeRender.calls).toBe(0);
    expect(nativeRender.variants.at(-1)).toBe('full');
  });

  it('leaves the existing photo-backed board path unchanged', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(BoardImageNative, {
        ...baseProps,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
      }),
    );

    expect(getByTestId('photo-board')).toBeTruthy();
    expect(queryByTestId('quantum-board')).toBeNull();
    expect(nativeRender.calls).toBe(1);
    expect(nativeRender.runtimeLoads).toBe(0);
  });

  it('draws the real authoring heatmap under lit holds without requesting an unsupported native render', () => {
    const details = getQuantumGeometryBoardDetails(baseProps.layoutId, baseProps.sizeId);
    const hold = details?.holdsData[0];
    if (!details || !hold) throw new Error('Expected fixed Quantum hold geometry');
    const { container, getByTestId } = render(
      createElement(BoardImageNative, {
        ...baseProps,
        boardName: 'quantum',
        frames: `p${hold.id}r12`,
        overlayTestID: 'lit-climb',
        underOverlay: createElement(HeatmapOverlay, {
          ...baseProps,
          boardName: 'quantum',
          boardWidth: details.boardWidth,
          boardHeight: details.boardHeight,
          holdTargets: details.holdsData,
          layer: {
            cells: [{ holdId: hold.id, bucket: 4, code: 904, color: '#ff8800' }],
            codeColors: { 904: { color: '#ff8800' } },
            legend: { kind: 'count', edgeValues: [1, 2, 3, 4, 5], total: 5 },
          },
        }),
      }),
    );
    const heatDot = Array.from(container.querySelectorAll('div')).find(
      (element) => element.style.backgroundColor === 'rgba(255, 136, 0, 0.85)',
    );
    expect(heatDot).toBeDefined();
    if (!heatDot) throw new Error('Expected a measured Quantum heatmap dot');
    expect(heatDot.closest('svg')).toBeNull();
    expect(Number.parseFloat(heatDot.style.width)).toBeGreaterThan(0);
    expect(heatDot.parentElement?.getAttribute('data-pointer-events')).toBe('none');

    const wall = getByTestId('quantum-board-artwork');
    fireEvent.load(wall);
    const litClimb = getByTestId('lit-climb');
    expect(wall.compareDocumentPosition(heatDot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heatDot.compareDocumentPosition(litClimb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(litClimb.querySelector('circle')?.getAttribute('fill')).toBe('#00FF00');
    expect(litClimb.querySelector('circle')?.getAttribute('fill-opacity')).toBe('0.6');
    expect(litClimb.getAttribute('pointer-events')).toBe('none');
    expect(litClimb.style.position).toBe('absolute');
    expect(litClimb.getAttribute('viewBox')).toBe(`0 0 ${details.boardWidth} ${details.boardHeight}`);
    expect(Number(wall.style.zIndex)).toBeLessThan(Number(heatDot.parentElement?.parentElement?.style.zIndex));
    expect(Number(heatDot.parentElement?.parentElement?.style.zIndex)).toBeLessThan(Number(litClimb.style.zIndex));
    expect(nativeRender.calls).toBe(0);
  });

  it('renders candidate palettes, shipped colours, and stored colours without changing preferences', async () => {
    const hold = getQuantumGeometryBoardDetails(baseProps.layoutId, baseProps.sizeId)?.holdsData[0];
    if (!hold) throw new Error('Expected fixed Quantum hold geometry');
    await setHoldColorOverridesPreference({ STARTING: '#123456' });
    const props = { ...baseProps, boardName: 'quantum' as const, frames: `p${hold.id}r12` };
    const view = render(createElement(BoardImageNative, { ...props, holdColorOverride: { STARTING: '#abcdef' } }));
    expect(view.container.querySelector('circle')?.getAttribute('fill')).toBe('#abcdef');

    view.rerender(createElement(BoardImageNative, { ...props, holdColorOverride: { STARTING: '#654321' } }));
    expect(view.container.querySelector('circle')?.getAttribute('fill')).toBe('#654321');
    view.rerender(createElement(BoardImageNative, { ...props, holdColorOverride: {} }));
    expect(view.container.querySelector('circle')?.getAttribute('fill')).toBe('#00FF00');
    view.rerender(createElement(BoardImageNative, props));
    expect(view.container.querySelector('circle')?.getAttribute('fill')).toBe('#123456');
    expect(await loadHoldColorOverrides()).toEqual({ STARTING: '#123456' });
  });
});

describe('ClimbListThumbnail Quantum routing', () => {
  it('does not load a runtime image or start raster work while prewarming', () => {
    const { container } = render(createElement(ClimbListThumbnailPrewarm, { ...baseProps, boardName: 'quantum' }));
    expect(container.childElementCount).toBe(0);
    expect(nativeRender.calls).toBe(0);
    expect(nativeRender.runtimeLoads).toBe(0);
  });

  it('uses thumbnail Quantum artwork without invoking the raster renderer hook', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(ClimbListThumbnail, { ...baseProps, boardName: 'quantum' }),
    );

    expect(getByTestId('quantum-board')).toBeTruthy();
    expect(queryByTestId('photo-board')).toBeNull();
    expect(nativeRender.calls).toBe(0);
    expect(nativeRender.variants.at(-1)).toBe('thumb');
  });

  it('keeps photo-backed list thumbnails on the native raster path', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(ClimbListThumbnail, {
        ...baseProps,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
      }),
    );

    expect(getByTestId('photo-board')).toBeTruthy();
    expect(queryByTestId('quantum-board')).toBeNull();
    expect(nativeRender.calls).toBe(1);
    expect(nativeRender.runtimeLoads).toBe(0);
  });
});
