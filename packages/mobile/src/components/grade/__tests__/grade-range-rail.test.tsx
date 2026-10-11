// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

type LayoutEvent = { nativeEvent: { layout: { x: number; width: number; height: number; y: number } } };

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-gesture-handler', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    ScrollView: ({
      children,
      nestedScrollEnabled,
      contentContainerStyle,
    }: {
      children?: ReactNode;
      nestedScrollEnabled?: boolean;
      contentContainerStyle?: unknown;
    }) =>
      createElement(
        'div',
        {
          'data-scroll': 'true',
          'data-nested-scroll': nestedScrollEnabled ? 'true' : 'false',
          'data-padding-start': String(flattenStyle(contentContainerStyle).paddingStart),
        },
        children,
      ),
  };
});

vi.mock('../GradeChip', () => ({
  GradeChip: ({
    label,
    tone = 'neutral',
    colorway = 'grade',
    gradeColor,
    onPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
    onLayout,
  }: {
    label: string;
    tone?: string;
    colorway?: string;
    gradeColor?: string;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityHint?: string;
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
        'data-chip': 'true',
        'data-label': accessibilityLabel,
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
        'data-tone': tone,
        'data-colorway': colorway,
        'data-hint': accessibilityHint ?? '',
        'data-grade-color': gradeColor ?? '',
      },
      label,
    ),
}));

// The rail's only pressable of its own is the Range toggle.
vi.mock('../../PressableSurface', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    PressableSurface: ({
      children,
      onPress,
      accessibilityRole,
      accessibilityLabel,
      accessibilityHint,
      accessibilityState,
      style,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityRole?: string;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityState?: { checked?: boolean };
      style?: unknown;
    }) => {
      const flatStyle = flattenStyle(style);
      return createElement(
        'button',
        {
          onClick: onPress,
          'data-pressable': accessibilityLabel ?? '',
          'data-role': accessibilityRole ?? '',
          'data-hint': accessibilityHint ?? '',
          'data-checked': String(accessibilityState?.checked),
          'data-background': String(flatStyle.backgroundColor),
          'data-margin-end': String(flatStyle.marginEnd),
        },
        children,
      );
    },
  };
});

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-icon-color': color ?? '' }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#A78BFA', primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
    systemColors: {
      fill: '#eee',
      label: '#111',
      secondaryLabel: '#666',
      separator: '#ccc',
    },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { full: 9999 },
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v-grade', formatGrade: (name: string | null | undefined) => name ?? null }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key.includes('Aria') && typeof options?.grade === 'string') return `${key}:${options.grade}`;
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

const ANY: GradeBound = { minGradeId: undefined, maxGradeId: undefined };
const RANGE_HINT = 'mobile.gradeRail.rangeHint';

function renderRail(bound: GradeBound, onChange = vi.fn()) {
  const view = render(<GradeRangeRail grades={grades} bound={bound} onChange={onChange} />);
  const showBound = (next: GradeBound) =>
    view.rerender(<GradeRangeRail grades={grades} bound={next} onChange={onChange} />);
  return { ...view, onChange, showBound };
}

function rangeToggle(container: HTMLElement): HTMLElement {
  const toggle = container.querySelector<HTMLElement>('[data-pressable="mobile.gradeRail.rangeToggle"]');
  if (!toggle) throw new Error('Range toggle not rendered');
  return toggle;
}

/** Each chip's label mapped to one of the attributes the GradeChip mock exposes. */
function chipAttribute(container: HTMLElement, attribute: string): Record<string, string | null> {
  return Object.fromEntries(
    [...container.querySelectorAll('[data-chip]')].map((chip) => [
      chip.textContent ?? '',
      chip.getAttribute(attribute),
    ]),
  );
}

/** Each chip's label mapped to the accessibility hint it carries ('' for none). */
const chipHints = (container: HTMLElement) => chipAttribute(container, 'data-hint');

/** Each chip's label mapped to the tone it was painted in. */
const chipTones = (container: HTMLElement) => chipAttribute(container, 'data-tone');

