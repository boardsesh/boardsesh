// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

type LayoutEvent = { nativeEvent: { layout: { x: number; width: number; height: number; y: number } } };
type TouchEndEvent = { nativeEvent: { touches: unknown[] } };

// The scroll strip as the tests drive it: the scrollTo the rail calls, the
// touch and drag handlers it registered, where each chip sits, and the grade
// format the climber reads.
const strip = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  handlers: {} as {
    onTouchStart?: () => void;
    onTouchEnd?: (event: { nativeEvent: { touches: unknown[] } }) => void;
    onTouchCancel?: () => void;
    onScrollBeginDrag?: () => void;
    onScrollEndDrag?: () => void;
  },
  chipX: {} as Record<string, number>,
  gradeFormat: 'v-grade' as 'v-grade' | 'font',
}));

const RAIL_WIDTH = 320;
const CHIP_WIDTH = 56;

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-gesture-handler', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  const { useEffect, useImperativeHandle, useRef } = await import('react');
  return {
    ScrollView: ({
      ref,
      children,
      nestedScrollEnabled,
      contentContainerStyle,
      onLayout,
      onTouchStart,
      onTouchEnd,
      onTouchCancel,
      onScrollBeginDrag,
      onScrollEndDrag,
    }: {
      ref?: Ref<{ scrollTo: (target: { x: number; animated: boolean }) => void }>;
      children?: ReactNode;
      nestedScrollEnabled?: boolean;
      contentContainerStyle?: unknown;
      onLayout?: (event: LayoutEvent) => void;
      onTouchStart?: () => void;
      onTouchEnd?: (event: TouchEndEvent) => void;
      onTouchCancel?: () => void;
      onScrollBeginDrag?: () => void;
      onScrollEndDrag?: () => void;
    }) => {
      useImperativeHandle(ref, () => ({ scrollTo: strip.scrollTo }), []);
      strip.handlers = { onTouchStart, onTouchEnd, onTouchCancel, onScrollBeginDrag, onScrollEndDrag };
      // Lay the strip out once, after its chips have reported theirs.
      const laidOutRef = useRef(false);
      useEffect(() => {
        if (laidOutRef.current) return;
        laidOutRef.current = true;
        onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: RAIL_WIDTH, height: 52 } } });
      }, [onLayout]);
      return createElement(
        'div',
        {
          'data-scroll': 'true',
          'data-nested-scroll': nestedScrollEnabled ? 'true' : 'false',
          'data-padding-start': String(flattenStyle(contentContainerStyle).paddingStart),
        },
        children,
      );
    },
  };
});

vi.mock('../GradeChip', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    GRADE_CHIP_HEIGHT: 44,
    GradeChip: ({
      label,
      tone = 'neutral',
      colorway = 'grade',
      gradeColor,
      onPress,
      onLongPress,
      delayLongPress,
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
      onLongPress?: () => void;
      delayLongPress?: number;
      accessibilityLabel: string;
      accessibilityHint?: string;
      accessibilityState?: { selected?: boolean };
      onLayout?: (event: LayoutEvent) => void;
    }) => {
      // Report a layout once, at the x the test gave this label.
      const laidOutRef = useRef(false);
      useEffect(() => {
        if (laidOutRef.current) return;
        laidOutRef.current = true;
        onLayout?.({ nativeEvent: { layout: { x: strip.chipX[label] ?? 0, y: 0, width: CHIP_WIDTH, height: 44 } } });
      }, [label, onLayout]);
      return createElement(
        'button',
        {
          onClick: onPress,
          // A touch and hold, which the real chip gets from its Pressable.
          onContextMenu: onLongPress,
          'data-chip': 'true',
          'data-label': accessibilityLabel,
          'data-selected': accessibilityState?.selected ? 'true' : 'false',
          'data-tone': tone,
          'data-colorway': colorway,
          'data-hint': accessibilityHint ?? '',
          'data-grade-color': gradeColor ?? '',
          'data-holdable': onLongPress ? 'true' : 'false',
          'data-hold-ms': String(delayLongPress),
        },
        label,
      );
    },
    GradeChipMark: ({ checked, dotColor, checkColor }: { checked: boolean; dotColor?: string; checkColor: string }) =>
      createElement('span', {
        'data-mark': checked ? 'check' : dotColor ? 'dot' : 'empty',
        'data-mark-color': checked ? checkColor : '',
      }),
    GradeChipLabel: ({ color, children }: { color?: string; children: string }) =>
      createElement('span', { 'data-chip-label': 'true', 'data-label-color': color ?? '' }, children),
  };
});

