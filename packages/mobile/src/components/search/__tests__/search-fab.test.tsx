// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type RefObject } from 'react';
import type { ClimbBoardFilterState, GradeBound } from '@boardsesh/climb-filters';
import type { SearchHeaderHandle } from '../../SearchHeader';
import type { ClimbFilters } from '../../../lib/climb-filter-types';

const haptics = vi.hoisted(() => ({ light: vi.fn(), selection: vi.fn() }));
const signal = vi.hoisted(() => ({ setSearchExpanded: vi.fn() }));

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-scrim': 'true' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedKeyboard: () => ({ height: { value: 0 } }),
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../../theme/layout', () => ({ TOOLBAR_FAB_SIZE: 56, TOOLBAR_SIDE_MARGIN: 16 }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light, hapticSelection: haptics.selection }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../../lib/search-expanded-state', () => ({ setSearchExpanded: signal.setSearchExpanded }));

vi.mock('../../SearchHeader', () => ({
  SearchHeader: forwardRef<unknown, { placeholder?: string }>(function SearchHeaderMock(props) {
    return createElement('div', { 'data-search-field': 'true', 'data-placeholder': props.placeholder });
  }),
}));

type FabMockProps = {
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  badgeCount?: number;
  active?: boolean;
  iconName?: string;
};
vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({ onPress, accessibilityLabel, accessibilityHint, badgeCount, active, iconName }: FabMockProps) =>
    createElement('button', {
      onClick: onPress,
      'data-fab': iconName,
      'data-label': accessibilityLabel,
      'data-hint': accessibilityHint ?? '',
      'data-badge': badgeCount == null ? '' : String(badgeCount),
      'data-active': active ? 'true' : 'false',
    }),
}));

vi.mock('../GradePill', () => ({ GradePill: () => createElement('div', { 'data-gradepill': 'true' }) }));
vi.mock('../FilterButton', () => ({ FilterButton: () => createElement('div', { 'data-filterbutton': 'true' }) }));
vi.mock('../ActiveFilterChips', () => ({
  ActiveFilterChips: () => createElement('div', { 'data-active-chips': 'true' }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));

import { SearchFab } from '../SearchFab';

function makeProps(over: Partial<Parameters<typeof SearchFab>[0]> = {}) {
  return {
    searchFieldRef: { current: null } as RefObject<SearchHeaderHandle | null>,
    searchInitialValue: '',
    searchPlaceholder: 'Search climbs',
    onSearchChange: vi.fn(),
    onSearchSubmit: vi.fn(),
    onSearchFocus: vi.fn(),
    onSearchBlur: vi.fn(),
    bound: {} as GradeBound,
    grades: [],
    filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any' } as ClimbFilters,
    boardFilters: {} as ClimbBoardFilterState,
    count: undefined,
    activeFilterCount: 0,
    onOpenGrade: vi.fn(),
    onOpenFilters: vi.fn(),
    onPatchFilters: vi.fn(),
    onPatchBoardFilters: vi.fn(),
    toolbarBottom: 100,
    ...over,
  };
}

const fab = (root: HTMLElement) => root.querySelector('[data-fab="search"]') as HTMLButtonElement;

describe('SearchFab', () => {
  beforeEach(() => {
    haptics.light.mockClear();
    signal.setSearchExpanded.mockClear();
  });

  it('starts collapsed: a search FAB carrying the filter-count badge + a11y hint, no field, no scrim', () => {
    const { container } = render(<SearchFab {...makeProps({ activeFilterCount: 2 })} />);
    const searchFab = fab(container);
    expect(searchFab).not.toBeNull();
    expect(searchFab.getAttribute('data-active')).toBe('false');
    expect(searchFab.getAttribute('data-badge')).toBe('2');
    expect(searchFab.getAttribute('data-hint')).not.toBe('');
    expect(container.querySelector('[data-search-field]')).toBeNull();
    expect(container.querySelector('[data-scrim]')).toBeNull();
  });

  it('expands on FAB press: reveals the field + signals setSearchExpanded(true)', () => {
    const { container } = render(<SearchFab {...makeProps()} />);
    fireEvent.click(fab(container));
    expect(signal.setSearchExpanded).toHaveBeenLastCalledWith(true);
    expect(haptics.light).toHaveBeenCalled();
    expect(container.querySelector('[data-search-field]')).not.toBeNull();
    expect(container.querySelector('[data-scrim]')).not.toBeNull();
    expect(fab(container).getAttribute('data-active')).toBe('true');
  });

  it('collapses on a second FAB press: hides the field + signals setSearchExpanded(false)', () => {
    const { container } = render(<SearchFab {...makeProps()} />);
    fireEvent.click(fab(container));
    fireEvent.click(fab(container));
    expect(signal.setSearchExpanded).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('[data-search-field]')).toBeNull();
  });

  it('drops the badge once expanded (the filter button carries the count there)', () => {
    const { container } = render(<SearchFab {...makeProps({ activeFilterCount: 4 })} />);
    expect(fab(container).getAttribute('data-badge')).toBe('4');
    fireEvent.click(fab(container));
    expect(fab(container).getAttribute('data-badge')).toBe('');
  });

  it('shows the live count and active chips while expanded and idle', () => {
    const { container } = render(<SearchFab {...makeProps({ activeFilterCount: 2, count: 42 })} />);
    fireEvent.click(fab(container));
    expect(container.textContent).toContain('mobile.search.climbsCount');
    expect(container.querySelector('[data-active-chips]')).not.toBeNull();
  });
});
