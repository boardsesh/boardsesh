// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; testID?: string; style?: unknown };
const imageEvents = vi.hoisted(() => ({ loadCallbacks: [] as Array<() => void> }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-image', () => ({
  Image: ({ source, onLoad }: { source: { uri: string }; onLoad?: () => void }) => {
    if (onLoad) imageEvents.loadCallbacks.push(onLoad);
    return createElement('img', { src: source.uri, onLoad });
  },
}));

vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

// The renderer is driven by the test: what matters here is which layers
// BoardImageNative asks LayeredClimbImage to draw, not how a PNG is produced.
const renderResult = vi.hoisted(() => ({
  current: { overlayUri: null as string | null, rendererUnavailable: false },
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
  }),
}));

import { BoardImageNative } from '../BoardImageNative';

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
