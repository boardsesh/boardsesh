// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; testID?: string; style?: unknown };
const imageEvents = vi.hoisted(() => ({
  loadCallbacks: [] as Array<() => void>,
  displays: [] as Array<{ uri: string; display?: () => void }>,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID, style }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-opacity':
          typeof style === 'object' && style !== null && 'opacity' in style ? String(style.opacity) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-image', () => ({
  Image: ({ source, onLoad, onDisplay }: { source: { uri: string }; onLoad?: () => void; onDisplay?: () => void }) => {
    if (onLoad) imageEvents.loadCallbacks.push(onLoad);
    imageEvents.displays.push({ uri: source.uri, display: onDisplay });
    return createElement('img', { src: source.uri, onLoad });
  },
}));

vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

// The renderer is driven by the test: what matters here is which layers
// BoardImageNative asks LayeredClimbImage to draw, not how a PNG is produced.
const renderResult = vi.hoisted(() => ({
  current: { overlayUri: null, rendererUnavailable: false } as {
    overlayUri: string | null;
    rendererUnavailable: boolean;
    overlayFailed?: boolean;
  },
}));
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: () => ({
    overlayUri: renderResult.current.overlayUri,
    overlayLoadKey: renderResult.current.overlayUri,
    onOverlayLoad: () => {},
    onOverlayError: () => {},
    onOverlayMounted: () => {},
    backgroundPaths: ['/bundled/kilter.webp'],
    missingBackgroundCount: 0,
    rendererUnavailable: renderResult.current.rendererUnavailable,
    overlayFailed: renderResult.current.overlayFailed,
    artworkIdentity: {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '26,27',
      frames: 'p1r12',
      renderSignature: 'classic',
      colorScheme: 'dark',
    },
  }),
}));

import { BoardImageNative } from '../BoardImageNative';
import { cacheRenderedOverlay } from '../../lib/overlay-index';
import { captureReadyBoardArt } from '../../lib/board-render/ready-board-art';

const BOARD = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  boardWidth: 1080,
  boardHeight: 1080,
};

function overlaySources(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('img'))
    .map((image) => image.getAttribute('src') ?? '')
    .filter((source) => source.includes('overlay'));
}

