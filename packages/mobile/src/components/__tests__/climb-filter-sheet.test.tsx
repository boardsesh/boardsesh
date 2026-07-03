// @vitest-environment jsdom
import { createElement, forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import { ClimbFilterSheet } from '../ClimbFilterSheet';
import { emitSetterFilterSelection } from '../../lib/setter-filter-handoff';
import { hapticSelection } from '../../lib/haptics';
import { emitHoldsFilterSelection } from '../../lib/hold-filter-handoff';
import { emitZoneFilterSelection } from '../../lib/zone-filter-handoff';

type StyleProp = Record<string, unknown> | unknown[] | ((state: { pressed: boolean }) => unknown) | undefined;

type PressableProps = {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  disabled?: boolean;
  style?: StyleProp;
};

// Serialize a style prop (array | object | style-returning fn) so a test can
// assert the resting (unpressed) style applied to a row.
function resolveStyle(style: StyleProp): string {
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
  return JSON.stringify(resolved);
}

type BottomSheetModalHandle = {
  present: () => void;
  dismiss: () => void;
};

const bottomSheetModalProps = vi.hoisted(() => ({
  latest: null as null | {
    enablePanDownToClose?: boolean;
    onChange?: (index: number) => void;
  },
  // Incremented once per host mount. The suspend → resume cycle bumps the sheet's
  // `key`, so a remount (mountCount going 1 → 2) proves the host is torn down and
  // rebuilt — the fresh-first-present that fixes #3330.
  mountCount: 0,
}));

// Captures the controlled `open` the sheet hands the coordinator, so tests can
// assert the sheet suspends (open:false) on push and re-presents (open:true) on
// focus restore.
const managedSheetProps = vi.hoisted(() => ({
  latest: null as null | { open?: boolean },
}));

// Captures the scroll handlers + the ref's scrollTo, so tests can drive scroll
// offsets around a suspend/resume cycle and assert the post-remount restore.
const bottomSheetScrollViewProps = vi.hoisted(() => ({
  latest: null as null | {
    onScroll?: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
    onContentSizeChange?: () => void;
  },
  scrollTo: vi.fn(),
}));

// expo-router stand-ins: a push spy and a holder for the focus callback so a test
// can simulate the climbs screen regaining focus after a sub-route pops.
const routerPush = vi.hoisted(() => vi.fn());
const focusEffectHolder = vi.hoisted(() => ({ cb: null as null | (() => void) }));

// Drives the Reset button's enabled state (`anyActive`); default inactive.
const filterActivityMocks = vi.hoisted(() => ({
  hasActiveClimbFilters: vi.fn(() => false),
  hasActiveBoardFilters: vi.fn(() => false),
}));

const createBoardHoldsMocks = vi.hoisted(() => ({
  parseSetIdsParam: vi.fn((setIds: string) => setIds.split(',').map(Number).filter(Number.isFinite)),
  prewarmCreateBoardHolds: vi.fn(),
}));

const currentFilters: ClimbFilters = {
  sortBy: 'popular',
  sortOrder: 'desc',
  status: 'any',
  boulders: true,
  routes: false,
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
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole, disabled, style }: PressableProps) => {
    const renderedChildren = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        'aria-label': accessibilityLabel,
        'data-role': accessibilityRole,
        'data-style': resolveStyle(style),
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

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useFocusEffect: (cb: () => void) => {
    focusEffectHolder.cb = cb;
  },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef<BottomSheetModalHandle, { children?: ReactNode }>(function BottomSheetModal(
    { children, ...props },
    ref,
  ) {
    bottomSheetModalProps.latest = props;
    useImperativeHandle(ref, () => ({ present: vi.fn(), dismiss: vi.fn() }), []);
    useEffect(() => {
      bottomSheetModalProps.mountCount += 1;
    }, []);
    return createElement('div', null, children);
  }),
  BottomSheetScrollView: forwardRef<
    unknown,
    {
      children?: ReactNode;
      onScroll?: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
      onContentSizeChange?: () => void;
    }
  >(function BottomSheetScrollView({ children, onScroll, onContentSizeChange }, ref) {
    bottomSheetScrollViewProps.latest = { onScroll, onContentSizeChange };
    useImperativeHandle(ref, () => ({ scrollTo: bottomSheetScrollViewProps.scrollTo }), []);
    return createElement('div', null, children);
  }),
}));

