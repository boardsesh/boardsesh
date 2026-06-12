// @vitest-environment jsdom
import { createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import { ClimbFilterSheet } from '../ClimbFilterSheet';

type PressableProps = {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  disabled?: boolean;
};

type BottomSheetModalHandle = {
  present: () => void;
  dismiss: () => void;
};

const bottomSheetModalProps = vi.hoisted(() => ({
  latest: null as null | {
    enablePanDownToClose?: boolean;
    enableContentPanningGesture?: boolean;
    enableHandlePanningGesture?: boolean;
    onDismiss?: () => void;
  },
}));

const createBoardHoldsMocks = vi.hoisted(() => ({
  parseSetIdsParam: vi.fn((setIds: string) => setIds.split(',').map(Number).filter(Number.isFinite)),
  prewarmCreateBoardHolds: vi.fn(),
}));

const currentFilters: ClimbFilters = {
  sortBy: 'popular',
  sortOrder: 'desc',
  status: 'any',
  setter: ['draft-setter'],
};

const currentBoardFilters: ClimbBoardFilterState = {
  holdsFilter: { '42': { HAND: 'include' } },
  zoneBox: { edgeLeft: 10, edgeRight: 90, edgeBottom: 20, edgeTop: 80 },
  zoneMode: 'allHolds',
};

const boardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole, disabled }: PressableProps) => {
    const renderedChildren = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        'aria-label': accessibilityLabel,
        'data-role': accessibilityRole,
        disabled,
      },
      renderedChildren,
    );
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModal: forwardRef<BottomSheetModalHandle, { children?: ReactNode }>(function BottomSheetModal(
    { children, ...props },
    ref,
  ) {
    bottomSheetModalProps.latest = props;
    useImperativeHandle(ref, () => ({ present: vi.fn(), dismiss: vi.fn() }), []);
    return createElement('div', null, children);
  }),
  BottomSheetBackdrop: () => null,
  BottomSheetScrollView: forwardRef<unknown, { children?: ReactNode }>(function BottomSheetScrollView(
    { children },
    ref,
  ) {
    useImperativeHandle(ref, () => ({}), []);
    return createElement('div', null, children);
  }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (styleFactory: () => Record<string, unknown>) => styleFactory(),
  withSpring: (value: number) => value,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: { count?: number }) => `${key}${params?.count ?? ''}` }),
}));

vi.mock('@boardsesh/climb-filters', () => ({
  SORT_OPTIONS: ['popular', 'difficulty'],
  GRADE_ACCURACY_VALUES: ['0', '0.2', '0.1', '0.05'],
  DEFAULT_CLIMB_FILTER_STATE: {
    sortBy: 'popular',
    sortOrder: 'desc',
    status: 'any',
  },
  DEFAULT_CLIMB_BOARD_FILTER_STATE: {},
  hasActiveClimbFilters: () => false,
  hasActiveBoardFilters: () => false,
  applyStatusChange: (_filters: unknown, status: string) => ({ status }),
  normalizeRetiredStatus: (filters: unknown) => filters,
  climbTypeOf: (filters: { boulders?: boolean; routes?: boolean }) => {
    if (filters.boulders === true && filters.routes !== true) return 'boulders';
    if (filters.routes === true && filters.boulders !== true) return 'routes';
    return 'all';
  },
  climbTypePatch: (type: 'all' | 'boulders' | 'routes') =>
    type === 'boulders'
      ? { boulders: true, routes: false }
      : type === 'routes'
        ? { boulders: false, routes: true }
        : { boulders: undefined, routes: undefined },
  toClimbSearchInput: () => ({}),
  mergeBoardFilters: (input: unknown) => input,
  formatMinAscentsFilterCount: (count: number) => String(count),
  countFilteredHolds: (holdsFilter?: Record<string, unknown>) => Object.keys(holdsFilter ?? {}).length,
}));