describe('BoardImageNative overlay layers', () => {
  it('publishes a terminal failure without declaring missing holds ready', () => {
    imageEvents.displays.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-ready.png', rendererUnavailable: false };
    const readiness = vi.fn();
    const props = { ...BOARD, frames: 'p1r12', onArtReadinessChange: readiness };
    const { rerender } = render(createElement(BoardImageNative, props));
    expect(readiness).toHaveBeenLastCalledWith('loading');
    act(() => {
      for (const event of imageEvents.displays) event.display?.();
    });
    expect(readiness).toHaveBeenLastCalledWith('ready');
    renderResult.current = { overlayUri: null, rendererUnavailable: false, overlayFailed: true };
    rerender(createElement(BoardImageNative, { ...props, renderWidth: 601 }));
    expect(readiness).toHaveBeenLastCalledWith('failed');
  });

  it('preserves this climb’s displayed holds through measured-width regeneration, then drops them on climb change', () => {
    imageEvents.displays.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-old-width.png', rendererUnavailable: false };
    const props = { ...BOARD, frames: 'p1r12', retainDisplayedOverlay: true, renderWidth: 600 };
    const { container, rerender } = render(createElement(BoardImageNative, props));
    act(() => {
      for (const event of imageEvents.displays) event.display?.();
    });
    renderResult.current = { overlayUri: null, rendererUnavailable: false };
    rerender(createElement(BoardImageNative, { ...props, renderWidth: 700 }));
    expect(overlaySources(container)).toContain('file:///overlay-old-width.png');
    renderResult.current = { overlayUri: 'file:///overlay-new-width.png', rendererUnavailable: false };
    // A real renderer completion updates the hook's state; a changed style
    // prop asks this memoized component to read the test renderer's new result.
    rerender(createElement(BoardImageNative, { ...props, renderWidth: 700, style: {} }));
    expect(overlaySources(container)).toContain('file:///overlay-old-width.png');
    act(() =>
      imageEvents.displays
        .filter((event) => event.uri === 'file:///overlay-new-width.png')
        .at(-1)
        ?.display?.(),
    );
    expect(overlaySources(container)).toEqual(['file:///overlay-new-width.png']);
    renderResult.current = { overlayUri: null, rendererUnavailable: false };
    rerender(createElement(BoardImageNative, { ...props, frames: 'p2r13', renderWidth: 700 }));
    expect(overlaySources(container)).toEqual([]);
  });

  it('does not report ordinary unchanged board art again when mirroring its retained native images', () => {
    imageEvents.displays.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-normal.png', rendererUnavailable: false };
    const displayed = vi.fn();
    const props = { ...BOARD, frames: 'p1r12', onReadyArtDisplayed: displayed };
    const { rerender } = render(createElement(BoardImageNative, { ...props, mirrored: false }));
    act(() => {
      for (const event of imageEvents.displays) event.display?.();
    });
    expect(displayed).toHaveBeenCalledTimes(1);
    rerender(createElement(BoardImageNative, { ...props, mirrored: true }));
    act(() => {
      for (const event of imageEvents.displays) event.display?.();
    });
    expect(displayed).toHaveBeenCalledTimes(1);
    rerender(createElement(BoardImageNative, { ...props, mirrored: false }));
    expect(displayed).toHaveBeenCalledTimes(1);
  });
  it('withholds the exact capture marker from opacity-zero replacement art until the actual visible handoff', () => {
    imageEvents.displays.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-full.png', rendererUnavailable: false };
    const cached = cacheRenderedOverlay('opening-marker-test', 'file:///overlay-opening.png');
    const opening = captureReadyBoardArt({
      ...BOARD,
      frames: 'p1r12',
      renderSignature: 'classic',
      colorScheme: 'dark',
      climbUuid: 'real-climb',
      mirrored: false,
      quality: 'thumbnail',
      overlayCacheKey: 'opening-marker-test',
      overlayUri: cached.uri,
      overlayGeneration: cached.generation,
      overlayLoadKey: `${cached.generation}:0`,
      backgroundPaths: ['/bundled/kilter.webp'],
    });
    const marker = 'cpp-climb-painted-owned-real-climb';
    const readiness = vi.fn();
    const { container, queryByTestId } = render(
      createElement(BoardImageNative, {
        ...BOARD,
        frames: 'p1r12',
        readyBoardArt: opening,
        paintedTestID: marker,
        onArtReadinessChange: readiness,
      }),
    );
    expect(container.querySelector('[data-opacity="0"]')).not.toBeNull();
    expect(queryByTestId(marker)).toBeNull();
    expect(readiness).not.toHaveBeenCalledWith('ready');
    act(() =>
      imageEvents.displays
        .filter((event) => event.uri === 'file:///overlay-full.png')
        .at(-1)
        ?.display?.(),
    );
    expect(container.querySelector('[data-opacity="0"]')).not.toBeNull();
    expect(queryByTestId(marker)).toBeNull();
    expect(readiness).not.toHaveBeenCalledWith('ready');
    act(() =>
      imageEvents.displays
        .filter((event) => event.uri === 'file:///bundled/kilter.webp')
        .at(-1)
        ?.display?.(),
    );
    expect(container.querySelector('[data-opacity="0"]')).toBeNull();
    expect(queryByTestId(marker)).not.toBeNull();
    expect(readiness).toHaveBeenLastCalledWith('ready');
  });
  it('drops the retained frame when the frames go empty, because no replacement is coming', () => {
    imageEvents.loadCallbacks.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-a.png', rendererUnavailable: false };
    const { container, rerender } = render(
      createElement(BoardImageNative, { ...BOARD, frames: 'p1r12', retainPreviousOverlay: true }),
    );
    act(() => {
      imageEvents.loadCallbacks.forEach((onLoad) => onLoad());
    });
    expect(overlaySources(container)).toContain('file:///overlay-a.png');

    // The climber clears every hold. `useNativeClimbRender` skips empty frames,
    // so nothing will ever replace the painted overlay — a bridge here would
    // leave the cleared holds on the board for good.
    renderResult.current = { overlayUri: null, rendererUnavailable: false };
    rerender(createElement(BoardImageNative, { ...BOARD, frames: '', retainPreviousOverlay: true }));

    expect(overlaySources(container)).toEqual([]);
  });

  it('still bridges while a replacement render is genuinely in flight', () => {
    imageEvents.loadCallbacks.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-a.png', rendererUnavailable: false };
    const { container, rerender } = render(
      createElement(BoardImageNative, { ...BOARD, frames: 'p1r12', retainPreviousOverlay: true }),
    );
    act(() => {
      imageEvents.loadCallbacks.forEach((onLoad) => onLoad());
    });

    // One more hold painted: the cache key moved, so `overlayUri` nulls while
    // the next PNG renders. The last painted frame carries the gap.
    renderResult.current = { overlayUri: null, rendererUnavailable: false };
    rerender(createElement(BoardImageNative, { ...BOARD, frames: 'p1r12p2r13', retainPreviousOverlay: true }));

    expect(overlaySources(container)).toEqual(['file:///overlay-a.png']);
  });

  it('draws the under-overlay slot beneath the holds, and the fallback above it', () => {
    imageEvents.loadCallbacks.length = 0;
    renderResult.current = { overlayUri: 'file:///overlay-a.png', rendererUnavailable: false };
    const { container } = render(
      createElement(BoardImageNative, {
        ...BOARD,
        frames: 'p1r12',
        underOverlay: createElement('div', { 'data-testid': 'under-overlay' }),
      }),
    );

    const nodes = Array.from(container.querySelectorAll('[data-testid="under-overlay"], img'));
    const underOverlayIndex = nodes.findIndex((node) => node.getAttribute('data-testid') === 'under-overlay');
    const overlayIndex = nodes.findIndex((node) => node.getAttribute('src') === 'file:///overlay-a.png');
    expect(underOverlayIndex).toBeGreaterThanOrEqual(0);
    expect(overlayIndex).toBeGreaterThan(underOverlayIndex);
  });
});