// Isolate the sheet from the presentation coordinator (its serialization is
// covered by sheet-presentation-provider.test.tsx). The mock mirrors only the
// user-close path (onChange(-1) → onClose) and captures the controlled `open`.
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: (opts: { open?: boolean; onClose?: () => void }) => {
    managedSheetProps.latest = opts;
    return {
      onChange: (index: number) => {
        if (index === -1) opts.onClose?.();
      },
      onFullyDismissed: () => {},
      handle: {
        present: () => {},
        dismiss: () => {},
        close: () => {},
        forceClose: () => {},
        snapToIndex: () => {},
        snapToPosition: () => {},
        expand: () => {},
        collapse: () => {},
      },
    };
  },
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
    boulders: true,
    routes: false,
  },
  DEFAULT_CLIMB_BOARD_FILTER_STATE: {},
  hasActiveClimbFilters: filterActivityMocks.hasActiveClimbFilters,
  hasActiveBoardFilters: filterActivityMocks.hasActiveBoardFilters,
  applyStatusChange: (_filters: unknown, status: string) => ({ status }),
  normalizeRetiredStatus: (filters: unknown) => filters,
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
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../SegmentedControl', () => ({ SegmentedControl: () => null }));
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

// Simulate the climbs screen regaining focus after a sub-picker route pops.
function simulateScreenRefocus() {
  act(() => {
    focusEffectHolder.cb?.();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => false);
  filterActivityMocks.hasActiveBoardFilters.mockImplementation(() => false);
  bottomSheetModalProps.latest = null;
  bottomSheetModalProps.mountCount = 0;
  bottomSheetScrollViewProps.latest = null;
  managedSheetProps.latest = null;
  focusEffectHolder.cb = null;
});

