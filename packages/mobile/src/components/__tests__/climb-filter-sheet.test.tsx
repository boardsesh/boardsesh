// @vitest-environment jsdom
import { createElement, forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react';
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

// A spy (not a bare stub) so a test can inspect the `name` it was called with —
// needed to assert the "Show N" preview reflects an in-sheet name edit (#3606).
// Typed explicitly: an inferred `() => {}` gives `.mock.calls` the `[][]` tuple
// type and `lastCall?.[3]` fails to typecheck (TS2493).
const searchInputMocks = vi.hoisted(() => ({
  toClimbSearchInput: vi.fn((..._args: unknown[]) => ({})),
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

type TextInputProps = {
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
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
  // The name field's input (#3606) — a plain controlled `<input>` standing in
  // for RN's TextInput; `onChangeText` (not DOM's `onChange`-with-event) is the
  // callback shape ClimbFilterSheet actually calls.
  TextInput: ({ value, onChangeText, placeholder, accessibilityLabel }: TextInputProps) =>
    createElement('input', {
      value,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      placeholder,
      'aria-label': accessibilityLabel,
    }),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    // Consumed by the #3922 detent probe (sheet-detent-probe.ts).
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  },
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
  toClimbSearchInput: searchInputMocks.toClimbSearchInput,
  newSortSeed: () => '424242',
  mergeBoardFilters: (input: unknown) => input,
  formatMinAscentsFilterCount: (count: number) => String(count),
  countFilteredHolds: (holdsFilter?: Record<string, unknown>) => Object.keys(holdsFilter ?? {}).length,
  // "Your progress" selector (PRIMARY card single-select).
  PROGRESS_FILTER_VALUES: ['all', 'untried', 'projects', 'sent', 'unsent'],
  flagsToProgress: (flags?: Record<string, unknown>) => {
    if (flags?.showOnlyCompleted) return 'sent';
    if (flags?.showOnlyAttempted) return 'projects';
    if (flags?.hideAttempted && flags?.hideCompleted) return 'untried';
    if (flags?.hideCompleted) return 'unsent';
    return 'all';
  },
  progressToFlags: () => ({
    hideAttempted: undefined,
    hideCompleted: undefined,
    showOnlyAttempted: undefined,
    showOnlyCompleted: undefined,
  }),
}));

vi.mock('../../lib/graphql/hooks', () => ({
  useGrades: () => ({ data: [] }),
  useSearchClimbsCount: () => ({ data: 12 }),
}));

const authMock = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
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
// Render each segment as a clickable button keyed by option, so tests can drive
// single-selects like Collection (Any / Benchmarks / My drafts).
vi.mock('../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
    disabledKeys,
  }: {
    options: { key: string; label: string }[];
    selectedKey?: string;
    onSelect?: (key: string) => void;
    disabledKeys?: ReadonlySet<string>;
  }) =>
    createElement(
      'div',
      {},
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'data-testid': `segment-${option.key}`,
            'data-selected': String(option.key === selectedKey),
            disabled: disabledKeys?.has(option.key),
            onClick: () => onSelect?.(option.key),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../StarRating', () => ({ StarRating: () => null }));
vi.mock('../RadioGroup', () => ({ RadioGroup: () => null }));
// A clickable toggle keyed by label, so tests can drive the "My drafts" /
// benchmark / tall / wide switches.
vi.mock('../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value?: boolean;
    onValueChange?: (next: boolean) => void;
  }) =>
    createElement(
      'button',
      {
        'data-testid': `switch-${label}`,
        'data-value': String(!!value),
        onClick: () => onValueChange?.(!value),
      },
      label,
    ),
}));
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
    onNameChange: vi.fn(),
    onClearName: vi.fn(),
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
  searchInputMocks.toClimbSearchInput.mockImplementation(() => ({}));
  bottomSheetModalProps.latest = null;
  bottomSheetModalProps.mountCount = 0;
  bottomSheetScrollViewProps.latest = null;
  managedSheetProps.latest = null;
  focusEffectHolder.cb = null;
  authMock.isAuthenticated = true;
});