vi.mock('../../lib/graphql/hooks', () => ({
  useGrades: () => ({ data: [] }),
  useSearchClimbsCount: () => ({ data: 12 }),
}));

vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('../../lib/create-board-holds', () => ({
  parseSetIdsParam: createBoardHoldsMocks.parseSetIdsParam,
  prewarmCreateBoardHolds: createBoardHoldsMocks.prewarmCreateBoardHolds,
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      fill: '#eee',
      tertiaryBackground: '#fff',
      separator: '#ccc',
      secondaryLabel: '#777',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../theme/ios-colors', () => ({
  iosSystemColors: {
    white: '#fff',
    separator: '#ccc',
    systemGray: '#999',
    systemGray4: '#aaa',
  },
}));
vi.mock('../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12 },
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../GlassSheetBackground', () => ({ GlassSheetBackground: () => null }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
  }: {
    options: Array<{ key: string; label: string }>;
    selectedKey: string;
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'segmented-control', 'data-selected': selectedKey },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            onClick: () => onSelect(option.key),
            'aria-pressed': selectedKey === option.key,
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../StarRating', () => ({ StarRating: () => null }));
vi.mock('../CollapsibleSection', () => ({
  CollapsibleSection: ({
    children,
    title,
    defaultExpanded = false,
    onExpandedChange,
  }: {
    children?: ReactNode;
    title: string;
    defaultExpanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
  }) => {
    const [expanded, setExpanded] = useState(defaultExpanded);
    return createElement(
      'section',
      { 'data-testid': `section-${title}`, 'data-expanded': String(expanded) },
      createElement(
        'button',
        {
          onClick: () => {
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            onExpandedChange?.(nextExpanded);
          },
        },
        `expand-${title}`,
      ),
      children,
    );
  },
}));
vi.mock('../RadioGroup', () => ({ RadioGroup: () => null }));
vi.mock('../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../grade', () => ({ GradeRangeRail: () => null }));
vi.mock('../search/SettersFilterSheet', () => ({
  SettersFilterSheet: ({
    visible,
    onSelectedSettersChange,
    onClose,
    onDismiss,
  }: {
    visible: boolean;
    onSelectedSettersChange: (selectedSetters: string[]) => void;
    onClose: () => void;
    onDismiss: () => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'setters-filter-sheet', 'data-visible': String(visible) },
      createElement('button', { onClick: () => onSelectedSettersChange(['stacked-setter']) }, 'setters-change'),
      createElement('button', { onClick: onClose }, 'setters-close'),
      createElement('button', { onClick: onDismiss }, 'setters-dismiss'),
    ),
}));
vi.mock('../search/HoldFilterEditorSheet', () => ({
  HoldFilterEditorSheet: ({
    visible,
    onHoldsFilterChange,
    onClose,
    onDismiss,
  }: {
    visible: boolean;
    onHoldsFilterChange: (holdsFilter: HoldsFilter) => void;
    onClose: () => void;
    onDismiss: () => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'hold-filter-editor-sheet', 'data-visible': String(visible) },
      createElement('button', { onClick: () => onHoldsFilterChange({ '99': { HAND: 'include' } }) }, 'holds-change'),
      createElement('button', { onClick: onClose }, 'holds-close'),
      createElement('button', { onClick: onDismiss }, 'holds-dismiss'),
    ),
}));
vi.mock('../search/ZoneFilterEditorSheet', () => ({
  ZoneFilterEditorSheet: ({
    visible,
    onZoneFilterChange,
    onClose,
    onDismiss,
  }: {
    visible: boolean;
    onZoneFilterChange: (selection: {
      zoneBox: ZoneBoxInput | null;
      zoneMode: ZoneMatchMode;
      holdsFilter?: HoldsFilter;
    }) => void;
    onClose: () => void;
    onDismiss: () => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'zone-filter-editor-sheet', 'data-visible': String(visible) },
      createElement(
        'button',
        {
          onClick: () =>
            onZoneFilterChange({
              zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
              zoneMode: 'allHolds',
              holdsFilter: { '77': { FOOT: 'include' } },
            }),
        },
        'zone-change',
      ),
      createElement('button', { onClick: onClose }, 'zone-close'),
      createElement('button', { onClick: onDismiss }, 'zone-dismiss'),
    ),
}));

