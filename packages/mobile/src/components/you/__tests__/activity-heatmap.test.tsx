// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import type { RawActivityHeatmap } from '@boardsesh/profile-stats';

const GRID_WIDTH = 360;

vi.mock('react-native', () => ({
  // Reports a fixed width on mount, the way RN's first layout pass would.
  View: ({
    children,
    onLayout,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    accessibilityLabel?: string;
  }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: GRID_WIDTH } } });
    }, [onLayout]);
    return createElement('div', { 'aria-label': accessibilityLabel }, children);
  },
  Pressable: ({
    accessibilityLabel,
    onPress,
  }: {
    accessibilityLabel?: string;
    onPress?: (event: { nativeEvent: { locationY: number } }) => void;
  }) =>
    createElement('button', {
      'aria-label': accessibilityLabel,
      'data-week': 'true',
      // `data-location-y` lets a test pick which cell in the column it taps.
      onClick: (event: { currentTarget: HTMLElement }) =>
        onPress?.({ nativeEvent: { locationY: Number(event.currentTarget.dataset.locationY ?? 0) } }),
    }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
}));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Rect: ({ fill, stroke }: { fill?: string; stroke?: string }) =>
    createElement('rect', { 'data-fill': fill, 'data-stroke': stroke }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-GB' },
    t: (key: string, options?: Record<string, string | number>) =>
      options
        ? `${key}(${Object.entries(options)
            .map(([name, value]) => `${name}=${value}`)
            .join('|')})`
        : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'dark',
    chartColors: {
      accent: '#A78BFA',
      secondaryBackground: '#181225',
      separator: '#333333',
      label: '#FFFFFF',
      secondaryLabel: '#AAAAAA',
    },
    brandColors: { accent: '#FF8800' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { sm: 4 },
}));
vi.mock('../../../lib/clock', () => ({ nowDate: () => new Date(2026, 9, 15, 12) }));
let screenReaderEnabled = false;
vi.mock('../../../hooks/use-screen-reader-enabled', () => ({ useScreenReaderEnabled: () => screenReaderEnabled }));
vi.mock('../../../lib/showcase-anchor', () => ({ useShowcaseAnchor: () => ({ ref: undefined }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { ActivityHeatmap } from '../ActivityHeatmap';

// Four ISO weeks, Mon 21 Sep → Sun 18 Oct 2026; "today" is Thu 15 Oct.
function makeHeatmap(): RawActivityHeatmap {
  const days = [];
  const cursor = new Date(2026, 8, 21);
  for (let index = 0; index < 28; index += 1) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    days.push({ date: key, count: key === '2026-10-13' ? 6 : key === '2026-10-15' ? 2 : 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return { days, weeks: 4, maxCount: 6, startDate: '2026-09-21', endDate: '2026-10-18' };
}

function weekButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-week]'));
}

describe('ActivityHeatmap', () => {
  it('labels the months along the top and Mon / Wed / Fri down the side', () => {
    render(createElement(ActivityHeatmap, { heatmap: makeHeatmap() }));
    // Oct starts two columns from the right edge, so September keeps the row.
    expect(screen.getByText(/^Sept?$/)).toBeTruthy();
    for (const weekday of ['Mon', 'Wed', 'Fri']) expect(screen.getByText(weekday)).toBeTruthy();
    expect(screen.getByText('stats.calendarToday')).toBeTruthy();
  });

  it('gives each week column a screen-reader label with its days climbed', () => {
    render(createElement(ActivityHeatmap, { heatmap: makeHeatmap() }));
    const labels = weekButtons().map((button) => button.getAttribute('aria-label'));
    expect(labels).toHaveLength(4);
    expect(labels[0]).toMatch(/^stats\.calendarWeekEmptyAria\(date=21 Sept?\)$/);
    expect(labels[3]).toContain('stats.calendarWeekAria(date=12 Oct|days=Tue 13 Oct, stats.calendarClimbs(count=6)');
    expect(labels[3]).toContain('Thu 15 Oct, stats.calendarClimbs(count=2)');
  });

  it('prints the tapped day and its count, and clears it on a second tap', () => {
    render(createElement(ActivityHeatmap, { heatmap: makeHeatmap() }));
    expect(screen.getByText('stats.calendarTapHint')).toBeTruthy();

    // 360 wide less the 32 pt weekday gutter fits all four weeks: ~80 pt cells
    // on a ~83 pt pitch, so y=100 lands in row 1, Tuesday 13 Oct.
    const lastWeek = weekButtons()[3];
    lastWeek.dataset.locationY = '100';
    fireEvent.click(lastWeek);
    expect(screen.getByText(/· stats\.calendarClimbs\(count=6\)$/)).toBeTruthy();

    fireEvent.click(lastWeek);
    expect(screen.getByText('stats.calendarTapHint')).toBeTruthy();
  });

  it('keeps the columns read-only while a screen reader is running', () => {
    screenReaderEnabled = true;
    try {
      render(createElement(ActivityHeatmap, { heatmap: makeHeatmap() }));
      const lastWeek = weekButtons()[3];
      lastWeek.dataset.locationY = '100';
      fireEvent.click(lastWeek);
      expect(screen.getByText('stats.calendarTapHint')).toBeTruthy();
    } finally {
      screenReaderEnabled = false;
    }
  });

  it('ignores taps on days that have not happened yet', () => {
    render(createElement(ActivityHeatmap, { heatmap: makeHeatmap() }));
    const lastWeek = weekButtons()[3];
    // Row 6 (Sunday 18 Oct) is after "today".
    lastWeek.dataset.locationY = String(10_000);
    fireEvent.click(lastWeek);
    expect(screen.getByText('stats.calendarTapHint')).toBeTruthy();
  });
});
