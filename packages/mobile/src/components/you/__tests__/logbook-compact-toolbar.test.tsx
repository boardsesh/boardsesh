// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS } from '@boardsesh/logbook';
import type { AppMenuAction } from '../../AppMenu';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (label: string) => label }),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    label,
    actions,
    onSelectIndex,
  }: {
    label: string;
    actions: AppMenuAction[];
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'sort-menu' },
      label,
      actions.map((action, index) =>
        createElement(
          'button',
          { key: action.label, 'aria-pressed': action.selected, onClick: () => onSelectIndex(index) },
          action.label,
        ),
      ),
    ),
}));
vi.mock('../../search/FilterButton', () => ({
  FILTER_FAB_SIZE: 48,
  FilterButton: ({ activeFilterCount, onPress }: { activeFilterCount: number; onPress: () => void }) =>
    createElement('button', { 'data-testid': 'filters', 'data-count': activeFilterCount, onClick: onPress }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../GlassSurface', () => ({ GlassSurface: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));

import { LogbookCompactToolbar } from '../LogbookCompactToolbar';

function props() {
  return {
    search: createElement('input', { 'aria-label': 'Search climbs' }),
    fontScale: 1,
    availableWidth: 343,
    sortPreset: 'recent' as const,
    onSelectPreset: vi.fn(),
    onOpenFilters: vi.fn(),
    filters: DEFAULT_LOGBOOK_FILTERS,
    grades: [],
    activeFilterCount: 0,
    onUpdateFilters: vi.fn(),
  };
}
afterEach(cleanup);

describe('compact Logbook controls', () => {
  it('shows one selected order and filters without inactive summaries', () => {
    const toolbarProps = props();
    const { getByRole, getByTestId, queryByTestId } = render(<LogbookCompactToolbar {...toolbarProps} />);
    expect(getByRole('button', { name: 'mobile.logbook.preset.latest' }).getAttribute('aria-pressed')).toBe('true');
    expect(queryByTestId('logbook-active-filters')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'mobile.logbook.preset.hardest' }));
    expect(toolbarProps.onSelectPreset).toHaveBeenCalledExactlyOnceWith('hardest');
    fireEvent.click(getByTestId('filters'));
    expect(toolbarProps.onOpenFilters).toHaveBeenCalledOnce();
  });

  it('labels custom order honestly without selecting a preset', () => {
    const { getByTestId, getAllByRole } = render(<LogbookCompactToolbar {...props()} sortPreset={null} />);
    expect(getByTestId('sort-menu').textContent).toContain('mobile.logbook.customSort');
    expect(getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  });

  it('shows applied restrictions and clears each facet without changing other filters', () => {
    const toolbarProps = props();
    const { getByRole, getByTestId } = render(
      <LogbookCompactToolbar
        {...toolbarProps}
        activeFilterCount={6}
        filters={{
          ...DEFAULT_LOGBOOK_FILTERS,
          minGrade: 10,
          angleRange: [20, 40],
          fromDate: '2026-09-01',
          includeAttempts: false,
          flashOnly: true,
          benchmarkOnly: true,
        }}
      />,
    );
    expect(getByTestId('filters').getAttribute('data-count')).toBe('6');
    fireEvent.click(getByRole('button', { name: 'actions.clear: mobile.logbook.grade' }));
    expect(toolbarProps.onUpdateFilters).toHaveBeenLastCalledWith({ minGrade: '', maxGrade: '' });
    fireEvent.click(getByRole('button', { name: 'actions.clear: 20°–40°' }));
    expect(toolbarProps.onUpdateFilters).toHaveBeenLastCalledWith({ angleRange: DEFAULT_LOGBOOK_FILTERS.angleRange });
    fireEvent.click(getByRole('button', { name: /actions.clear: mobile.logbook.status.sends/ }));
    expect(toolbarProps.onUpdateFilters).toHaveBeenLastCalledWith({
      includeSends: true,
      includeAttempts: true,
      flashOnly: false,
      benchmarkOnly: false,
    });
    fireEvent.click(getByRole('button', { name: /actions.clear: mobile.logbook.dateSince/ }));
    expect(toolbarProps.onUpdateFilters).toHaveBeenLastCalledWith({ fromDate: '', toDate: '' });
  });
});