describe('ClimbFilterSheet sub-pickers', () => {
  it('prewarms board holds when the sheet becomes visible (Holds row is always shown)', () => {
    renderFilterSheet();

    // No accordion to expand: the sheet only mounts while visible, so mount is
    // when we warm the create-board hold geometry the always-visible Holds row needs.
    expect(createBoardHoldsMocks.parseSetIdsParam).toHaveBeenCalledWith('1,2');
    expect(createBoardHoldsMocks.prewarmCreateBoardHolds).toHaveBeenCalledWith({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2],
    });
  });

  it('does not prewarm board holds when no board config is present', () => {
    renderFilterSheet({ boardConfig: null });
    expect(createBoardHoldsMocks.prewarmCreateBoardHolds).not.toHaveBeenCalled();
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

  it('fires a haptic on Reset (no accordions to collapse)', () => {
    // Reset is only enabled while the draft has active filters.
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const { getByText } = renderFilterSheet();

    fireEvent.click(getByText('mobile.filter.reset'));
    expect(vi.mocked(hapticSelection)).toHaveBeenCalled();
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

// Woods used to hide both pickers: it has no `board_placements` rows to resolve a
// hold search against, and its zone box is projected from its own hold geometry
// rather than a placement grid. The search answers both off that geometry now, so
// the rows are offered on every board — boardsesh/boardsesh#4748.
describe('ClimbFilterSheet hold + zone rows by board', () => {
  const woodsBoardConfig = { ...boardConfig, boardName: 'woods' };

  it('shows both rows on a board backed by placement rows', () => {
    const { queryByLabelText } = renderFilterSheet();

    expect(queryByLabelText('mobile.holdFilter.title')).not.toBeNull();
    expect(queryByLabelText('mobile.zoneFilter.title')).not.toBeNull();
  });

  it('shows both rows on Woods too', () => {
    const { queryByLabelText } = renderFilterSheet({ boardConfig: woodsBoardConfig });

    expect(queryByLabelText('mobile.holdFilter.title')).not.toBeNull();
    expect(queryByLabelText('mobile.zoneFilter.title')).not.toBeNull();
  });

  it('warms the hold geometry on Woods, the same as any other board', () => {
    renderFilterSheet({ boardConfig: woodsBoardConfig });

    expect(createBoardHoldsMocks.prewarmCreateBoardHolds).toHaveBeenCalledWith(
      expect.objectContaining({ boardName: 'woods' }),
    );
  });
});

describe('ClimbFilterSheet Quantum overlap', () => {
  const quantumBoardConfig = { ...boardConfig, boardName: 'quantum' };

  it('applies the selected overlap mode when live geometry is known', () => {
    const onApply = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({
      boardConfig: quantumBoardConfig,
      quantumOccupancy: { geometryKnown: true, placementIds: new Set([1_000_001]) },
      onApply,
    });

    fireEvent.click(getByTestId('segment-at_most_one'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    expect(onApply.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ quantumOverlap: 'at_most_one' }));
  });

  it('disables overlap modes when live geometry is unknown', () => {
    const { getByTestId, getByText } = renderFilterSheet({
      boardConfig: quantumBoardConfig,
      quantumOccupancy: { geometryKnown: false, placementIds: new Set() },
    });

    expect((getByTestId('segment-none') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('segment-at_most_one') as HTMLButtonElement).disabled).toBe(true);
    expect((getByText('mobile.filter.quantumOverlap.off').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ClimbFilterSheet random sort', () => {
  it('shows a reshuffle button for random and mints a fresh seed on tap', () => {
    const onApply = vi.fn();
    // Start already on random with an old seed; the reshuffle button must overwrite it.
    const { getByText } = renderFilterSheet({
      onApply,
      currentFilters: { ...currentFilters, sortBy: 'random', sortSeed: 'old' },
    });

    fireEvent.click(getByText('mobile.filter.sort.reshuffle'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    const applied = onApply.mock.calls.at(-1)?.[0] as ClimbFilters;
    expect(applied.sortBy).toBe('random');
    // newSortSeed is mocked to '424242', so the stale 'old' seed is replaced.
    expect(applied.sortSeed).toBe('424242');
  });

  it('does not show the reshuffle button for a non-random sort', () => {
    const { queryByText } = renderFilterSheet({
      currentFilters: { ...currentFilters, sortBy: 'quality' },
    });
    expect(queryByText('mobile.filter.sort.reshuffle')).toBeNull();
  });
});

describe('ClimbFilterSheet flat sections', () => {
  it('renders six labeled sections flat, without any accordion controls', () => {
    const { getByText, queryByText } = renderFilterSheet();

    // The six top-level group headers are all present and always visible — Name
    // is now the first (#3606), ahead of Difficulty.
    expect(getByText('mobile.filter.section.name')).not.toBeNull();
    expect(getByText('mobile.filter.section.difficulty')).not.toBeNull();
    expect(getByText('mobile.filter.progress.label')).not.toBeNull();
    expect(getByText('mobile.filter.section.quality')).not.toBeNull();
    expect(getByText('mobile.filter.section.theClimb')).not.toBeNull();
    expect(getByText('mobile.filter.section.sort')).not.toBeNull();

    // No CollapsibleSection: the old Refine/Advanced expand affordances are gone.
    expect(queryByText('expand-mobile.filter.section.refine')).toBeNull();
    expect(queryByText('expand-mobile.filter.section.advanced')).toBeNull();
    expect(queryByText('mobile.filter.section.refine')).toBeNull();
    expect(queryByText('mobile.filter.section.advanced')).toBeNull();
  });

  it('hides the Your progress section and the Collection "My drafts" option when signed out', () => {
    authMock.isAuthenticated = false;
    const { queryByText, queryByTestId } = renderFilterSheet();
    expect(queryByText('mobile.filter.progress.label')).toBeNull();
    // Collection still shows (Any / Benchmarks), but the auth-only My drafts option is dropped.
    expect(queryByTestId('segment-benchmarks')).not.toBeNull();
    expect(queryByTestId('segment-drafts')).toBeNull();
  });

  // Personal rating filters (#2645) live inside the auth-gated Your progress
  // section, so they must disappear with it when signed out.
  it('renders the My rating controls inside the auth-gated progress section', () => {
    const { getByText, getByTestId } = renderFilterSheet();
    expect(getByText('mobile.filter.myRating')).not.toBeNull();
    expect(getByTestId('switch-mobile.filter.onlyRatedByMe')).not.toBeNull();
  });

  it('hides the My rating controls when signed out', () => {
    authMock.isAuthenticated = false;
    const { queryByText, queryByTestId } = renderFilterSheet();
    expect(queryByText('mobile.filter.myRating')).toBeNull();
    expect(queryByTestId('switch-mobile.filter.onlyRatedByMe')).toBeNull();
  });

  it('applies onlyRatedByMe when the rated-by-me switch is turned on', () => {
    const onApply = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    const applied = onApply.mock.calls.at(-1)?.[0] as ClimbFilters;
    expect(applied.onlyRatedByMe).toBe(true);
  });

  it('selecting the "Unrepeated" popularity bucket sets status to projects', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByLabelText('mobile.filter.popularityUnrepeated'));
    fireEvent.click(getByText('mobile.filter.showCount12'));

    const applied = onApply.mock.calls.at(-1)?.[0] as ClimbFilters;
    expect(applied.status).toBe('projects');
  });

  it('selecting Collection "My drafts" sets status to drafts', () => {
    const onApply = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByTestId('segment-drafts'));
    fireEvent.click(getByText('mobile.filter.showCount12'));
    expect((onApply.mock.calls.at(-1)?.[0] as ClimbFilters).status).toBe('drafts');
  });

  it('selecting Collection "Benchmarks" clears a drafts status (mutually exclusive)', () => {
    const onApply = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ onApply });

    fireEvent.click(getByTestId('segment-drafts'));
    fireEvent.click(getByTestId('segment-benchmarks'));
    fireEvent.click(getByText('mobile.filter.showCount12'));
    const call = onApply.mock.calls.at(-1);
    expect((call?.[0] as ClimbFilters).status).toBe('any');
    expect((call?.[1] as { onlyBenchmarks?: boolean }).onlyBenchmarks).toBe(true);
  });
});

// Regression coverage for #3606: Reset silently left the committed climb-name
// term in place (no wire existed to clear it), and the maintainer separately
// asked for the name to be a visible, editable first row in the sheet.
describe('ClimbFilterSheet name field (#3606)', () => {
  it('clears the name via onClearName on Reset, but NOT on Apply', () => {
    // Reset is only enabled while the draft has active filters.
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const onClearName = vi.fn();
    const onApply = vi.fn();
    const { getByText } = renderFilterSheet({ searchName: 'crimpy', onClearName, onApply });

    // Guards against the wiring landing on the wrong button — a plausible
    // copy-paste inversion given Reset/Apply sit in the same header/footer.
    fireEvent.click(getByText('mobile.filter.showCount12'));
    expect(onClearName).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText('mobile.filter.reset'));
    expect(onClearName).toHaveBeenCalledTimes(1);
  });

  // The issue's literal repro: a lone climb-name search with every other control
  // still at its default. `anyActive` used to be built only from
  // hasActiveClimbFilters/hasActiveBoardFilters, neither of which can see the
  // name — so Reset rendered disabled and the fix above it was unreachable.
  // Note the activity mocks stay at their default `false` here on purpose.
  it('enables Reset and clears the name when ONLY a climb name is set', () => {
    const onClearName = vi.fn();
    const { getByText } = renderFilterSheet({ searchName: 'crimpy', onClearName });

    const resetButton = getByText('mobile.filter.reset').closest('button');
    expect(resetButton?.disabled).toBe(false);

    fireEvent.click(getByText('mobile.filter.reset'));
    expect(onClearName).toHaveBeenCalledTimes(1);
  });

  it('leaves Reset disabled when nothing at all is set', () => {
    const onClearName = vi.fn();
    const { getByText } = renderFilterSheet({ onClearName });

    expect(getByText('mobile.filter.reset').closest('button')?.disabled).toBe(true);
    fireEvent.click(getByText('mobile.filter.reset'));
    expect(onClearName).not.toHaveBeenCalled();
  });

  it('mirrors a typed name to onNameChange and to the field itself', () => {
    const onNameChange = vi.fn();
    const { getByLabelText } = renderFilterSheet({ onNameChange });

    const input = getByLabelText('mobile.filter.section.name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'crimp' } });

    expect(onNameChange).toHaveBeenCalledWith('crimp');
    expect(input.value).toBe('crimp');
  });

  it('shows the inline clear button only once there is text, and routes it through the same path as Reset', () => {
    const onClearName = vi.fn();
    // Seeded non-empty so the clear button is visible immediately.
    const { getByLabelText, queryByLabelText } = renderFilterSheet({ searchName: 'foot', onClearName });

    const input = getByLabelText('mobile.filter.section.name') as HTMLInputElement;
    expect(input.value).toBe('foot');

    fireEvent.click(getByLabelText('actions.clear'));

    expect(input.value).toBe('');
    expect(onClearName).toHaveBeenCalledTimes(1);
    expect(queryByLabelText('actions.clear')).toBeNull();
  });

  it('resyncs the name field from an external searchName change, but ignores a trim-only difference', () => {
    const rendered = renderFilterSheet({ searchName: 'crimp' });
    const input = rendered.getByLabelText('mobile.filter.section.name') as HTMLInputElement;
    expect(input.value).toBe('crimp');

    // A genuine external change (board switch / recent-pill apply / cancel)
    // re-seeds the field.
    rendered.rerender(<ClimbFilterSheet {...rendered.props} searchName="jugs" />);
    expect(input.value).toBe('jugs');

    // Simulate mid-typing a trailing space, then the parent commits the
    // NORMALIZED (trimmed) value — the field's own trailing space must survive,
    // not get yanked out from under the cursor.
    fireEvent.change(input, { target: { value: 'sloper ' } });
    rendered.rerender(<ClimbFilterSheet {...rendered.props} searchName="sloper" />);
    expect(input.value).toBe('sloper ');
  });

  it('reflects an in-sheet name edit in the "Show N" preview after the debounce', () => {
    vi.useFakeTimers();
    try {
      const { getByLabelText } = renderFilterSheet();
      searchInputMocks.toClimbSearchInput.mockClear();

      const input = getByLabelText('mobile.filter.section.name') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'crimp' } });

      act(() => {
        vi.advanceTimersByTime(250);
      });

      const lastCall = searchInputMocks.toClimbSearchInput.mock.calls.at(-1);
      // 4th positional arg is `{ name }` — see toClimbSearchInput(filters, boardConfig, pageParams, { name }).
      expect(lastCall?.[3]).toEqual({ name: 'crimp' });
    } finally {
      vi.useRealTimers();
    }
  });
});
