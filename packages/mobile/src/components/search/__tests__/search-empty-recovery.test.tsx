// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterToken } from '../../../lib/filter-tokens';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, radii: { button: 12 } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { filter?: string; filters?: string; board?: string; angle?: number }) => {
      if (key === 'mobile.search.removeFilterAria') return `Remove ${options?.filter}`;
      if (key === 'mobile.emptyState.recovery.scope') return `${options?.board} · ${options?.angle}°`;
      if (key === 'mobile.emptyState.recovery.filters') return `Active filters: ${options?.filters}`;
      return key;
    },
  }),
}));

import { SearchEmptyRecovery } from '../SearchEmptyRecovery';

afterEach(cleanup);

const token = (key: string, label: string): FilterToken => ({ key, label, clear: vi.fn() });
const unlocked = { tall: false, wide: false };

describe('SearchEmptyRecovery', () => {
  it('shows the scope and active restrictions; pressing one action clears only its restriction', () => {
    const grade = token('grade', 'V4–V6');
    const setter = token('setter', 'By Sam');
    const openFilters = vi.fn();
    const { getByText, getByRole } = render(
      <SearchEmptyRecovery
        query="Moonage"
        boardName="Kilter Homewall"
        angle={40}
        tokens={[grade, setter]}
        lockedDimensions={unlocked}
        onOpenFilters={openFilters}
      />,
    );

    expect(getByText('Kilter Homewall · 40°')).toBeTruthy();
    expect(getByText('Active filters: V4–V6 · By Sam')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Remove V4–V6' }));
    expect(grade.clear).toHaveBeenCalledOnce();
    expect(setter.clear).not.toHaveBeenCalled();
    expect(openFilters).not.toHaveBeenCalled();
  });

  it('keeps ordering, angle intent, climb type and enforced dimensions out of recovery actions', () => {
    const tokens = [
      token('sort', 'Quality'),
      token('otherAngles', 'Other angles'),
      token('climbType', 'Routes only'),
      token('tall', 'Tall climbs'),
      token('wide', 'Wide climbs'),
      token('benchmark', 'Benchmarks'),
    ];
    const { getAllByRole, getByRole, getByText, rerender } = render(
      <SearchEmptyRecovery
        query="Moonage"
        boardName="Tension"
        angle={30}
        tokens={tokens}
        lockedDimensions={{ tall: true, wide: true }}
        onOpenFilters={vi.fn()}
      />,
    );

    expect(
      getByText('Active filters: Quality · Other angles · Routes only · Tall climbs · Wide climbs · Benchmarks'),
    ).toBeTruthy();
    expect(getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Remove Benchmarks',
      'mobile.emptyState.recovery.openFilters',
    ]);
    fireEvent.click(getByRole('button', { name: 'Remove Benchmarks' }));
    for (const restricted of tokens.slice(0, -1)) expect(restricted.clear).not.toHaveBeenCalled();

    rerender(
      <SearchEmptyRecovery
        query="Moonage"
        boardName="Tension"
        angle={30}
        tokens={tokens}
        lockedDimensions={unlocked}
        onOpenFilters={vi.fn()}
      />,
    );
    expect(getByRole('button', { name: 'Remove Tall climbs' })).toBeTruthy();
    expect(getByRole('button', { name: 'Remove Wide climbs' })).toBeTruthy();
  });

  it.each(['Moonage', ''])('always opens Filters when there is no restriction to remove, query=%s', (query) => {
    const openFilters = vi.fn();
    const { getByRole, getAllByRole } = render(
      <SearchEmptyRecovery
        query={query}
        boardName="MoonBoard"
        angle={40}
        tokens={[]}
        lockedDimensions={unlocked}
        onOpenFilters={openFilters}
      />,
    );

    expect(getAllByRole('button')).toHaveLength(1);
    fireEvent.click(getByRole('button', { name: 'mobile.emptyState.recovery.openFilters' }));
    expect(openFilters).toHaveBeenCalledOnce();
  });
});
