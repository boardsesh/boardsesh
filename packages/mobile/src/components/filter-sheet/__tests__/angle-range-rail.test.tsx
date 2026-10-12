// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

type LayoutEvent = { nativeEvent: { layout: { x: number; width: number; height: number; y: number } } };

// The scroll strip as the tests drive it: the scrollTo the rail calls and where
// each chip sits.
const strip = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  chipX: {} as Record<string, number>,
}));

const RAIL_WIDTH = 320;
const CHIP_WIDTH = 56;
const BRAND_FILL = '#6D28D9';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-gesture-handler', async () => {
  const { useEffect, useImperativeHandle, useRef } = await import('react');
  return {
    ScrollView: ({
      ref,
      children,
      onLayout,
    }: {
      ref?: Ref<{ scrollTo: (target: { x: number; animated: boolean }) => void }>;
      children?: ReactNode;
      onLayout?: (event: LayoutEvent) => void;
    }) => {
      useImperativeHandle(ref, () => ({ scrollTo: strip.scrollTo }), []);
      // Lay the strip out once, after its chips have reported theirs.
      const laidOutRef = useRef(false);
      useEffect(() => {
        if (laidOutRef.current) return;
        laidOutRef.current = true;
        onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: RAIL_WIDTH, height: 52 } } });
      }, [onLayout]);
      return createElement('div', { 'data-scroll': 'true' }, children);
    },
  };
});

vi.mock('../../grade/GradeChip', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    GRADE_CHIP_HEIGHT: 44,
    GradeChip: ({
      label,
      tone = 'neutral',
      gradeColor,
      onPress,
      onLongPress,
      accessibilityLabel,
      accessibilityHint,
      accessibilityState,
      onLayout,
    }: {
      label: string;
      tone?: string;
      gradeColor?: string;
      onPress: () => void;
      onLongPress?: () => void;
      accessibilityLabel: string;
      accessibilityHint?: string;
      accessibilityState?: { selected?: boolean };
      onLayout?: (event: LayoutEvent) => void;
    }) => {
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
          'data-hint': accessibilityHint ?? '',
          'data-color': gradeColor ?? '',
        },
        label,
      );
    },
  };
});

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666' }, brandColors: { primaryFill: '#6D28D9' } }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.angle === 'string' ? `${key}:${options.angle}` : key,
  }),
}));

import { AngleRangeRail, type AngleRange } from '../AngleRangeRail';
import { DEFAULT_FILTER_ANGLES, formatAngleLabel } from '../angle-labels';

const ANY_LABEL = 'mobile.angleRail.any';
const HOLD_HINT = 'mobile.angleRail.rangeHoldHint';
// Mirrors RANGE_EXTEND_WINDOW_MS. Restated so a change to the window fails here.
const WINDOW_MS = 3000;
const SESSION_START = new Date('2026-10-12T12:00:00Z').getTime();

type RailProps = { angles?: readonly number[]; centerAngle?: number };

function renderRail(value: AngleRange | null, props: RailProps = {}) {
  const onChange = vi.fn();
  const rail = (shownValue: AngleRange | null) => <AngleRangeRail value={shownValue} onChange={onChange} {...props} />;
  const view = render(rail(value));
  const show = (next: AngleRange | null) => view.rerender(rail(next));
  return { ...view, onChange, show };
}

function chipAttribute(container: HTMLElement, attribute: string): Record<string, string | null> {
  return Object.fromEntries(
    [...container.querySelectorAll('[data-chip]')].map((chip) => [
      chip.textContent ?? '',
      chip.getAttribute(attribute),
    ]),
  );
}

const chipLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-chip]')].map((chip) => chip.textContent);

const centredOn = (chipX: number) => ({
  x: Math.max(0, chipX + CHIP_WIDTH / 2 - RAIL_WIDTH / 2),
  animated: false,
});

