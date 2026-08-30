// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderState = vi.hoisted(() => ({ holdsDataLengths: [] as number[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
}));

type SvgMockProps = {
  children?: ReactNode;
  d?: string;
  preserveAspectRatio?: string;
  testID?: string;
};

vi.mock('react-native-svg', () => ({
  default: ({ children, preserveAspectRatio, testID }: SvgMockProps) =>
    createElement(
      'svg',
      { 'data-testid': testID ?? undefined, preserveAspectRatio: preserveAspectRatio ?? undefined },
      children,
    ),
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
import { QuantumBoardImage } from '../quantum/QuantumBoardImage';
import { getQuantumRenderPathData } from '../quantum/quantum-board-paths';

const LAYOUT_ID = 9101;
const SIZE_ID = 9201;

beforeEach(() => {
  renderState.holdsDataLengths = [];
});

afterEach(() => {
  cleanup();
});

describe('QuantumBoardImage neutral rendering', () => {
  it('renders the fixed bundle immediately with one cached compound hold path', () => {
    const view = render(
      createElement(QuantumBoardImage, {
        frames: 'p1r12',
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
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
  });
});