describe('GradeRangeRail', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  describe('with Range off', () => {
    it('switches to the tapped grade instead of building a range', () => {
      const { getByText, onChange } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      fireEvent.click(getByText('V6'));
      // The bound and nothing else: no tap metadata rides along any more.
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 14, maxGradeId: 14 }]]);
    });

    it('clears the filter when the selected grade is tapped again', () => {
      const { getByText, onChange } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      fireEvent.click(getByText('V5'));
      expect(onChange.mock.calls).toEqual([[ANY]]);
    });

    it('clears the filter from the Any chip', () => {
      const { getByText, onChange } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      fireEvent.click(getByText('mobile.search.gradeClear'));
      expect(onChange.mock.calls).toEqual([[ANY]]);
    });

    it('never builds a range however quickly the second tap follows', () => {
      const { getByText, onChange, showBound } = renderRail(ANY);
      fireEvent.click(getByText('V4'));
      showBound({ minGradeId: 10, maxGradeId: 10 });
      fireEvent.click(getByText('V6'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 14, maxGradeId: 14 });
    });
  });

  describe('Range toggle', () => {
    it('is a toggle button that announces off, with its label and hint', () => {
      const { container } = renderRail(ANY);
      const toggle = rangeToggle(container);
      expect(toggle.getAttribute('data-role')).toBe('togglebutton');
      expect(toggle.getAttribute('data-checked')).toBe('false');
      expect(toggle.getAttribute('data-hint')).toBe('mobile.gradeRail.rangeToggleHint');
      expect(toggle.querySelector('[data-icon="range"]')).not.toBeNull();
    });

    it('paints off as a neutral fill and on as the brand fill with its on-fill glyph', () => {
      const { container } = renderRail(ANY);
      expect(rangeToggle(container).getAttribute('data-background')).toBe('#eee');
      expect(rangeToggle(container).querySelector('[data-icon]')?.getAttribute('data-icon-color')).toBe('#111');

      fireEvent.click(rangeToggle(container));
      expect(rangeToggle(container).getAttribute('data-checked')).toBe('true');
      expect(rangeToggle(container).getAttribute('data-background')).toBe('#7C3AED');
      expect(rangeToggle(container).querySelector('[data-icon]')?.getAttribute('data-icon-color')).toBe('#FFFFFF');
    });

    it('builds a range from two taps once it is on', () => {
      const { container, getByText, onChange, showBound } = renderRail(ANY);
      fireEvent.click(rangeToggle(container));
      // Turning Range on changes no filter by itself.
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.click(getByText('V6'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 14, maxGradeId: 14 });
      showBound({ minGradeId: 14, maxGradeId: 14 });

      // The second end can sit below the first: the range comes out ascending.
      fireEvent.click(getByText('V4'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 10, maxGradeId: 14 });
    });

    it('makes an already selected grade the first end when it turns on', () => {
      const { container, getByText, onChange } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      fireEvent.click(rangeToggle(container));
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.click(getByText('V6'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 12, maxGradeId: 14 }]]);
    });

    it('starts a new range from the tapped grade when a range is already set', () => {
      const { getByText, onChange } = renderRail({ minGradeId: 10, maxGradeId: 14 });
      fireEvent.click(getByText('V5'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 12, maxGradeId: 12 }]]);
    });

    it('shows on when the rail mounts on a range', () => {
      const { container } = renderRail({ minGradeId: 10, maxGradeId: 14 });
      expect(rangeToggle(container).getAttribute('data-checked')).toBe('true');
    });

    it('collapses a range to its lower end when it turns off', () => {
      const { container, onChange, showBound } = renderRail({ minGradeId: 10, maxGradeId: 14 });
      fireEvent.click(rangeToggle(container));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 10, maxGradeId: 10 }]]);

      showBound({ minGradeId: 10, maxGradeId: 10 });
      expect(rangeToggle(container).getAttribute('data-checked')).toBe('false');
    });

    it('leaves a single grade alone when it turns off', () => {
      const { container, onChange } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      fireEvent.click(rangeToggle(container));
      fireEvent.click(rangeToggle(container));
      expect(rangeToggle(container).getAttribute('data-checked')).toBe('false');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('stays on through clearing, so the next two taps build a range', () => {
      const { container, getByText, onChange, showBound } = renderRail({ minGradeId: 10, maxGradeId: 14 });
      fireEvent.click(getByText('mobile.search.gradeClear'));
      showBound(ANY);
      expect(rangeToggle(container).getAttribute('data-checked')).toBe('true');

      fireEvent.click(getByText('V4'));
      showBound({ minGradeId: 10, maxGradeId: 10 });
      fireEvent.click(getByText('V5'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 10, maxGradeId: 12 });
    });

    // A recent filter applied from the chip row can set a range while the rail
    // is open with Range off. The toggle then reads on, and the next tap on the
    // strip must not switch it back off under the climber.
    describe('for a range set from outside the rail', () => {
      it('reads on', () => {
        const { container, showBound } = renderRail(ANY);
        expect(rangeToggle(container).getAttribute('data-checked')).toBe('false');

        showBound({ minGradeId: 10, maxGradeId: 14 });
        expect(rangeToggle(container).getAttribute('data-checked')).toBe('true');
      });

      it('stays on when a grade tap replaces that range', () => {
        const { container, getByText, onChange, showBound } = renderRail(ANY);
        showBound({ minGradeId: 10, maxGradeId: 14 });

        fireEvent.click(getByText('V5'));
        expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 12, maxGradeId: 12 });
        showBound({ minGradeId: 12, maxGradeId: 12 });
        expect(rangeToggle(container).getAttribute('data-checked')).toBe('true');
      });

      it('stays on when Any clears that range', () => {
        const { container, getByText, showBound } = renderRail(ANY);
        showBound({ minGradeId: 10, maxGradeId: 14 });

        fireEvent.click(getByText('mobile.search.gradeClear'));
        showBound(ANY);
        expect(rangeToggle(container).getAttribute('data-checked')).toBe('true');
      });

      it('still turns off, collapsing to the lower end, from the toggle', () => {
        const { container, onChange, showBound } = renderRail(ANY);
        showBound({ minGradeId: 10, maxGradeId: 14 });

        fireEvent.click(rangeToggle(container));
        expect(onChange.mock.calls).toEqual([[{ minGradeId: 10, maxGradeId: 10 }]]);
        showBound({ minGradeId: 10, maxGradeId: 10 });
        expect(rangeToggle(container).getAttribute('data-checked')).toBe('false');
      });
    });
  });

  describe('second-end hint', () => {
    it('is on every other grade chip while Range is on with one grade selected', () => {
      const { container } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      fireEvent.click(rangeToggle(container));
      expect(chipHints(container)).toEqual({
        'mobile.search.gradeClear': '',
        V4: RANGE_HINT,
        V5: '',
        V6: RANGE_HINT,
      });
    });

    it('is absent while Range is off', () => {
      const { container } = renderRail({ minGradeId: 12, maxGradeId: 12 });
      expect(Object.values(chipHints(container))).toEqual(['', '', '', '']);
    });

    it('is absent while Range is on with nothing selected', () => {
      const { container } = renderRail(ANY);
      fireEvent.click(rangeToggle(container));
      expect(Object.values(chipHints(container))).toEqual(['', '', '', '']);
    });

    it('is absent once the range is complete', () => {
      const { container } = renderRail({ minGradeId: 10, maxGradeId: 14 });
      expect(Object.values(chipHints(container))).toEqual(['', '', '', '']);
    });
  });

  describe('chips', () => {
    it('paints the ends selected, the grades between in-range and the rest neutral', () => {
      const { container, showBound } = renderRail({ minGradeId: 10, maxGradeId: 14 });
      expect(chipTones(container)).toMatchObject({ V4: 'selected', V5: 'range', V6: 'selected' });

      showBound({ minGradeId: 12, maxGradeId: 12 });
      expect(chipTones(container)).toMatchObject({ V4: 'neutral', V5: 'selected', V6: 'neutral' });
    });

    it('gives Any the checkmark tone while no filter is set, and never a colour', () => {
      const { container, getByText, showBound } = renderRail(ANY);
      const anyChip = getByText('mobile.search.gradeClear');
      expect(anyChip.getAttribute('data-tone')).toBe('range');
      expect(anyChip.getAttribute('data-grade-color')).toBe('');
      expect(anyChip.getAttribute('data-selected')).toBe('true');

      showBound({ minGradeId: 12, maxGradeId: 12 });
      expect(anyChip.getAttribute('data-tone')).toBe('neutral');
      expect(anyChip.getAttribute('data-grade-color')).toBe('');
      expect(anyChip.getAttribute('data-selected')).toBe('false');
      // Every real grade does carry its colour, for the dot.
      for (const chip of container.querySelectorAll('[data-chip]')) {
        if (chip !== anyChip) expect(chip.getAttribute('data-grade-color')).not.toBe('');
      }
    });
  });

  it('has no handle and no close control: the Range toggle is its only button besides the chips', () => {
    const { container } = renderRail(ANY);
    const pressables = [...container.querySelectorAll('[data-pressable]')];
    expect(pressables.map((pressable) => pressable.getAttribute('data-pressable'))).toEqual([
      'mobile.gradeRail.rangeToggle',
    ]);
    expect(container.querySelector('[data-label="mobile.gradeRail.closeAria"]')).toBeNull();
  });

  it('keeps the Range toggle outside the scrolling strip', () => {
    const { container } = renderRail(ANY);
    const strip = container.querySelector('[data-scroll="true"]');
    expect(strip?.querySelectorAll('[data-chip]')).toHaveLength(4);
    expect(strip?.contains(rangeToggle(container))).toBe(false);
  });

  it('rests the first chip and the toggle on a 16pt gutter unless the container sets its own', () => {
    const { container, rerender } = renderRail(ANY);
    expect(container.querySelector('[data-scroll="true"]')?.getAttribute('data-padding-start')).toBe('16');
    expect(rangeToggle(container).getAttribute('data-margin-end')).toBe('16');

    rerender(
      <GradeRangeRail grades={grades} bound={ANY} onChange={vi.fn()} contentInsetLeft={0} contentInsetRight={0} />,
    );
    expect(container.querySelector('[data-scroll="true"]')?.getAttribute('data-padding-start')).toBe('0');
    expect(rangeToggle(container).getAttribute('data-margin-end')).toBe('0');
  });

  it('fires a selection haptic for a grade tap, a clear and a toggle change', () => {
    const { container, getByText } = renderRail(ANY);
    fireEvent.click(getByText('V4'));
    fireEvent.click(getByText('mobile.search.gradeClear'));
    fireEvent.click(rangeToggle(container));
    expect(haptics.selection).toHaveBeenCalledTimes(3);
  });

  it('keeps the inline filter rail visible while grades are pending on Android', () => {
    const { getByText, container } = render(<GradeRangeRail grades={[]} bound={ANY} onChange={vi.fn()} showTitle />);
    expect(getByText('mobile.filter.gradeRange')).toBeTruthy();
    expect(getByText('mobile.search.gradeClear')).toBeTruthy();
    expect(container.querySelector('[data-scroll="true"]')?.getAttribute('data-nested-scroll')).toBe('true');
  });
});

