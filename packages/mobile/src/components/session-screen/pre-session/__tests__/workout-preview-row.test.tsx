// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { QueueItemRowBoard } from '../../../QueueItemRow';

// Each PressableSurface render lands here so the test can read the refresh
// button's disabled/accessibility state.
const surfaces = vi.hoisted(() => ({
  entries: [] as Array<{
    label?: string;
    disabled?: boolean;
    accessibilityState?: Record<string, unknown>;
    rippleBorderless?: boolean;
    style?: unknown;
  }>,
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    accessible,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) =>
    createElement(
      'div',
      accessible ? { 'aria-label': accessibilityLabel, 'data-role': accessibilityRole ?? 'none' } : null,
      children,
    ),
  ActivityIndicator: () => createElement('span', { 'data-testid': 'refresh-spinner' }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    accessibilityLabel,
    disabled,
    accessibilityState,
    rippleBorderless,
    style,
    children,
  }: {
    accessibilityLabel?: string;
    disabled?: boolean;
    accessibilityState?: Record<string, unknown>;
    rippleBorderless?: boolean;
    style?: unknown;
    children?: ReactNode;
  }) => {
    surfaces.entries.push({ label: accessibilityLabel, disabled, accessibilityState, rippleBorderless, style });
    return createElement('button', null, children);
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; formattedCount?: string; grade?: string; plannedGrade?: string }) => {
      if (key === 'mobile.climbRow.frameCount') return `${options?.count} frames`;
      if (key === 'mobile.session.preWorkoutPreviewBorrowedGrade')
        return `${options?.grade} for ${options?.plannedGrade}`;
      if (key === 'sends') return `${options?.formattedCount ?? options?.count} sends`;
      if (key === 'playView.tickBar.starRating') return `${options?.count} stars`;
      return key;
    },
  }),
}));
vi.mock('../../../ClimbListItemContent', () => ({ ClimbListItemContent: () => null }));
vi.mock('../../../ClimbListThumbnail', () => ({ THUMBNAIL_WIDTH: 64 }));
vi.mock('../../../Icon', () => ({ Icon: () => createElement('span', { 'data-testid': 'refresh-icon' }) }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
// The caption formats its two grade ids with the real shared scale (18 is
// 6b/V4, 20 is 6c/V5) under the climber's format, mocked here as V.
const gradeFormatPreference = vi.hoisted(() => ({ gradeFormat: 'v-grade' as 'v-grade' | 'font' | 'both' }));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: gradeFormatPreference.gradeFormat,
    formatGrade: () => 'V4',
  }),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#000' }, opacity: { disabled: 0.5 } }),
}));
vi.mock('../../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { WorkoutPreviewRow } from '../WorkoutPreviewRow';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../../../lib/climb-row-display-preference';

const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as QueueItemRowBoard;
const item = {
  uuid: 'qi-1',
  climb: {
    uuid: 'c1',
    name: 'Test Climb',
    difficulty: '12',
    ascensionist_count: 12,
    quality_average: '4.2',
    setter_username: 'setter',
  },
} as unknown as ClimbQueueItem;

// The mocked `t` returns the key, so the refresh button surfaces under its key.
const REFRESH_LABEL = 'mobile.session.preRegenerateClimbForClimb';
const refreshButton = () => surfaces.entries.find((entry) => entry.label === REFRESH_LABEL);
const rowButton = () => surfaces.entries.find((entry) => entry.label?.startsWith(item.climb.name));
const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
  }
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
};

function renderRow(overrides: {
  isRefreshing: boolean;
  refreshDisabled: boolean;
  item?: ClimbQueueItem;
  onPress?: (item: ClimbQueueItem) => void;
  borrowedGrade?: number | null;
  plannedGrade?: number | null;
}) {
  return render(
    createElement(WorkoutPreviewRow, {
      item: overrides.item ?? item,
      board,
      isActive: false,
      onPress: vi.fn(),
      onRefresh: vi.fn(),
      ...overrides,
    }),
  );
}

beforeEach(() => {
  surfaces.entries = [];
  gradeFormatPreference.gradeFormat = 'v-grade';
  resetClimbRowDisplayForTests();
});