function renderFilterSheet(overrides: Partial<Parameters<typeof ClimbFilterSheet>[0]> = {}) {
  const props: Parameters<typeof ClimbFilterSheet>[0] = {
    onDismiss: vi.fn(),
    boardConfig,
    currentFilters,
    currentBoardFilters,
    searchName: '',
    onApply: vi.fn(),
    ...overrides,
  };

  return { ...render(<ClimbFilterSheet {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  bottomSheetModalProps.latest = null;
});

describe('ClimbFilterSheet child filters', () => {
  it('prewarms board holds when Refine expands', () => {
    vi.useFakeTimers();
    try {
      const { getByText } = renderFilterSheet();

      fireEvent.click(getByText('expand-mobile.filter.section.refine'));

      act(() => {
        vi.advanceTimersByTime(149);
      });
      expect(createBoardHoldsMocks.prewarmCreateBoardHolds).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(createBoardHoldsMocks.parseSetIdsParam).toHaveBeenCalledWith('1,2');
      expect(createBoardHoldsMocks.prewarmCreateBoardHolds).toHaveBeenCalledWith({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: [1, 2],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies climb type changes from the segmented control', () => {
    const onApply = vi.fn();
    const { getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByText('mobile.filter.climbType.routes'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith({ ...currentFilters, boulders: false, routes: true }, currentBoardFilters);
  });

  it('opens the setters sheet above the filter sheet and keeps draft edits local until Apply', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByTestId, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.filter.setters'));

    expect(getByTestId('setters-filter-sheet').getAttribute('data-visible')).toBe('true');
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(false);
    expect(bottomSheetModalProps.latest?.enableContentPanningGesture).toBe(false);
    expect(bottomSheetModalProps.latest?.enableHandlePanningGesture).toBe(false);

    fireEvent.click(getByText('setters-change'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith({ ...currentFilters, setter: ['stacked-setter'] }, currentBoardFilters);
  });

  it('keeps local draft edits when parent filter props change while open', () => {
    const onApply = vi.fn();
    const rendered = renderFilterSheet({ onApply });

    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    fireEvent.click(rendered.getByText('setters-change'));

    rendered.rerender(
      <ClimbFilterSheet
        {...rendered.props}
        currentFilters={{ ...currentFilters, setter: ['parent-update'] }}
        currentBoardFilters={{ ...currentBoardFilters, onlyBenchmarks: true }}
      />,
    );
    fireEvent.click(rendered.getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith({ ...currentFilters, setter: ['stacked-setter'] }, currentBoardFilters);
  });

  it('syncs parent filters again after dismissing without Apply', () => {
    const onApply = vi.fn();
    const rendered = renderFilterSheet({ onApply });

    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    fireEvent.click(rendered.getByText('setters-change'));

    bottomSheetModalProps.latest?.onDismiss?.();
    rendered.rerender(
      <ClimbFilterSheet
        {...rendered.props}
        currentFilters={{ ...currentFilters, setter: ['parent-update'] }}
        currentBoardFilters={{ ...currentBoardFilters, onlyBenchmarks: true }}
      />,
    );
    fireEvent.click(rendered.getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith(
      { ...currentFilters, setter: ['parent-update'] },
      { ...currentBoardFilters, onlyBenchmarks: true },
    );
  });

  it('syncs parent filters again after Reset then dismiss without Apply', () => {
    const onApply = vi.fn();
    const rendered = renderFilterSheet({ onApply });

    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    fireEvent.click(rendered.getByText('setters-change'));
    fireEvent.click(rendered.getByText('mobile.filter.reset'));

    bottomSheetModalProps.latest?.onDismiss?.();
    rendered.rerender(
      <ClimbFilterSheet
        {...rendered.props}
        currentFilters={{ ...currentFilters, setter: ['parent-update'] }}
        currentBoardFilters={{ ...currentBoardFilters, onlyBenchmarks: true }}
      />,
    );
    fireEvent.click(rendered.getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith(
      { ...currentFilters, setter: ['parent-update'] },
      { ...currentBoardFilters, onlyBenchmarks: true },
    );
  });

  it('opens the hold editor sheet above the filter sheet', () => {
    const { getByLabelText, getByTestId } = renderFilterSheet();

    fireEvent.click(getByLabelText('mobile.holdFilter.title'));

    expect(getByTestId('hold-filter-editor-sheet').getAttribute('data-visible')).toBe('true');
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(false);
  });

  it('applies hold filter changes from the hold editor child sheet', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.holdFilter.title'));
    fireEvent.click(getByText('holds-change'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith(currentFilters, {
      ...currentBoardFilters,
      holdsFilter: { '99': { HAND: 'include' } },
    });
  });

  it('opens the zone editor sheet above the filter sheet', () => {
    const { getByLabelText, getByTestId } = renderFilterSheet();

    fireEvent.click(getByLabelText('mobile.zoneFilter.title'));

    expect(getByTestId('zone-filter-editor-sheet').getAttribute('data-visible')).toBe('true');
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(false);
  });

  it('applies zone and pruned hold filter changes from the zone editor child sheet', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.zoneFilter.title'));
    fireEvent.click(getByText('zone-change'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith(currentFilters, {
      holdsFilter: { '77': { FOOT: 'include' } },
      zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
      zoneMode: 'allHolds',
    });
  });

  it('re-enables parent sheet gestures when a child sheet closes', () => {
    const { getByLabelText, getByTestId, getByText } = renderFilterSheet();

    fireEvent.click(getByLabelText('mobile.filter.setters'));

    expect(getByTestId('setters-filter-sheet').getAttribute('data-visible')).toBe('true');
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(false);
    expect(bottomSheetModalProps.latest?.enableContentPanningGesture).toBe(false);
    expect(bottomSheetModalProps.latest?.enableHandlePanningGesture).toBe(false);

    fireEvent.click(getByText('setters-close'));

    expect(getByTestId('setters-filter-sheet').getAttribute('data-visible')).toBe('false');
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(true);
    expect(bottomSheetModalProps.latest?.enableContentPanningGesture).toBe(true);
    expect(bottomSheetModalProps.latest?.enableHandlePanningGesture).toBe(true);
  });

  it('keeps Refine expanded after a child sheet closes', () => {
    const { getByLabelText, getByTestId, getByText } = renderFilterSheet();

    fireEvent.click(getByText('expand-mobile.filter.section.refine'));
    expect(getByTestId('section-mobile.filter.section.refine').getAttribute('data-expanded')).toBe('true');

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    fireEvent.click(getByText('setters-close'));

    expect(getByTestId('section-mobile.filter.section.refine').getAttribute('data-expanded')).toBe('true');
  });

  it('re-enables parent sheet gestures when a child sheet dismisses', () => {
    const { getByLabelText, queryByTestId, getByText } = renderFilterSheet();

    fireEvent.click(getByLabelText('mobile.filter.setters'));

    expect(queryByTestId('setters-filter-sheet')?.getAttribute('data-visible')).toBe('true');
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(false);

    fireEvent.click(getByText('setters-dismiss'));

    expect(queryByTestId('setters-filter-sheet')).toBeNull();
    expect(bottomSheetModalProps.latest?.enablePanDownToClose).toBe(true);
    expect(bottomSheetModalProps.latest?.enableContentPanningGesture).toBe(true);
    expect(bottomSheetModalProps.latest?.enableHandlePanningGesture).toBe(true);
  });
});
