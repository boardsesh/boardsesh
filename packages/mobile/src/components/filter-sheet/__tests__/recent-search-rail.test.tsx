// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { RecentFilter } from '../../../lib/recent-filter-store';
import { DEFAULT_FILTERS } from '../../../lib/climb-filter-types';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));
// How many times each chip has drawn, by label: the memo check.
const chipRenders = vi.hoisted(() => new Map<string, number>());

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children, horizontal }: { children?: ReactNode; horizontal?: boolean }) =>
    createElement('div', { 'data-testid': 'strip', 'data-horizontal': String(horizontal) }, children),
}));

vi.mock('../../grade/GradeChip', () => ({
  GRADE_CHIP_HEIGHT: 44,
  GradeChip: ({
    label,
    tone = 'neutral',
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    label: string;
    tone?: string;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
  }) => {
    chipRenders.set(label, (chipRenders.get(label) ?? 0) + 1);
    return createElement(
      'button',
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'data-tone': tone,
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
      },
      label,
    );
  },
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

import { RecentSearchRail } from '../RecentSearchRail';

const recents: RecentFilter[] = [
  { id: 'a', label: '"crimp"', filters: DEFAULT_FILTERS, searchText: 'crimp', timestamp: 3 },
  {
    id: 'b',
    label: 'Beta only',
    filters: { ...DEFAULT_FILTERS, onlyWithBetaVideos: true },
    searchText: '',
    timestamp: 2,
  },
  { id: 'c', label: '"jugs"', filters: DEFAULT_FILTERS, searchText: 'jugs', timestamp: 1 },
];

beforeEach(() => {
  haptics.selection.mockClear();
  chipRenders.clear();
});

describe('RecentSearchRail', () => {
  it('draws one chip per saved search, in the order given, on a horizontal strip', () => {
    const { getByTestId, getAllByRole } = render(<RecentSearchRail recents={recents} onSelect={vi.fn()} />);
    expect(getByTestId('strip').getAttribute('data-horizontal')).toBe('true');
    expect(getAllByRole('button').map((chip) => chip.textContent)).toEqual(['"crimp"', 'Beta only', '"jugs"']);
    // The chip's spoken name is the search itself.
    expect(getAllByRole('button').map((chip) => chip.getAttribute('aria-label'))).toEqual([
      '"crimp"',
      'Beta only',
      '"jugs"',
    ]);
  });

  it('marks only the search in force, the way a selected grade chip is marked', () => {
    const { getAllByRole } = render(<RecentSearchRail recents={recents} currentId="b" onSelect={vi.fn()} />);
    expect(getAllByRole('button').map((chip) => [chip.getAttribute('data-tone'), chip.dataset.selected])).toEqual([
      ['neutral', 'false'],
      ['selected', 'true'],
      ['neutral', 'false'],
    ]);
  });

  it('hands the tapped search’s id on, with a selection haptic', () => {
    const onSelect = vi.fn();
    const { getByText } = render(<RecentSearchRail recents={recents} onSelect={onSelect} />);
    fireEvent.click(getByText('"jugs"'));
    fireEvent.click(getByText('"crimp"'));
    expect(onSelect.mock.calls).toEqual([['c'], ['a']]);
    expect(haptics.selection).toHaveBeenCalledTimes(2);
  });

  it('redraws only the chips whose current state changed', () => {
    const onSelect = vi.fn();
    const view = render(<RecentSearchRail recents={recents} currentId="a" onSelect={onSelect} />);
    chipRenders.clear();
    view.rerender(<RecentSearchRail recents={recents} currentId="b" onSelect={onSelect} />);
    expect(Object.fromEntries(chipRenders)).toEqual({ '"crimp"': 1, 'Beta only': 1 });
  });
});