describe('GradeSingleSelectRail', () => {
  it('labels every chip differently when grades share a V grade (#5960)', () => {
    const scale = [
      { difficultyId: 10, name: '4a/V0' },
      { difficultyId: 11, name: '4b/V0' },
      { difficultyId: 12, name: '4c/V0' },
      { difficultyId: 15, name: '5c/V2' },
    ] as unknown as Grade[];
    const { getByText, queryByText } = render(
      <GradeSingleSelectRail grades={scale} selectedDifficultyId={null} onSelect={vi.fn()} />,
    );
    expect(getByText('V0 / 4A')).toBeTruthy();
    expect(getByText('V0 / 4B')).toBeTruthy();
    expect(getByText('V0 / 4C')).toBeTruthy();
    expect(getByText('V2')).toBeTruthy();
    expect(queryByText('V0')).toBeNull();
  });

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

  // In the default `grade` colorway the chip draws these tones as: selected =
  // solid grade colour with a checkmark, consensus = tinted with the grade dot,
  // neutral = the dot alone (pinned in grade-chip-colorway.test.tsx). The rail's
  // side of that is the tone and the grade colour it hands each chip.
  it('hands each chip its tone and grade colour in the grade colorway', () => {
    const { container } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={12} consensusDifficultyId={14} onSelect={vi.fn()} />,
    );
    expect(chipTones(container)).toEqual({ V4: 'neutral', V5: 'selected', V6: 'consensus' });
    for (const chip of container.querySelectorAll('[data-chip]')) {
      expect(chip.getAttribute('data-colorway')).toBe('grade');
      expect(chip.getAttribute('data-grade-color')).not.toBe('');
    }
  });

  it('leaves the selected chip without a consensus tone when both land on one grade', () => {
    const { container } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={14} consensusDifficultyId={14} onSelect={vi.fn()} />,
    );
    expect(chipTones(container)).toEqual({ V4: 'neutral', V5: 'neutral', V6: 'selected' });
  });

  it('fires selection haptics on tap', () => {
    const { getByText } = render(
      <GradeSingleSelectRail grades={grades} selectedDifficultyId={null} onSelect={vi.fn()} />,
    );
    fireEvent.click(getByText('V4'));
    expect(haptics.selection).toHaveBeenCalled();
  });
});
