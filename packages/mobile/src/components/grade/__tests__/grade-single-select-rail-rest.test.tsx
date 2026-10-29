// @vitest-environment jsdom
//
// Where the tick sheets' grade rail comes to rest on open (#7062). On iPad the
// sheet's content is laid out at the window width before the sheet is
// presented, then again at the sheet's own width. A rail that rested once on the
// first pass opened on V0 with the consensus grade off screen. These specs drive
// the measurement passes native would run and read the rest position off the
// ScrollView's `scrollTo`.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, useImperativeHandle, type ReactNode, type Ref } from 'react';
import type { Grade } from '@boardsesh/shared-schema';

type Layout = { x: number; y: number; width: number; height: number };
type LayoutEvent = { nativeEvent: { layout: Layout } };

const strip = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  scrollProps: null as {
    onLayout?: (event: LayoutEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScrollBeginDrag?: () => void;
  } | null,
  chipLayout: new Map<string, (event: LayoutEvent) => void>(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: (props: {
    ref?: Ref<{ scrollTo: (target: { x: number; animated: boolean }) => void }>;
    children?: ReactNode;
    onLayout?: (event: LayoutEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScrollBeginDrag?: () => void;
  }) => {
    useImperativeHandle(props.ref, () => ({ scrollTo: strip.scrollTo }), []);
    strip.scrollProps = props;
    return createElement('div', { 'data-scroll': 'true' }, props.children);
  },
}));

vi.mock('../GradeChip', () => ({
  GRADE_CHIP_HEIGHT: 44,
  GradeChip: ({
    label,
    onPress,
    onLayout,
  }: {
    label: string;
    onPress: () => void;
    onLayout?: (event: LayoutEvent) => void;
  }) => {
    if (onLayout) strip.chipLayout.set(label, onLayout);
    return createElement('button', { onClick: onPress, 'data-label': label }, label);
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666' } }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: (name: string | null | undefined) => name ?? null,
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { GradeSingleSelectRail } from '../GradeRail';

// Twelve chips, V0 to V11, one per difficulty id from 10.
const GRADES = Array.from({ length: 12 }, (_, index) => ({
  difficultyId: 10 + index,
  name: `V${index}`,
})) as unknown as Grade[];
const CONSENSUS_ID = 18; // V8, the ninth chip
const CHIP_WIDTH = 52;
const CHIP_PITCH = 60;
const TRAIL_INSET = 24;
const CONTENT_WIDTH = GRADES.length * CHIP_PITCH - (CHIP_PITCH - CHIP_WIDTH) + TRAIL_INSET;
// The iPad pass before the sheet is presented: the window is wider than the
// whole strip, so nothing overflows and the only rest is 0.
const WINDOW_WIDE_RAIL = 1100;
// The sheet's own width once presented.
const SHEET_RAIL = 300;
// V8 starts at 480; centring it in 300pt wants 356, which snaps DOWN to the
// chip start at 300 so the rail never rests mid-chip.
const CONSENSUS_REST = 300;

function renderRail() {
  return render(
    <GradeSingleSelectRail
      grades={GRADES}
      selectedDifficultyId={null}
      consensusDifficultyId={CONSENSUS_ID}
      onSelect={vi.fn()}
      colorway="selection"
      contentInsetLeft={0}
      contentInsetRight={TRAIL_INSET}
    />,
  );
}

function layoutChips() {
  act(() => {
    GRADES.forEach((grade, index) => {
      strip.chipLayout.get(grade.name)?.({
        nativeEvent: { layout: { x: index * CHIP_PITCH, y: 0, width: CHIP_WIDTH, height: 44 } },
      });
    });
  });
}

function layoutRail(width: number) {
  act(() => {
    strip.scrollProps?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 60 } } });
  });
}

function sizeContent(width: number) {
  act(() => {
    strip.scrollProps?.onContentSizeChange?.(width, 60);
  });
}

describe('GradeSingleSelectRail rest position', () => {
  beforeEach(() => {
    strip.scrollTo.mockClear();
    strip.scrollProps = null;
    strip.chipLayout.clear();
  });

  it('rests on the consensus grade once measured', () => {
    renderRail();
    layoutChips();
    layoutRail(SHEET_RAIL);
    sizeContent(CONTENT_WIDTH);

    expect(strip.scrollTo).toHaveBeenLastCalledWith({ x: CONSENSUS_REST, animated: false });
  });

  it('rests again when the iPad sheet narrows the rail after a window-wide first pass (#7062)', () => {
    renderRail();
    layoutChips();
    layoutRail(WINDOW_WIDE_RAIL);
    sizeContent(CONTENT_WIDTH);
    expect(strip.scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });

    layoutRail(SHEET_RAIL);

    expect(strip.scrollTo).toHaveBeenLastCalledWith({ x: CONSENSUS_REST, animated: false });
  });

  it('does not rest at 0 before the content has been measured', () => {
    renderRail();
    layoutChips();
    layoutRail(SHEET_RAIL);

    expect(strip.scrollTo).not.toHaveBeenCalled();

    sizeContent(CONTENT_WIDTH);

    expect(strip.scrollTo).toHaveBeenCalledTimes(1);
    expect(strip.scrollTo).toHaveBeenLastCalledWith({ x: CONSENSUS_REST, animated: false });
  });

  it('does not scroll again for a repeated layout of the same geometry', () => {
    renderRail();
    layoutChips();
    layoutRail(SHEET_RAIL);
    sizeContent(CONTENT_WIDTH);
    strip.scrollTo.mockClear();

    layoutRail(SHEET_RAIL);
    sizeContent(CONTENT_WIDTH);

    expect(strip.scrollTo).not.toHaveBeenCalled();
  });

  it('never moves after the climber has dragged it, even when the width changes', () => {
    renderRail();
    layoutChips();
    layoutRail(WINDOW_WIDE_RAIL);
    sizeContent(CONTENT_WIDTH);
    act(() => strip.scrollProps?.onScrollBeginDrag?.());
    strip.scrollTo.mockClear();

    layoutRail(SHEET_RAIL);

    expect(strip.scrollTo).not.toHaveBeenCalled();
  });

  it('never moves after the climber has tapped a chip, even when the width changes', () => {
    const { getByText } = renderRail();
    layoutChips();
    layoutRail(WINDOW_WIDE_RAIL);
    sizeContent(CONTENT_WIDTH);
    fireEvent.click(getByText('V2'));
    strip.scrollTo.mockClear();

    layoutRail(SHEET_RAIL);

    expect(strip.scrollTo).not.toHaveBeenCalled();
  });
});
