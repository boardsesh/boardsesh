// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { PeriodComparisonMode, RawPeriodComparison } from '@boardsesh/profile-stats';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', secondaryLabel: '#666', tertiaryLabel: '#999' },
    brandColors: { success: '#0a0', error: '#a00' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color ?? '' }, children),
}));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-card': 'true' }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-icon-color': color ?? '' }),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
  }: {
    options: Array<{ key: PeriodComparisonMode; label: string }>;
    selectedKey: PeriodComparisonMode;
    onSelect: (key: PeriodComparisonMode) => void;
  }) =>
    createElement(
      'div',
      { 'data-segmented': 'true', 'data-selected': selectedKey },
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, onClick: () => onSelect(option.key), 'data-option': option.key },
          option.label,
        ),
      ),
    ),
}));

import { PeriodComparisonCard } from '../PeriodComparisonCard';

function makeComparison(overrides: Partial<RawPeriodComparison> = {}): RawPeriodComparison {
  return {
    mode: 'trailing',
    current: { sends: 5, flashes: 2, startDate: '2024-06-08', endDate: '2024-06-15' },
    previous: { sends: 3, flashes: 1, startDate: '2024-06-01', endDate: '2024-06-08' },
    sendsDelta: 2,
    sendsPercentChange: 66.66,
    ...overrides,
  };
}

describe('PeriodComparisonCard', () => {
  it('renders nothing when periodComparison is null (timeframe not eligible)', () => {
    const { container } = render(
      createElement(PeriodComparisonCard, {
        periodComparison: null,
        comparisonMode: 'trailing',
        onComparisonModeChange: vi.fn(),
      }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the current sends count and a positive percent delta', () => {
    const { getByText } = render(
      createElement(PeriodComparisonCard, {
        periodComparison: makeComparison(),
        comparisonMode: 'trailing',
        onComparisonModeChange: vi.fn(),
      }),
    );
    expect(getByText('5')).toBeTruthy();
    expect(getByText('+67%')).toBeTruthy();
    expect(getByText('stats.periodComparison.vsTrailing')).toBeTruthy();
  });

  it('renders a negative percent delta without an up chevron', () => {
    const { getByText, queryByText } = render(
      createElement(PeriodComparisonCard, {
        periodComparison: makeComparison({
          current: { sends: 1, flashes: 0, startDate: '2024-06-08', endDate: '2024-06-15' },
          sendsDelta: -2,
          sendsPercentChange: -66.66,
        }),
        comparisonMode: 'yearOverYear',
        onComparisonModeChange: vi.fn(),
      }),
    );
    expect(getByText('-67%')).toBeTruthy();
    expect(getByText('stats.periodComparison.vsYearOverYear')).toBeTruthy();
    expect(queryByText('chevron.up')).toBeNull();
  });

  it('shows a "first period" message instead of a broken percent when the previous period has zero sends', () => {
    const { getByText, queryByText } = render(
      createElement(PeriodComparisonCard, {
        periodComparison: makeComparison({
          previous: { sends: 0, flashes: 0, startDate: '2024-06-01', endDate: '2024-06-08' },
          sendsDelta: 5,
          sendsPercentChange: null,
        }),
        comparisonMode: 'trailing',
        onComparisonModeChange: vi.fn(),
      }),
    );
    expect(getByText('stats.periodComparison.firstPeriod')).toBeTruthy();
    expect(queryByText(/%/)).toBeNull();
  });

  it('shows a "no comparison data" message when neither period has sends', () => {
    const { getByText } = render(
      createElement(PeriodComparisonCard, {
        periodComparison: makeComparison({
          current: { sends: 0, flashes: 0, startDate: '2024-06-08', endDate: '2024-06-15' },
          previous: { sends: 0, flashes: 0, startDate: '2024-06-01', endDate: '2024-06-08' },
          sendsDelta: 0,
          sendsPercentChange: null,
        }),
        comparisonMode: 'trailing',
        onComparisonModeChange: vi.fn(),
      }),
    );
    expect(getByText('stats.periodComparison.noComparisonData')).toBeTruthy();
  });

  it('forwards mode selection from the segmented control', () => {
    const onComparisonModeChange = vi.fn();
    const { getByRole } = render(
      createElement(PeriodComparisonCard, {
        periodComparison: makeComparison(),
        comparisonMode: 'trailing',
        onComparisonModeChange,
      }),
    );
    fireEvent.click(getByRole('button', { name: 'stats.periodComparison.yearOverYear' }));
    expect(onComparisonModeChange).toHaveBeenCalledWith('yearOverYear');
  });
});