// The rail's only pressable of its own is the Range button.
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
          'data-height': String(flatStyle.height),
        },
        children,
      );
    },
  };
});

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
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
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: strip.gradeFormat,
    formatGrade: (name: string | null | undefined) => name ?? null,
  }),
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

// The single-select rail's fixture: one V grade per chip.
const grades: Grade[] = [
  { difficultyId: 10, name: 'V4' },
  { difficultyId: 12, name: 'V5' },
  { difficultyId: 14, name: 'V6' },
] as unknown as Grade[];

// The range rail's fixture, on the shared scale. Under V grades 4a to 4c read
// "V0" and 5a and 5b read "V1", so the row is V0 [10-12], V1 [13-14], V2 [15],
// V3 [16], V4 [17], V5 [18]. Under Font all nine grades read differently.
const RANGE_GRADES: Grade[] = [
  { difficultyId: 10, name: '4a/V0' },
  { difficultyId: 11, name: '4b/V0' },
  { difficultyId: 12, name: '4c/V0' },
  { difficultyId: 13, name: '5a/V1' },
  { difficultyId: 14, name: '5b/V1' },
  { difficultyId: 15, name: '5c/V2' },
  { difficultyId: 16, name: '6a/V3' },
  { difficultyId: 17, name: '6b/V4' },
  { difficultyId: 18, name: '6c/V5' },
] as unknown as Grade[];

const ANY: GradeBound = { minGradeId: undefined, maxGradeId: undefined };
const ONLY_V0: GradeBound = { minGradeId: 10, maxGradeId: 12 };
const ONLY_V2: GradeBound = { minGradeId: 15, maxGradeId: 15 };
const V2_TO_V5: GradeBound = { minGradeId: 15, maxGradeId: 18 };
const ANY_LABEL = 'mobile.search.gradeClear';
const RANGE_HINT = 'mobile.gradeRail.rangeHint';
const HOLD_HINT = 'mobile.gradeRail.rangeHoldHint';

function renderRail(bound: GradeBound, props: { recenterKey?: number } = {}) {
  const onChange = vi.fn();
  const rail = (shownBound: GradeBound, shownProps: { recenterKey?: number }) => (
    <GradeRangeRail grades={RANGE_GRADES} bound={shownBound} onChange={onChange} {...shownProps} />
  );
  const view = render(rail(bound, props));
  const show = (next: GradeBound, nextProps: { recenterKey?: number } = props) => view.rerender(rail(next, nextProps));
  return { ...view, onChange, show };
}

function rangeButton(container: HTMLElement): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-pressable="mobile.gradeRail.rangeToggle"]');
  if (!button) throw new Error('Range button not rendered');
  return button;
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

const chipLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-chip]')].map((chip) => chip.textContent);

/** The scroll offset that centres a chip at `chipX` in the strip; the strip cannot scroll before its start. */
const centredOn = (chipX: number) => ({
  x: Math.max(0, chipX + CHIP_WIDTH / 2 - RAIL_WIDTH / 2),
  animated: false,
});

