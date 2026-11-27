// @vitest-environment jsdom
import { createElement, type CSSProperties, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderState = vi.hoisted(() => ({
  holdsDataLengths: [] as number[],
  images: [] as Array<{ onDisplay: () => void; onError: (error: { error: string }) => void }>,
}));

vi.mock('expo-image', () => ({
  Image: ({
    testID,
    loading,
    ...events
  }: (typeof renderState.images)[number] & {
    testID: string;
    loading: 'eager' | 'lazy';
  }) => {
    renderState.images.push(events);
    return createElement('img', { 'data-testid': testID, loading });
  },
}));

vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: CSSProperties | CSSProperties[] }) =>
    createElement('div', { style: Array.isArray(style) ? Object.assign({}, ...style) : style }, children),
  StyleSheet: {
    absoluteFill: { position: 'absolute', inset: 0 },
    create: (styles: Record<string, unknown>) => styles,
  },
}));

type SvgMockProps = {
  children?: ReactNode;
  d?: string;
  preserveAspectRatio?: string;
  testID?: string;
  viewBox?: string;
};

vi.mock('react-native-svg', () => ({
  default: ({ children, preserveAspectRatio, testID, viewBox }: SvgMockProps) =>
    createElement('svg', { 'data-testid': testID, preserveAspectRatio, viewBox }, children),
  Path: ({ d, testID }: SvgMockProps) => createElement('path', { d, 'data-testid': testID ?? undefined }),
  Rect: () => createElement('rect'),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    chartColors: {
      secondaryBackground: '#eeeeee',
      separator: '#cccccc',
      secondaryLabel: '#777777',
    },
  }),
}));

vi.mock('../board-renderer/BoardHoldOverlay', () => ({
  BoardHoldOverlay: () => createElement('g', { 'data-testid': 'lit-holds' }),
}));

vi.mock('../board-renderer/use-parse-frames', () => ({
  useParseFrames: (_frames: string, _boardName: string, holdsData: unknown[]) => {
    renderState.holdsDataLengths.push(holdsData.length);
    return [];
  },
}));

import { getQuantumGeometryBoardDetails } from '../../lib/quantum-geometry-store';
import { BoardArtVisibilityContext } from '../board-art-visibility-context';
import { QuantumBoardImage } from '../quantum/QuantumBoardImage';
import { getQuantumRenderPathData } from '../quantum/quantum-board-paths';

const LAYOUT_ID = 9101;
const SIZE_ID = 9201;

beforeEach(() => {
  renderState.holdsDataLengths = [];
  renderState.images = [];
});

afterEach(() => {
  cleanup();
});

