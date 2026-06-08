// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));
const accessibilityInfo = vi.hoisted(() => ({
  screenReaderEnabled: vi.fn(() => Promise.resolve(false)),
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
const theme = vi.hoisted(() => ({ primary: '#6D28D9' }));

type LayoutEvent = { nativeEvent: { layout: { x: number; width: number; height: number; y: number } } };

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isScreenReaderEnabled: accessibilityInfo.screenReaderEnabled,
    addEventListener: accessibilityInfo.addEventListener,
  },
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: LayoutEvent) => void }) =>
    createElement(
      'div',
      {
        onClick: onLayout
          ? () => onLayout({ nativeEvent: { layout: { x: 0, width: 320, height: 44, y: 0 } } })
          : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));

vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => {
      const gesture = {
        activeOffsetY: () => gesture,
        failOffsetX: () => gesture,
        onEnd: () => gesture,
      };
      return gesture;
    },
  },
  GestureDetector: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-gesture': 'true' }, children),
  ScrollView: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: LayoutEvent) => void }) =>
    createElement(
      'div',
      {
        'data-scroll': 'true',
        onClick: onLayout
          ? () => onLayout({ nativeEvent: { layout: { x: 0, width: 320, height: 44, y: 0 } } })
          : undefined,
      },
      children,
    ),
}));

vi.mock('react-native-reanimated', () => ({
  runOnJS:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

vi.mock('../GradeChip', () => ({
  GradeChip: ({
    label,
    gradeColor,
    onPress,
    accessibilityLabel,
    accessibilityState,
    onLayout,
  }: {
    label: string;
    gradeColor?: string;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    onLayout?: (event: LayoutEvent) => void;
  }) =>
    createElement(
      'button',
      {
        onClick: () => {
          onLayout?.({ nativeEvent: { layout: { x: 0, width: 56, height: 44, y: 0 } } });
          onPress();
        },
        'data-label': accessibilityLabel,
        'data-grade-color': gradeColor,
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
      },
      label,
    ),
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-glass': 'true' }, children),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-label': accessibilityLabel ?? '' }, children),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      fill: '#eee',
      secondaryBackground: '#fff',
      secondaryLabel: '#666',
    },
    brandColors: { primary: theme.primary },
  }),
}));

vi.mock('../../../theme/colors', () => ({
  brandColors: { primary: '#6D28D9' },
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));

vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (name: string | null | undefined) => name ?? null }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key.includes('Aria') && options?.grade) return `${key}:${options.grade}`;
      return key;
    },
  }),
}));

import { GradeRangeRail, GradeSingleSelectRail } from '../GradeRail';

const grades: Grade[] = [
  { difficultyId: 10, name: 'V4' },
  { difficultyId: 12, name: 'V5' },
  { difficultyId: 14, name: 'V6' },
] as unknown as Grade[];

function renderRail(bound: GradeBound, onChange = vi.fn()) {
  const onRequestClose = vi.fn();
  const view = render(
    <GradeRangeRail grades={grades} bound={bound} onChange={onChange} onRequestClose={onRequestClose} />,
  );
  return { ...view, onChange, onRequestClose };
}

