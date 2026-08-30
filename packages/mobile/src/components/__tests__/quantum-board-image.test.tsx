// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderState = vi.hoisted(() => ({ holdsDataLengths: [] as number[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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

import {
  getQuantumGeometryBoardDetails,
  registerQuantumGeometry,
  unregisterQuantumGeometry,
} from '../../lib/quantum-geometry-store';
import { QuantumBoardImage } from '../quantum/QuantumBoardImage';
import { getQuantumRenderPathData } from '../quantum/quantum-board-paths';

const LAYOUT_ID = 9101;
const SIZE_ID = 9201;

function xlGeometry() {
  return {
    layoutId: LAYOUT_ID,
    sizeId: SIZE_ID,
    revision: 'catalogue-rev-1',
    edgeLeft: 0,
    edgeRight: 14_000,
    edgeBottom: 0,
    edgeTop: 14_000,
    placements: Array.from({ length: 225 }, (_, placementIndex) => ({
      placementId: placementIndex + 1,
      holeId: placementIndex + 1,
      x: (placementIndex % 15) * 1_000,
      y: Math.floor(placementIndex / 15) * 1_000,
      ledPosition: placementIndex,
    })),
  };
}

beforeEach(() => {
  renderState.holdsDataLengths = [];
  unregisterQuantumGeometry(LAYOUT_ID, SIZE_ID);
});

afterEach(() => {
  cleanup();
  unregisterQuantumGeometry(LAYOUT_ID, SIZE_ID);
});

describe('QuantumBoardImage neutral rendering', () => {
  it('starts on a neutral grid, then reacts to geometry hydration with one cached compound hold path', () => {
    const view = render(
      createElement(QuantumBoardImage, {
        frames: 'p1r12',
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
      }),
    );

    expect(view.getByTestId('quantum-neutral-grid')).toBeTruthy();
    expect(view.queryByTestId('quantum-neutral-holds')).toBeNull();
    expect(view.container.querySelector('svg')?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(renderState.holdsDataLengths.at(-1)).toBe(0);

    act(() => {
      expect(registerQuantumGeometry(xlGeometry())).toBe(true);
    });

    const neutralHolds = view.getByTestId('quantum-neutral-holds');
    const compoundPath = neutralHolds.getAttribute('d') ?? '';
    expect(compoundPath.match(/M/g)).toHaveLength(225);
    expect(view.container.querySelectorAll('circle')).toHaveLength(0);
    expect(renderState.holdsDataLengths.at(-1)).toBe(225);

    const boardDetails = getQuantumGeometryBoardDetails(LAYOUT_ID, SIZE_ID);
    expect(boardDetails).not.toBeNull();
    if (!boardDetails) throw new Error('Expected hydrated Quantum geometry');
    expect(getQuantumRenderPathData(boardDetails)).toBe(getQuantumRenderPathData(boardDetails));
  });
});