describe('WorkoutPreviewRow refresh button', () => {
  it('lays out the climb content horizontally', () => {
    renderRow({ isRefreshing: false, refreshDisabled: false });
    expect(flattenStyle(rowButton()?.style)).toMatchObject({ flexDirection: 'row', alignItems: 'center' });
  });

  it('announces the visible climb details on the row action', () => {
    renderRow({ isRefreshing: false, refreshDisabled: false });
    expect(rowButton()?.label).toBe('Test Climb, V4, 12 sends, 4 stars, setter');
  });

  // The label replaces what a screen reader would compose from the row, so a
  // token the climber switched off the row must not be spoken either.
  it.each([
    { hidden: 'sends', label: 'Test Climb, V4, 4 stars, setter' },
    { hidden: 'rating', label: 'Test Climb, V4, 12 sends, setter' },
    { hidden: 'setter', label: 'Test Climb, V4, 12 sends, 4 stars' },
  ] as const)('leaves $hidden out of the announcement once the climber hides it from the row', ({ hidden, label }) => {
    setClimbRowField(hidden, false);

    renderRow({ isRefreshing: false, refreshDisabled: false });

    expect(rowButton()?.label).toBe(label);
  });

  it('announces the name and the grade alone with sends, rating and setter all hidden', () => {
    for (const fieldId of ['sends', 'rating', 'setter'] as const) setClimbRowField(fieldId, false);

    renderRow({ isRefreshing: false, refreshDisabled: false });

    expect(rowButton()?.label).toBe('Test Climb, V4');
  });

  it('announces everything still with the switches that hide nothing it speaks', () => {
    for (const fieldId of ['thumbnail', 'communityGrade', 'sentMark', 'quickActions'] as const) {
      setClimbRowField(fieldId, false);
    }

    renderRow({ isRefreshing: false, refreshDisabled: false });

    expect(rowButton()?.label).toBe('Test Climb, V4, 12 sends, 4 stars, setter');
  });

  it('updates the row label when a route frame count arrives for the same climb', () => {
    const onPress = vi.fn();
    const onRefresh = vi.fn();
    const props = { board, isActive: false, isRefreshing: false, refreshDisabled: false, onPress, onRefresh };
    const { rerender } = render(createElement(WorkoutPreviewRow, { ...props, item }));
    expect(rowButton()?.label).not.toContain('frames');
    surfaces.entries = [];
    rerender(
      createElement(WorkoutPreviewRow, { ...props, item: { ...item, climb: { ...item.climb, framesCount: 4 } } }),
    );
    expect(rowButton()?.label).toBe('Test Climb, V4, 4 frames, 12 sends, 4 stars, setter');
  });

  it('falls back safely when the climb payload is missing', () => {
    const missingClimbItem = { uuid: 'qi-missing' } as unknown as ClimbQueueItem;
    renderRow({ item: missingClimbItem, isRefreshing: false, refreshDisabled: false });
    expect(surfaces.entries[0]?.label).toBe('mobile.queue.unknownClimb');
  });

  it('is tappable when no row is regenerating', () => {
    renderRow({ isRefreshing: false, refreshDisabled: false });
    expect(refreshButton()?.disabled).toBe(false);
    expect(refreshButton()?.accessibilityState).toMatchObject({ disabled: false, busy: false });
    expect(refreshButton()?.rippleBorderless).toBe(true);
  });

  it('is disabled (and busy=false) while a different row regenerates', () => {
    const { getByTestId } = renderRow({ isRefreshing: false, refreshDisabled: true });
    expect(refreshButton()?.disabled).toBe(true);
    expect(refreshButton()?.accessibilityState).toMatchObject({ disabled: true, busy: false });
    // The dimmed, non-spinning state — the climb's own refresh icon stays put.
    expect(getByTestId('refresh-icon')).toBeTruthy();
  });

  it('shows a spinner and reports busy while this row regenerates', () => {
    const { getByTestId } = renderRow({ isRefreshing: true, refreshDisabled: false });
    expect(getByTestId('refresh-spinner')).toBeTruthy();
    expect(refreshButton()?.disabled).toBe(true);
    expect(refreshButton()?.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });

  // The add-block sheet leaves onPress out: a tap would open the player under it.
  it('is plain content, not a button, without onPress, and keeps its label and refresh', () => {
    const { getByLabelText } = renderRow({ isRefreshing: false, refreshDisabled: false, onPress: undefined });

    expect(rowButton()).toBeUndefined();
    expect(surfaces.entries.map((entry) => entry.label)).toEqual([REFRESH_LABEL]);
    expect(refreshButton()?.disabled).toBe(false);
    const climbArea = getByLabelText('Test Climb, V4, 12 sends, 4 stars, setter');
    expect(climbArea.getAttribute('data-role')).toBe('none');
  });
});

describe('WorkoutPreviewRow borrowed from a nearby grade', () => {
  it('says which grade the climb fills in for, and speaks it', () => {
    const { getByText } = renderRow({
      isRefreshing: false,
      refreshDisabled: false,
      borrowedGrade: 18,
      plannedGrade: 20,
    });

    getByText('V4 for V5');
    expect(rowButton()?.label).toBe('Test Climb, V4, V4 for V5, 12 sends, 4 stars, setter');
  });

  // 4b borrowed for 4a: both are V0, so "V0 for V0" would say nothing.
  it('adds the Font grade when both grades read the same V grade, and speaks it', () => {
    const { getByText } = renderRow({
      isRefreshing: false,
      refreshDisabled: false,
      borrowedGrade: 11,
      plannedGrade: 10,
    });

    getByText('V0 / 4B for V0 / 4A');
    expect(rowButton()?.label).toBe('Test Climb, V4, V0 / 4B for V0 / 4A, 12 sends, 4 stars, setter');
  });

  it('keeps the climber’s Font format when it already tells the grades apart', () => {
    gradeFormatPreference.gradeFormat = 'font';

    const { getByText } = renderRow({
      isRefreshing: false,
      refreshDisabled: false,
      borrowedGrade: 11,
      plannedGrade: 10,
    });

    getByText('4B for 4A');
  });

  it('shows no caption on a row at its planned grade', () => {
    const { queryByText } = renderRow({ isRefreshing: false, refreshDisabled: false });

    expect(queryByText(/ for /)).toBeNull();
    expect(rowButton()?.label).toBe('Test Climb, V4, 12 sends, 4 stars, setter');
  });

  it('shows no caption when either grade is off the board scale', () => {
    const { queryByText } = renderRow({
      isRefreshing: false,
      refreshDisabled: false,
      borrowedGrade: 99,
      plannedGrade: 20,
    });

    expect(queryByText(/ for /)).toBeNull();
  });

  it('re-renders when a refresh moves the row back to its planned grade', () => {
    const props = { board, isActive: false, isRefreshing: false, refreshDisabled: false, onRefresh: vi.fn() };
    const { getByText, queryByText, rerender } = render(
      createElement(WorkoutPreviewRow, { ...props, item, borrowedGrade: 18, plannedGrade: 20 }),
    );
    getByText('V4 for V5');

    rerender(createElement(WorkoutPreviewRow, { ...props, item, borrowedGrade: null, plannedGrade: null }));

    expect(queryByText('V4 for V5')).toBeNull();
  });
});