beforeEach(() => {
  haptics.selection.mockClear();
  strip.scrollTo.mockClear();
  strip.handlers = {};
  strip.chipX = {};
  strip.gradeFormat = 'v-grade';
  // Frames run at once, so a centring pass finishes inside the call that starts it.
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frame(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

describe('GradeRangeRail', () => {
  describe('stops', () => {
    it('draws grades that read the same as one chip under V grades', () => {
      const { container } = renderRail(ANY);
      expect(chipLabels(container)).toEqual([ANY_LABEL, 'V0', 'V1', 'V2', 'V3', 'V4', 'V5']);
    });

    it('draws one chip per grade under Font grades, where no two read the same', () => {
      strip.gradeFormat = 'font';
      const { container } = renderRail(ANY);
      expect(chipLabels(container)).toEqual([ANY_LABEL, '4A', '4B', '4C', '5A', '5B', '5C', '6A', '6B', '6C']);
    });

    it('sets a grouped stop from its lowest grade to its highest', () => {
      const { getByText, onChange } = renderRail(ANY);
      fireEvent.click(getByText('V0'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 10, maxGradeId: 12 }, { gesture: 'tap' }]]);
    });

    it('paints a grouped stop selected, and clears it on a second tap', () => {
      const { container, getByText, onChange } = renderRail(ONLY_V0);
      expect(chipTones(container)).toMatchObject({ V0: 'selected', V1: 'neutral' });
      fireEvent.click(getByText('V0'));
      expect(onChange.mock.calls).toEqual([[ANY, { gesture: 'tap' }]]);
    });

    // A bound made under Font grades, or saved before chips were grouped.
    it('paints the stop a saved bound sits inside as selected, without a range', () => {
      const { container } = renderRail({ minGradeId: 11, maxGradeId: 11 });
      expect(chipTones(container)).toEqual({
        [ANY_LABEL]: 'neutral',
        V0: 'selected',
        V1: 'neutral',
        V2: 'neutral',
        V3: 'neutral',
        V4: 'neutral',
        V5: 'neutral',
      });
    });

    it('paints a range that starts inside a group from that whole stop', () => {
      const { container } = renderRail({ minGradeId: 11, maxGradeId: 16 });
      expect(chipTones(container)).toMatchObject({
        V0: 'selected',
        V1: 'range',
        V2: 'range',
        V3: 'selected',
        V4: 'neutral',
      });
    });

    it('survives a bound on grades the row has no chip for', () => {
      const { container } = renderRail({ minGradeId: 40, maxGradeId: 42 });
      expect(new Set(Object.values(chipTones(container)))).toEqual(new Set(['neutral']));
    });

    it('names each stop by its label for the screen reader', () => {
      const { container } = renderRail({ minGradeId: 10, maxGradeId: 15 });
      expect(chipAttribute(container, 'data-label')).toMatchObject({
        V0: 'mobile.gradeRail.selectedFilterAria:V0',
        V1: 'mobile.gradeRail.rangeFilterAria:V1',
        V2: 'mobile.gradeRail.selectedFilterAria:V2',
        V3: 'mobile.gradeRail.setFilterAria:V3',
      });
    });
  });

  describe('a plain tap', () => {
    it('picks the tapped stop', () => {
      const { getByText, onChange } = renderRail(ANY);
      fireEvent.click(getByText('V3'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 16, maxGradeId: 16 }, { gesture: 'tap' }]]);
    });

    it('switches to the tapped stop instead of building a range', () => {
      const { getByText, onChange } = renderRail(ONLY_V2);
      fireEvent.click(getByText('V4'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 17, maxGradeId: 17 }, { gesture: 'tap' }]]);
    });

    it('clears the filter when the selected stop is tapped again', () => {
      const { getByText, onChange } = renderRail(ONLY_V2);
      fireEvent.click(getByText('V2'));
      expect(onChange.mock.calls).toEqual([[ANY, { gesture: 'tap' }]]);
    });

    it('replaces a range with the tapped stop', () => {
      const { getByText, onChange } = renderRail(V2_TO_V5);
      fireEvent.click(getByText('V3'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 16, maxGradeId: 16 }, { gesture: 'tap' }]]);
    });

    it('never builds a range however quickly the second tap follows', () => {
      const { getByText, onChange, show } = renderRail(ANY);
      fireEvent.click(getByText('V1'));
      show({ minGradeId: 13, maxGradeId: 14 });
      fireEvent.click(getByText('V4'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 17, maxGradeId: 17 }, { gesture: 'tap' });
    });
  });

  describe('the Any chip', () => {
    it('clears the filter, reported as a clear', () => {
      const { getByText, onChange } = renderRail(V2_TO_V5);
      fireEvent.click(getByText(ANY_LABEL));
      expect(onChange.mock.calls).toEqual([[ANY, { gesture: 'clear' }]]);
    });

    it('reports nothing when no filter is set', () => {
      const { getByText, onChange } = renderRail(ANY);
      fireEvent.click(getByText(ANY_LABEL));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('takes the checkmark tone while no filter is set, and never a colour', () => {
      const { container, getByText, show } = renderRail(ANY);
      const anyChip = getByText(ANY_LABEL);
      expect(anyChip.getAttribute('data-tone')).toBe('range');
      expect(anyChip.getAttribute('data-grade-color')).toBe('');
      expect(anyChip.getAttribute('data-selected')).toBe('true');

      show(ONLY_V2);
      expect(anyChip.getAttribute('data-tone')).toBe('neutral');
      expect(anyChip.getAttribute('data-grade-color')).toBe('');
      expect(anyChip.getAttribute('data-selected')).toBe('false');
      // Every real stop does carry its colour, for the dot.
      for (const chip of container.querySelectorAll('[data-chip]')) {
        if (chip !== anyChip) expect(chip.getAttribute('data-grade-color')).not.toBe('');
      }
    });

    it('is not a stop: it has no touch and hold', () => {
      const { getByText } = renderRail(ONLY_V2);
      expect(getByText(ANY_LABEL).getAttribute('data-holdable')).toBe('false');
    });
  });

  describe('the Range button', () => {
    it('is a toggle button that announces off, with its label and hint', () => {
      const { container } = renderRail(ANY);
      const button = rangeButton(container);
      expect(button.getAttribute('data-role')).toBe('togglebutton');
      expect(button.getAttribute('data-checked')).toBe('false');
      expect(button.getAttribute('data-hint')).toBe('mobile.gradeRail.rangeToggleHint');
    });

    it('shows the word with an empty mark slot and no fill while off', () => {
      const { container } = renderRail(ANY);
      const button = rangeButton(container);
      expect(button.querySelector('[data-chip-label]')?.textContent).toBe('mobile.gradeRail.rangeToggle');
      expect(button.querySelector('[data-chip-label]')?.getAttribute('data-label-color')).toBe('#111');
      expect(button.querySelector('[data-mark]')?.getAttribute('data-mark')).toBe('empty');
      expect(button.getAttribute('data-background')).toBe('transparent');
    });

    it('fills with the brand colour and checks its mark once armed, without losing the slot', () => {
      const { container } = renderRail(ANY);
      fireEvent.click(rangeButton(container));
      const button = rangeButton(container);
      expect(button.getAttribute('data-checked')).toBe('true');
      expect(button.getAttribute('data-background')).toBe('#7C3AED');
      expect(button.querySelector('[data-chip-label]')?.getAttribute('data-label-color')).toBe('#FFFFFF');
      expect(button.querySelector('[data-mark]')?.getAttribute('data-mark')).toBe('check');
      expect(button.querySelector('[data-mark]')?.getAttribute('data-mark-color')).toBe('#FFFFFF');
    });

    it('is as tall as a chip', () => {
      const { container } = renderRail(ANY);
      expect(rangeButton(container).getAttribute('data-height')).toBe('44');
    });

    it('changes no filter when it arms, and none when it disarms', () => {
      const { container, onChange } = renderRail(V2_TO_V5);
      fireEvent.click(rangeButton(container));
      expect(rangeButton(container).getAttribute('data-checked')).toBe('true');
      fireEvent.click(rangeButton(container));
      expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('starts off even when the rail mounts on a range', () => {
      const { container } = renderRail(V2_TO_V5);
      expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
    });

    it('stays armed after the first end from nothing selected, then makes the range and disarms', () => {
      const { container, getByText, onChange, show } = renderRail(ANY);
      fireEvent.click(rangeButton(container));

      fireEvent.click(getByText('V4'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 17, maxGradeId: 17 }, { gesture: 'range_button' });
      expect(rangeButton(container).getAttribute('data-checked')).toBe('true');
      show({ minGradeId: 17, maxGradeId: 17 });

      // The second end can sit below the first: the range comes out ascending.
      fireEvent.click(getByText('V1'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 13, maxGradeId: 17 }, { gesture: 'range_button' });
      expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
    });

    it('makes the range covering the selected stop and the tapped one, then disarms', () => {
      const { container, getByText, onChange } = renderRail(ONLY_V2);
      fireEvent.click(rangeButton(container));
      fireEvent.click(getByText('V0'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 10, maxGradeId: 15 }, { gesture: 'range_button' }]]);
      expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
    });

    it('is one shot: the tap after the range is a plain tap again', () => {
      const { container, getByText, onChange, show } = renderRail(ONLY_V2);
      fireEvent.click(rangeButton(container));
      fireEvent.click(getByText('V4'));
      show({ minGradeId: 15, maxGradeId: 17 });

      fireEvent.click(getByText('V5'));
      expect(onChange).toHaveBeenLastCalledWith({ minGradeId: 18, maxGradeId: 18 }, { gesture: 'tap' });
    });

    it('clears and disarms when the selected stop itself is tapped', () => {
      const { container, getByText, onChange } = renderRail(ONLY_V2);
      fireEvent.click(rangeButton(container));
      fireEvent.click(getByText('V2'));
      expect(onChange.mock.calls).toEqual([[ANY, { gesture: 'range_button' }]]);
      expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
    });

    describe('with a range set', () => {
      it('moves the nearer end to the tapped stop, then disarms', () => {
        const { container, getByText, onChange } = renderRail(V2_TO_V5);
        fireEvent.click(rangeButton(container));
        // V3 is one stop from V2 and two from V5: the lower end moves.
        fireEvent.click(getByText('V3'));
        expect(onChange.mock.calls).toEqual([[{ minGradeId: 16, maxGradeId: 18 }, { gesture: 'range_button' }]]);
        expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
      });

      it('moves the upper end when the stop is nearer to it', () => {
        const { container, getByText, onChange } = renderRail(V2_TO_V5);
        fireEvent.click(rangeButton(container));
        fireEvent.click(getByText('V4'));
        expect(onChange.mock.calls).toEqual([[{ minGradeId: 15, maxGradeId: 17 }, { gesture: 'range_button' }]]);
      });

      it('moves the upper end when the stop is equally far from both', () => {
        const { container, getByText, onChange } = renderRail({ minGradeId: 15, maxGradeId: 17 });
        fireEvent.click(rangeButton(container));
        fireEvent.click(getByText('V3'));
        expect(onChange.mock.calls).toEqual([[{ minGradeId: 15, maxGradeId: 16 }, { gesture: 'range_button' }]]);
      });

      it('extends the range to a stop outside it', () => {
        const { container, getByText, onChange } = renderRail(V2_TO_V5);
        fireEvent.click(rangeButton(container));
        fireEvent.click(getByText('V0'));
        expect(onChange.mock.calls).toEqual([[{ minGradeId: 10, maxGradeId: 18 }, { gesture: 'range_button' }]]);
      });

      it('reports nothing for a tap on an end, and still disarms', () => {
        const { container, getByText, onChange } = renderRail(V2_TO_V5);
        fireEvent.click(rangeButton(container));
        fireEvent.click(getByText('V5'));
        expect(onChange).not.toHaveBeenCalled();
        expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
      });
    });
  });

  describe('touch and hold', () => {
    it('is on every stop, after 400 ms', () => {
      const { container } = renderRail(ANY);
      const stops = [...container.querySelectorAll('[data-chip]')].slice(1);
      expect(stops).toHaveLength(6);
      for (const stop of stops) {
        expect(stop.getAttribute('data-holdable')).toBe('true');
        expect(stop.getAttribute('data-hold-ms')).toBe('400');
      }
    });

    it('makes the range with the selected stop, and leaves Range off', () => {
      const { container, getByText, onChange } = renderRail(ONLY_V2);
      fireEvent.contextMenu(getByText('V4'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 15, maxGradeId: 17 }, { gesture: 'hold' }]]);
      expect(rangeButton(container).getAttribute('data-checked')).toBe('false');
    });

    it('leaves Range armed when it was armed', () => {
      const { container, getByText, onChange } = renderRail(ONLY_V2);
      fireEvent.click(rangeButton(container));
      fireEvent.contextMenu(getByText('V4'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 15, maxGradeId: 17 }, { gesture: 'hold' }]]);
      expect(rangeButton(container).getAttribute('data-checked')).toBe('true');
    });

    it('picks the stop as a first end when nothing is selected', () => {
      const { getByText, onChange } = renderRail(ANY);
      fireEvent.contextMenu(getByText('V0'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 10, maxGradeId: 12 }, { gesture: 'hold' }]]);
    });

    it('moves the nearer end of a range', () => {
      const { getByText, onChange } = renderRail(V2_TO_V5);
      fireEvent.contextMenu(getByText('V1'));
      expect(onChange.mock.calls).toEqual([[{ minGradeId: 13, maxGradeId: 18 }, { gesture: 'hold' }]]);
    });

    it('fires one selection haptic when it triggers', () => {
      const { getByText } = renderRail(ONLY_V2);
      fireEvent.contextMenu(getByText('V4'));
      expect(haptics.selection).toHaveBeenCalledTimes(1);
    });
  });

  describe('far-end hint', () => {
    const NO_HINTS = { [ANY_LABEL]: '', V0: '', V1: '', V2: '', V3: '', V4: '', V5: '' };

    it('tells every other stop to touch and hold while one stop is selected', () => {
      const { container } = renderRail(ONLY_V2);
      expect(chipHints(container)).toEqual({
        [ANY_LABEL]: '',
        V0: HOLD_HINT,
        V1: HOLD_HINT,
        V2: '',
        V3: HOLD_HINT,
        V4: HOLD_HINT,
        V5: HOLD_HINT,
      });
    });

    it('says the next tap makes the range once Range is armed', () => {
      const { container } = renderRail(ONLY_V2);
      fireEvent.click(rangeButton(container));
      expect(chipHints(container)).toEqual({
        [ANY_LABEL]: '',
        V0: RANGE_HINT,
        V1: RANGE_HINT,
        V2: '',
        V3: RANGE_HINT,
        V4: RANGE_HINT,
        V5: RANGE_HINT,
      });
    });

    it('treats a grouped stop as the one selected stop', () => {
      const { container } = renderRail(ONLY_V0);
      expect(chipHints(container)).toMatchObject({ V0: '', V1: HOLD_HINT });
    });

    it('is absent with nothing selected, armed or not', () => {
      const { container } = renderRail(ANY);
      expect(chipHints(container)).toEqual(NO_HINTS);
      fireEvent.click(rangeButton(container));
      expect(chipHints(container)).toEqual(NO_HINTS);
    });

    it('is absent once a range is set', () => {
      const { container } = renderRail(V2_TO_V5);
      expect(chipHints(container)).toEqual(NO_HINTS);
    });
  });

  describe('centring', () => {
    beforeEach(() => {
      strip.chipX = { V0: 80, V1: 150, V2: 220, V3: 290, V4: 360, V5: 430 };
    });

    it('centres on the selected stop when it mounts', () => {
      renderRail({ minGradeId: 17, maxGradeId: 17 });
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(360));
    });

    it('centres on the stop a selection sits inside', () => {
      renderRail({ minGradeId: 14, maxGradeId: 14 });
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(150));
    });

    it('stops following the selection once the climber has tapped the rail', () => {
      const { getByText, show } = renderRail({ minGradeId: 17, maxGradeId: 17 });
      fireEvent.click(getByText('V3'));
      strip.scrollTo.mockClear();

      show({ minGradeId: 10, maxGradeId: 12 });
      expect(strip.scrollTo).not.toHaveBeenCalled();
    });

    it('centres again on a new recenterKey, even after a tap', () => {
      const { getByText, show } = renderRail({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 0 });
      fireEvent.click(getByText('V3'));
      show({ minGradeId: 10, maxGradeId: 12 }, { recenterKey: 0 });
      strip.scrollTo.mockClear();

      show({ minGradeId: 10, maxGradeId: 12 }, { recenterKey: 1 });
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(80));
    });

    it('centres again on a new recenterKey after a drag', () => {
      const { show } = renderRail({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 0 });
      act(() => {
        strip.handlers.onTouchStart?.();
        strip.handlers.onScrollBeginDrag?.();
        strip.handlers.onTouchCancel?.();
        strip.handlers.onScrollEndDrag?.();
      });
      strip.scrollTo.mockClear();

      show({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 1 });
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(360));
    });

    it('does not scroll for the same recenterKey', () => {
      const { getByText, show } = renderRail({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 5 });
      fireEvent.click(getByText('V3'));
      strip.scrollTo.mockClear();

      show({ minGradeId: 16, maxGradeId: 16 }, { recenterKey: 5 });
      expect(strip.scrollTo).not.toHaveBeenCalled();
    });

    it('never scrolls while a finger rests on the rail', () => {
      const { show } = renderRail({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 0 });
      strip.scrollTo.mockClear();

      act(() => strip.handlers.onTouchStart?.());
      show({ minGradeId: 10, maxGradeId: 12 }, { recenterKey: 1 });
      expect(strip.scrollTo).not.toHaveBeenCalled();

      // The finger lifts. That request was dropped; the next one is honoured.
      act(() => strip.handlers.onTouchEnd?.({ nativeEvent: { touches: [] } }));
      expect(strip.scrollTo).not.toHaveBeenCalled();
      show({ minGradeId: 10, maxGradeId: 12 }, { recenterKey: 2 });
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(80));
    });

    it('still counts a finger as down while another one lifts', () => {
      const { show } = renderRail({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 0 });
      act(() => {
        strip.handlers.onTouchStart?.();
        strip.handlers.onTouchEnd?.({ nativeEvent: { touches: [{}] } });
      });
      strip.scrollTo.mockClear();

      show({ minGradeId: 10, maxGradeId: 12 }, { recenterKey: 1 });
      expect(strip.scrollTo).not.toHaveBeenCalled();
    });

    it('never scrolls while the rail is being dragged', () => {
      const { show } = renderRail({ minGradeId: 17, maxGradeId: 17 }, { recenterKey: 0 });
      act(() => {
        strip.handlers.onTouchStart?.();
        strip.handlers.onScrollBeginDrag?.();
        // The scroll view takes the touch over, which cancels it for the chips.
        strip.handlers.onTouchCancel?.();
      });
      strip.scrollTo.mockClear();

      show({ minGradeId: 10, maxGradeId: 12 }, { recenterKey: 1 });
      expect(strip.scrollTo).not.toHaveBeenCalled();
    });
  });

  it('has no handle and no close control: the Range button is its only button besides the chips', () => {
    const { container } = renderRail(ANY);
    const pressables = [...container.querySelectorAll('[data-pressable]')];
    expect(pressables.map((pressable) => pressable.getAttribute('data-pressable'))).toEqual([
      'mobile.gradeRail.rangeToggle',
    ]);
    expect(container.querySelector('[data-label="mobile.gradeRail.closeAria"]')).toBeNull();
  });

  it('keeps the Range button outside the scrolling strip', () => {
    const { container } = renderRail(ANY);
    const scrollStrip = container.querySelector('[data-scroll="true"]');
    expect(scrollStrip?.querySelectorAll('[data-chip]')).toHaveLength(7);
    expect(scrollStrip?.contains(rangeButton(container))).toBe(false);
  });

  it('rests the first chip and the Range button on a 16pt gutter unless the container sets its own', () => {
    const { container, rerender } = renderRail(ANY);
    expect(container.querySelector('[data-scroll="true"]')?.getAttribute('data-padding-start')).toBe('16');
    expect(rangeButton(container).getAttribute('data-margin-end')).toBe('16');

    rerender(
      <GradeRangeRail
        grades={RANGE_GRADES}
        bound={ANY}
        onChange={vi.fn()}
        contentInsetLeft={0}
        contentInsetRight={0}
      />,
    );
    expect(container.querySelector('[data-scroll="true"]')?.getAttribute('data-padding-start')).toBe('0');
    expect(rangeButton(container).getAttribute('data-margin-end')).toBe('0');
  });

  it('fires a selection haptic for a stop tap, a clear and a Range tap', () => {
    const { container, getByText } = renderRail(ONLY_V2);
    fireEvent.click(getByText('V4'));
    fireEvent.click(getByText(ANY_LABEL));
    fireEvent.click(rangeButton(container));
    expect(haptics.selection).toHaveBeenCalledTimes(3);
  });

  it('keeps the inline filter rail visible while grades are pending on Android', () => {
    const { getByText, container } = render(<GradeRangeRail grades={[]} bound={ANY} onChange={vi.fn()} showTitle />);
    expect(getByText('mobile.filter.gradeRange')).toBeTruthy();
    expect(getByText(ANY_LABEL)).toBeTruthy();
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