describe('GradeRangeRail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    haptics.selection.mockClear();
    accessibilityInfo.screenReaderEnabled.mockReset();
    accessibilityInfo.screenReaderEnabled.mockResolvedValue(false);
    accessibilityInfo.addEventListener.mockClear();
    theme.primary = '#6D28D9';
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('switches an existing single grade instead of treating open as a range-start tap', () => {
    const onChange = vi.fn();
    const { getByText } = renderRail({ minGradeId: 12, maxGradeId: 12 }, onChange);
    fireEvent.click(getByText('V6'));
    expect(onChange).toHaveBeenCalledWith({ minGradeId: 14, maxGradeId: 14 });
  });

  it('builds a range from a fresh single grade tap followed by a second tap', () => {
    const onChange = vi.fn();
    const { getByText, rerender } = renderRail({ minGradeId: undefined, maxGradeId: undefined }, onChange);
    fireEvent.click(getByText('V4'));
    expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 10, maxGradeId: 10 });
    rerender(
      <GradeRangeRail
        grades={grades}
        bound={{ minGradeId: 10, maxGradeId: 10 }}
        onChange={onChange}
        onRequestClose={vi.fn()}
      />,
    );
    fireEvent.click(getByText('V6'));
    expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 10, maxGradeId: 14 });
  });

  it('keeps the rail open after a first (single) grade tap', async () => {
    const { getByText, onRequestClose } = renderRail({ minGradeId: undefined, maxGradeId: undefined });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(getByText('V4'));
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('closes after completing a range by tapping a second grade', async () => {
    const onRequestClose = vi.fn();
    const onChange = vi.fn();
    const { getByText, rerender } = render(
      <GradeRangeRail
        grades={grades}
        bound={{ minGradeId: undefined, maxGradeId: undefined }}
        onChange={onChange}
        onRequestClose={onRequestClose}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // First tap: single grade selected, rail stays open
    fireEvent.click(getByText('V4'));
    act(() => vi.advanceTimersByTime(0));
    expect(onRequestClose).not.toHaveBeenCalled();

    // Rerender with the new bound — same onRequestClose ref
    rerender(
      <GradeRangeRail
        grades={grades}
        bound={{ minGradeId: 10, maxGradeId: 10 }}
        onChange={onChange}
        onRequestClose={onRequestClose}
      />,
    );

    // Second tap within window: range formed → close
    fireEvent.click(getByText('V6'));
    act(() => vi.advanceTimersByTime(300));
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('stays open after clearing the active single grade (starting a fresh range)', async () => {
    const onRequestClose = vi.fn();
    const { getByText } = render(
      <GradeRangeRail
        grades={grades}
        bound={{ minGradeId: 12, maxGradeId: 12 }}
        onChange={vi.fn()}
        onRequestClose={onRequestClose}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Tap V5 again (it's already selected) → deselects to "any". The rail must
    // stay open so the user can build a new range from here, not close.
    fireEvent.click(getByText('V5'));
    act(() => vi.advanceTimersByTime(10000));
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('keeps the rail open when trimming an existing range (adjusting endpoints)', async () => {
    const onRequestClose = vi.fn();
    const { getByText } = render(
      <GradeRangeRail
        grades={grades}
        bound={{ minGradeId: 10, maxGradeId: 14 }}
        onChange={vi.fn()}
        onRequestClose={onRequestClose}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Tap V4 (min endpoint of existing range) → trims to V5-V6 — still a range, rail stays open
    fireEvent.click(getByText('V4'));
    act(() => vi.advanceTimersByTime(10000));
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('does not auto-dismiss a single selection while screen reader state is still resolving', () => {
    accessibilityInfo.screenReaderEnabled.mockResolvedValue(true);
    const { getByText, onRequestClose } = renderRail({ minGradeId: undefined, maxGradeId: undefined });
    fireEvent.click(getByText('V4'));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('passes the resolved theme primary to the clear chip', () => {
    theme.primary = '#3366AA';
    const { getByText } = renderRail({ minGradeId: undefined, maxGradeId: undefined });

    expect(getByText('mobile.search.gradeClear').getAttribute('data-grade-color')).toBe('#3366AA');
  });
});

describe('GradeSingleSelectRail', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  it('selects a grade by its difficulty id', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={null} onSelect={onSelect} />,
    );
    fireEvent.click(getByText('V5'));
    expect(onSelect).toHaveBeenCalledWith(12);
  });

  it('clears the active grade when re-tapped (allowClear defaults to true)', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={12} onSelect={onSelect} />,
    );
    fireEvent.click(getByText('V5'));
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('keeps the active grade when re-tapped and allowClear is false (logbook edit)', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={12} onSelect={onSelect} allowClear={false} />,
    );
    fireEvent.click(getByText('V5'));
    // Re-selecting the same grade returns its id, never undefined — there is no
    // "no grade" option when logging an ascent.
    expect(onSelect).toHaveBeenCalledWith(12);
    expect(onSelect).not.toHaveBeenCalledWith(undefined);
  });

  it('marks the consensus grade distinctly from the active selection', () => {
    const { container } = render(
      <GradeSingleSelectRail
        grades={grades}
        selectedDifficultyId={null}
        consensusDifficultyId={14}
        onSelect={vi.fn()}
      />,
    );
    const consensusChip = container.querySelector('[data-label*="consensusGradeAria"]');
    expect(consensusChip).not.toBeNull();
  });

  it('fires selection haptics on tap', () => {
    const { getByText } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={null} onSelect={vi.fn()} />,
    );
    fireEvent.click(getByText('V4'));
    expect(haptics.selection).toHaveBeenCalled();
  });
});