describe('QuantumBoardImage', () => {
  it('lets bundled artwork paint without an opaque loading diagram', () => {
    const onArtReadinessChange = vi.fn();
    const onArtDisplayed = vi.fn();
    const view = render(
      createElement(QuantumBoardImage, {
        frames: 'p1r12',
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
        onArtReadinessChange,
        onArtDisplayed,
      }),
    );

    expect(view.queryByTestId('quantum-neutral-grid')).toBeNull();
    expect(view.container.querySelector('svg')?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(view.queryByTestId('quantum-neutral-holds')).toBeNull();
    expect(view.getByTestId('quantum-board-artwork').getAttribute('loading')).toBe('eager');
    expect(view.container.querySelectorAll('circle')).toHaveLength(0);
    expect(renderState.holdsDataLengths.at(-1)).toBe(657);

    const boardDetails = getQuantumGeometryBoardDetails(LAYOUT_ID, SIZE_ID);
    expect(boardDetails).not.toBeNull();
    if (!boardDetails) throw new Error('Expected bundled Quantum geometry');
    expect(getQuantumRenderPathData(boardDetails)).toBe(getQuantumRenderPathData(boardDetails));
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('loading');
    expect(onArtDisplayed).not.toHaveBeenCalled();

    act(() => renderState.images.at(-1)?.onDisplay());

    expect(view.getByTestId('quantum-board-artwork')).toBeTruthy();
    expect(view.queryByTestId('quantum-neutral-holds')).toBeNull();
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('ready');
    expect(onArtDisplayed).toHaveBeenCalledOnce();
  });

  it('keeps same-model swipes free of neutral dots while a new canvas waits to display', () => {
    const onArtReadinessChange = vi.fn();
    const onArtDisplayed = vi.fn();
    const board = {
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      onArtReadinessChange,
      onArtDisplayed,
    };
    const previous = render(createElement(QuantumBoardImage, { ...board, frames: 'p1r12' }));
    act(() => renderState.images.at(-1)?.onDisplay());
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('ready');
    previous.unmount();

    const next = render(createElement(QuantumBoardImage, { ...board, frames: 'p2r12' }));
    expect(next.getByTestId('quantum-board-artwork').parentElement?.style.backgroundColor).toBe('transparent');
    expect(next.queryByTestId('quantum-neutral-holds')).toBeNull();
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('loading');
    expect(onArtDisplayed).toHaveBeenCalledOnce();

    act(() => renderState.images.at(-1)?.onDisplay());
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('ready');
    expect(onArtDisplayed).toHaveBeenCalledTimes(2);
  });

  it('keeps thumbnail artwork lazy', () => {
    const view = render(
      createElement(QuantumBoardImage, {
        frames: '',
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
        backgroundVariant: 'thumb',
      }),
    );
    expect(view.getByTestId('quantum-board-artwork').getAttribute('loading')).toBe('lazy');
  });

  it('ignores the recycled model’s display callback and reports a real image failure', () => {
    const onArtReadinessChange = vi.fn();
    const onArtDisplayed = vi.fn();
    const onArtError = vi.fn();
    const props = { frames: '', onArtReadinessChange, onArtDisplayed, onArtError };
    const view = render(createElement(QuantumBoardImage, { ...props, layoutId: LAYOUT_ID, sizeId: SIZE_ID }));
    const previousArtwork = renderState.images.at(-1);
    view.rerender(createElement(QuantumBoardImage, { ...props, layoutId: 9104, sizeId: 9204 }));
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1176 1892');

    act(() => {
      previousArtwork?.onDisplay();
      previousArtwork?.onError({ error: 'A recycled image failed' });
    });
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('loading');
    expect(onArtDisplayed).not.toHaveBeenCalled();
    expect(onArtError).not.toHaveBeenCalled();

    const error = { error: 'Artwork failed to decode' };
    act(() => renderState.images.at(-1)?.onError(error));
    expect(view.getByTestId('quantum-neutral-grid')).toBeTruthy();
    const compoundPath = view.getByTestId('quantum-neutral-holds').getAttribute('d') ?? '';
    expect(compoundPath.match(/M/g)).toHaveLength(252);
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('failed');
    expect(onArtDisplayed).not.toHaveBeenCalled();
    expect(onArtError).toHaveBeenCalledWith(error);
  });

  it('releases hidden artwork and waits for a new paint when visible again', () => {
    const onArtReadinessChange = vi.fn();
    const board = createElement(QuantumBoardImage, {
      frames: '',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      onArtReadinessChange,
    });
    const visibility = (value: boolean) => createElement(BoardArtVisibilityContext.Provider, { value }, board);
    const view = render(visibility(true));
    act(() => renderState.images.at(-1)?.onDisplay());
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('ready');

    view.rerender(visibility(false));
    expect(view.queryByTestId('quantum-board-artwork')).toBeNull();
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('loading');

    view.rerender(visibility(true));
    expect(view.getByTestId('quantum-board-artwork')).toBeTruthy();
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('loading');
    act(() => renderState.images.at(-1)?.onDisplay());
    expect(onArtReadinessChange).toHaveBeenLastCalledWith('ready');
  });
});