describe('ClimbFilterSheet sub-pickers', () => {
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

  it('pushes the setters route with the current selection and suspends the sheet', () => {
    const { getByLabelText } = renderFilterSheet();

    fireEvent.click(getByLabelText('mobile.filter.setters'));

    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/setters',
      params: {
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
        setters: JSON.stringify(['draft-setter']),
      },
    });
    expect(managedSheetProps.latest?.open).toBe(false);
  });

  it('merges the setters handed back from the route, re-presents on focus, and applies them', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection(['route-setter']);
    });
    simulateScreenRefocus();

    expect(managedSheetProps.latest?.open).toBe(true);

    fireEvent.click(getByText('mobile.filter.showCount12'));
    expect(onApply).toHaveBeenCalledWith({ ...currentFilters, setter: ['route-setter'] }, currentBoardFilters);
  });

  it('keeps local draft edits when parent filter props change while a sub-route is open', () => {
    const onApply = vi.fn();
    const rendered = renderFilterSheet({ onApply });

    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection(['route-setter']);
    });

    rendered.rerender(
      <ClimbFilterSheet
        {...rendered.props}
        currentFilters={{ ...currentFilters, setter: ['parent-update'] }}
        currentBoardFilters={{ ...currentBoardFilters, onlyBenchmarks: true }}
      />,
    );
    simulateScreenRefocus();
    fireEvent.click(rendered.getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith({ ...currentFilters, setter: ['route-setter'] }, currentBoardFilters);
  });

  it('syncs parent filters again after dismissing without Apply', () => {
    const onApply = vi.fn();
    const rendered = renderFilterSheet({ onApply });

    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection(['route-setter']);
    });

    // Genuine user close (pan-down) clears the draft-edits guard.
    act(() => {
      bottomSheetModalProps.latest?.onChange?.(-1);
    });
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
    act(() => {
      emitSetterFilterSelection(['route-setter']);
    });
    fireEvent.click(rendered.getByText('mobile.filter.reset'));

    act(() => {
      bottomSheetModalProps.latest?.onChange?.(-1);
    });
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

  it('pushes the hold filter route and applies the handed-back hold filter', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.holdFilter.title'));

    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/holds',
      params: {
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        holdsFilter: JSON.stringify(currentBoardFilters.holdsFilter),
      },
    });
    expect(managedSheetProps.latest?.open).toBe(false);

    act(() => {
      emitHoldsFilterSelection({ '99': { HAND: 'include' } });
    });
    simulateScreenRefocus();
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith(currentFilters, {
      ...currentBoardFilters,
      holdsFilter: { '99': { HAND: 'include' } },
    });
  });

  it('pushes the zone route and applies the handed-back zone + pruned holds', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.zoneFilter.title'));

    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/zone',
      params: {
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
        zoneBox: JSON.stringify(currentBoardFilters.zoneBox),
        zoneMode: 'allHolds',
        holdsFilter: JSON.stringify(currentBoardFilters.holdsFilter),
      },
    });

    act(() => {
      emitZoneFilterSelection({
        zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
        zoneMode: 'allHolds',
        holdsFilter: { '77': { FOOT: 'include' } },
      });
    });
    simulateScreenRefocus();
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply).toHaveBeenCalledWith(currentFilters, {
      holdsFilter: { '77': { FOOT: 'include' } },
      zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
      zoneMode: 'allHolds',
    });
  });

  it('ignores a second sub-picker tap until the sheet resumes', () => {
    const { getByLabelText } = renderFilterSheet();

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    fireEvent.click(getByLabelText('mobile.holdFilter.title'));

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/(tabs)/climbs/setters' }));

    // After the sheet resumes, another picker can be opened.
    simulateScreenRefocus();
    fireEvent.click(getByLabelText('mobile.holdFilter.title'));
    expect(routerPush).toHaveBeenCalledTimes(2);
    expect(routerPush).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: '/(tabs)/climbs/holds' }));
  });

  it('keeps Refine expanded across a sub-route round trip', () => {
    const { getByLabelText, getByTestId, getByText } = renderFilterSheet();

    fireEvent.click(getByText('expand-mobile.filter.section.refine'));
    expect(getByTestId('section-mobile.filter.section.refine').getAttribute('data-expanded')).toBe('true');

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection(['route-setter']);
    });
    simulateScreenRefocus();

    expect(getByTestId('section-mobile.filter.section.refine').getAttribute('data-expanded')).toBe('true');
  });

  it('keeps Advanced expanded across a sub-route round trip', () => {
    const { getByLabelText, getByTestId, getByText } = renderFilterSheet();

    fireEvent.click(getByText('expand-mobile.filter.section.advanced'));
    expect(getByTestId('section-mobile.filter.section.advanced').getAttribute('data-expanded')).toBe('true');

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection(['route-setter']);
    });
    simulateScreenRefocus();

    expect(getByTestId('section-mobile.filter.section.advanced').getAttribute('data-expanded')).toBe('true');
  });

  it('collapses Advanced after Reset across a sub-route round trip', () => {
    // Reset is only enabled while the draft has active filters.
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const { getByLabelText, getByTestId, getByText } = renderFilterSheet();

    fireEvent.click(getByText('expand-mobile.filter.section.advanced'));
    fireEvent.click(getByText('mobile.filter.reset'));
    expect(vi.mocked(hapticSelection)).toHaveBeenCalled();

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    simulateScreenRefocus();

    expect(getByTestId('section-mobile.filter.section.advanced').getAttribute('data-expanded')).toBe('false');
  });

  it('remounts the sheet host on resume so each present is a first present (#3330)', () => {
    const { getByLabelText } = renderFilterSheet();
    expect(bottomSheetModalProps.mountCount).toBe(1);

    // Suspend for a sub-picker, then return.
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    expect(managedSheetProps.latest?.open).toBe(false);

    simulateScreenRefocus();

    // Re-presented (open flips back true) AND the host was torn down + rebuilt.
    expect(managedSheetProps.latest?.open).toBe(true);
    expect(bottomSheetModalProps.mountCount).toBe(2);
  });

  it('restores the pre-suspend scroll offset after the remount, ignoring mount-time scroll noise', () => {
    const { getByLabelText } = renderFilterSheet();

    // User scrolls down, then opens a sub-picker (offset snapshotted at suspend).
    act(() => {
      bottomSheetScrollViewProps.latest?.onScroll?.({ nativeEvent: { contentOffset: { y: 240 } } });
    });
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    simulateScreenRefocus();

    // The fresh ScrollView can emit an initial onScroll at y=0 before its content
    // lays out — the restore must not pick that up as the target.
    act(() => {
      bottomSheetScrollViewProps.latest?.onScroll?.({ nativeEvent: { contentOffset: { y: 0 } } });
      bottomSheetScrollViewProps.latest?.onContentSizeChange?.();
    });

    expect(bottomSheetScrollViewProps.scrollTo).toHaveBeenCalledTimes(1);
    expect(bottomSheetScrollViewProps.scrollTo).toHaveBeenCalledWith({ y: 240, animated: false });
  });
});

describe('ClimbFilterSheet rows without a board config', () => {
  it('disables the Setters row and applies the disabled style when boardConfig is null', () => {
    const { getByLabelText } = renderFilterSheet({ boardConfig: null });

    const setters = getByLabelText('mobile.filter.setters') as HTMLButtonElement;
    expect(setters.disabled).toBe(true);

    fireEvent.click(setters);
    expect(routerPush).not.toHaveBeenCalled();

    const rowStyle = JSON.parse(setters.getAttribute('data-style') ?? 'null');
    expect(rowStyle ?? []).toContainEqual({ opacity: 0.4 });
  });

  it('keeps the Setters row enabled and unstyled when a board config is present', () => {
    const { getByLabelText } = renderFilterSheet();

    const setters = getByLabelText('mobile.filter.setters') as HTMLButtonElement;
    expect(setters.disabled).toBe(false);

    const rowStyle = JSON.parse(setters.getAttribute('data-style') ?? 'null');
    expect(rowStyle ?? []).not.toContainEqual({ opacity: 0.4 });
  });
});
