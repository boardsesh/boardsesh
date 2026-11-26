// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderState = vi.hoisted(() => ({
  holdsDataLengths: [] as number[],
  images: [] as Array<{ onDisplay: () => void; onError: (error: { error: string }) => void }>,
}));

vi.mock('expo-image', () => ({
  Image: ({ testID, ...events }: (typeof renderState.images)[number] & { testID: string }) => {
    renderState.images.push(events);
    return createElement('img', { 'data-testid': testID });
  },
}));

vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
  it('keeps the cached neutral path visible until the bundled artwork paints', () => {
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

    expect(view.getByTestId('quantum-neutral-grid')).toBeTruthy();
    expect(view.container.querySelector('svg')?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    const neutralHolds = view.getByTestId('quantum-neutral-holds');
    const compoundPath = neutralHolds.getAttribute('d') ?? '';
    expect(compoundPath.match(/M/g)).toHaveLength(657);
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
    expect(view.getByTestId('quantum-neutral-holds')).toBeTruthy();
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