beforeEach(() => {
  haptics.selection.mockClear();
  strip.scrollTo.mockClear();
  strip.chipX = {};
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SESSION_START);
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frame(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AngleRangeRail', () => {
  describe('stops', () => {
    it('offers Any and then −5° to 70° in 5° steps by default', () => {
      const { container } = renderRail(null);
      expect(DEFAULT_FILTER_ANGLES).toEqual([-5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]);
      expect(chipLabels(container)).toEqual([ANY_LABEL, ...DEFAULT_FILTER_ANGLES.map(formatAngleLabel)]);
    });

    it('writes a negative angle with a true minus sign, not a hyphen', () => {
      expect(formatAngleLabel(-5)).toBe('−5°');
      expect(formatAngleLabel(0)).toBe('0°');
      expect(formatAngleLabel(40)).toBe('40°');
    });

    it('takes its own angles, lowest first and each once', () => {
      const { container } = renderRail(null, { angles: [45, 20, 30, 20] });
      expect(chipLabels(container)).toEqual([ANY_LABEL, '20°', '30°', '45°']);
    });

    it('paints every angle with the brand fill, and leaves Any without a colour', () => {
      const { container } = renderRail(null, { angles: [20, 30] });
      expect(chipAttribute(container, 'data-color')).toEqual({ [ANY_LABEL]: '', '20°': BRAND_FILL, '30°': BRAND_FILL });
    });

    it('paints the ends of a range selected and the angles between in range', () => {
      const { container } = renderRail([30, 45]);
      expect(chipAttribute(container, 'data-tone')).toMatchObject({
        [ANY_LABEL]: 'neutral',
        '25°': 'neutral',
        '30°': 'selected',
        '35°': 'range',
        '40°': 'range',
        '45°': 'selected',
        '50°': 'neutral',
      });
    });
  });

  describe('gestures', () => {
    it('picks one angle on a tap', () => {
      const { getByText, onChange } = renderRail(null);
      fireEvent.click(getByText('40°'));
      expect(onChange.mock.calls).toEqual([[[40, 40], { gesture: 'tap' }]]);
    });

    // 0 is an angle, not "no angle": it must come back as a selection, never Any.
    it('reports 0° as an angle of its own', () => {
      const { getByText, onChange } = renderRail(null);
      fireEvent.click(getByText('0°'));
      expect(onChange.mock.calls).toEqual([[[0, 0], { gesture: 'tap' }]]);
    });

    it('makes a range that ends on 0°, from −5°', () => {
      const { getByText, onChange, show } = renderRail(null);
      fireEvent.click(getByText('\u22125°'));
      show([-5, -5]);
      vi.setSystemTime(SESSION_START + 500);
      fireEvent.click(getByText('0°'));
      expect(onChange.mock.calls).toEqual([
        [[-5, -5], { gesture: 'tap' }],
        [[-5, 0], { gesture: 'tap', withinRangeWindow: true }],
      ]);
    });

    it('paints a 0° selection as selected', () => {
      const { container } = renderRail([0, 0]);
      expect(chipAttribute(container, 'data-tone')).toMatchObject({ [ANY_LABEL]: 'neutral', '0°': 'selected' });
    });

    it('makes a range from a second tap inside the window', () => {
      const { getByText, onChange, show } = renderRail(null);
      fireEvent.click(getByText('40°'));
      show([40, 40]);
      vi.setSystemTime(SESSION_START + WINDOW_MS - 1);
      fireEvent.click(getByText('25°'));
      expect(onChange.mock.calls[1]).toEqual([[25, 40], { gesture: 'tap', withinRangeWindow: true }]);
    });

    it('switches angle once the window is up', () => {
      const { getByText, onChange, show } = renderRail(null);
      fireEvent.click(getByText('40°'));
      show([40, 40]);
      vi.setSystemTime(SESSION_START + WINDOW_MS);
      fireEvent.click(getByText('50°'));
      expect(onChange.mock.calls[1]).toEqual([[50, 50], { gesture: 'tap', withinRangeWindow: false }]);
    });

    it('makes a range from a touch and hold, whenever the first angle was picked', () => {
      const { getByText, onChange } = renderRail([40, 40]);
      fireEvent.contextMenu(getByText('55°'));
      expect(onChange.mock.calls).toEqual([[[40, 55], { gesture: 'hold' }]]);
    });

    it('clears to Any when the selected angle is tapped again', () => {
      const { getByText, onChange } = renderRail([40, 40]);
      fireEvent.click(getByText('40°'));
      expect(onChange.mock.calls).toEqual([[null, { gesture: 'tap' }]]);
    });

    it('clears to Any from the Any chip, and reports nothing when nothing is set', () => {
      const { getByText, onChange, show } = renderRail([30, 45]);
      fireEvent.click(getByText(ANY_LABEL));
      expect(onChange.mock.calls).toEqual([[null, { gesture: 'clear' }]]);
      show(null);
      fireEvent.click(getByText(ANY_LABEL));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('fires a selection haptic for a tap and for a clear', () => {
      const { getByText } = renderRail([40, 40]);
      fireEvent.click(getByText('50°'));
      fireEvent.click(getByText(ANY_LABEL));
      expect(haptics.selection).toHaveBeenCalledTimes(2);
    });
  });

  describe('screen reader', () => {
    it('names each angle in degrees with where it sits in the range', () => {
      const { container } = renderRail([30, 40], { angles: [-5, 30, 35, 40, 45] });
      expect(chipAttribute(container, 'data-label')).toEqual({
        [ANY_LABEL]: 'mobile.angleRail.clearFilterAria',
        '−5°': 'mobile.angleRail.setFilterAria:-5',
        '30°': 'mobile.angleRail.selectedFilterAria:30',
        '35°': 'mobile.angleRail.rangeFilterAria:35',
        '40°': 'mobile.angleRail.selectedFilterAria:40',
        '45°': 'mobile.angleRail.setFilterAria:45',
      });
      expect(chipAttribute(container, 'data-selected')).toMatchObject({ '30°': 'true', '35°': 'false', '40°': 'true' });
    });

    it('says Any is selected while nothing is set', () => {
      const { container } = renderRail(null, { angles: [40] });
      expect(chipAttribute(container, 'data-label')[ANY_LABEL]).toBe('mobile.angleRail.anyAngleAria');
      expect(chipAttribute(container, 'data-selected')[ANY_LABEL]).toBe('true');
    });

    it('tells every other angle to touch and hold while one angle is selected', () => {
      const { container } = renderRail([40, 40], { angles: [35, 40, 45] });
      expect(chipAttribute(container, 'data-hint')).toEqual({
        [ANY_LABEL]: '',
        '35°': HOLD_HINT,
        '40°': '',
        '45°': HOLD_HINT,
      });
    });

    it('drops the hint once a range is set', () => {
      const { container } = renderRail([35, 45], { angles: [35, 40, 45] });
      expect(new Set(Object.values(chipAttribute(container, 'data-hint')))).toEqual(new Set(['']));
    });
  });

  describe('centring', () => {
    it('centres on the selected angle when it mounts', () => {
      strip.chipX = { '50°': 600 };
      renderRail([50, 60]);
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(600));
    });

    it('centres on the given angle while nothing is selected', () => {
      strip.chipX = { '40°': 500 };
      renderRail(null, { centerAngle: 40 });
      expect(strip.scrollTo).toHaveBeenLastCalledWith(centredOn(500));
    });

    it('stays at the start with nothing selected and no angle to centre on', () => {
      strip.chipX = { '40°': 500 };
      renderRail(null);
      expect(strip.scrollTo).not.toHaveBeenCalled();
    });
  });
});
