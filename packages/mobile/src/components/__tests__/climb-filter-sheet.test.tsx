// @vitest-environment jsdom
vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import {
  cloneElement,
  createElement,
  forwardRef,
  isValidElement,
  useEffect,
  useImperativeHandle,
  useState,
  StrictMode,
  type ReactNode,
} from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE, type ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import type { RecentFilter } from '../../lib/recent-filter-store';
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
  accessibilityState?: { selected?: boolean };
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
  // The raw ref's dismiss. A spy only: it does NOT fire onChange(-1), because the
  // real native close arrives later (after the slide-down). Tests fire that close
  // explicitly with simulateNativeClose().
  dismiss: vi.fn(),
  // The raw ref's snapToIndex: the keyboard raise to the tall detent.
  snapToIndex: vi.fn(),
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
    keyboardShouldPersistTaps?: string;
    scrollEventThrottle?: number;
  },
  scrollTo: vi.fn(),
}));

type ScrollViewMockProps = NonNullable<typeof bottomSheetScrollViewProps.latest> & { children?: ReactNode };
const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' | 'web' }));
// The theme variant the mocked useTheme reports; 'material' keeps the RN body.
const themeVariantMock = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));
// The iOS Form stub records the model the sheet hands it (#6872).
const filterFormMock = vi.hoisted(() => ({
  latest: null as null | {
    sections: {
      key: string;
      rows: { key: string; kind: string; onPress?: () => void; onSelect?: (key: string) => void }[];
    }[];
  },
}));

// expo-router stand-ins: a push spy and a holder for the focus callback so a test
// can simulate the climbs screen regaining focus after a sub-route pops.
type KeyboardListener = (event: { endCoordinates?: { height: number; screenY: number; width: number } }) => void;
const keyboardListeners = vi.hoisted(() => new Map<string, KeyboardListener>());
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
// needed to assert the matching count reflects an in-sheet name edit (#3606).
// Typed explicitly: an inferred `() => {}` gives `.mock.calls` the `[][]` tuple
// type and `lastCall?.[3]` fails to typecheck (TS2493).
const searchInputMocks = vi.hoisted(() => ({
  toClimbSearchInput: vi.fn((..._args: unknown[]) => ({})),
  // A pass-through spy, so tests can read the board filters the count input carries.
  mergeBoardFilters: vi.fn((input: unknown, _boardFilters?: unknown) => input),
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
  Platform: platformMock,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: ({ children, style, testID }: { children?: ReactNode; style?: StyleProp; testID?: string }) =>
    createElement(
      'div',
      { 'data-style': resolveStyle(style), 'data-column': testID === 'climb-filter-column' ? 'true' : undefined },
      children,
    ),
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      keyboardListeners.set(eventName, listener);
      return { remove: () => keyboardListeners.delete(eventName) };
    },
    isVisible: () => false,
    metrics: () => undefined,
  },
  LayoutAnimation: { configureNext: () => {} },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
    style,
  }: PressableProps) => {
    const renderedChildren = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        'aria-label': accessibilityLabel,
        'aria-pressed': accessibilityState?.selected,
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
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    // Consumed by the #3922 detent probe (sheet-detent-probe.ts).
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  },
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
    useImperativeHandle(
      ref,
      () => ({
        present: vi.fn(),
        dismiss: bottomSheetModalProps.dismiss,
        snapToIndex: bottomSheetModalProps.snapToIndex,
      }),
      [],
    );
    useEffect(() => {
      bottomSheetModalProps.mountCount += 1;
    }, []);
    return createElement('div', null, children);
  }),
  BottomSheetScrollView: forwardRef<unknown, ScrollViewMockProps>(function BottomSheetScrollView(
    { children, ...props },
    ref,
  ) {
    bottomSheetScrollViewProps.latest = props;
    useImperativeHandle(ref, () => ({ scrollTo: bottomSheetScrollViewProps.scrollTo }), []);
    return createElement('div', { 'data-testid': 'filter-scroll-view', 'data-adapter': 'bottom-sheet' }, children);
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

vi.mock('@boardsesh/climb-filters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/climb-filters')>()),
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
  normalizeRetiredFilters: (filters: unknown) => filters,
  toClimbSearchInput: searchInputMocks.toClimbSearchInput,
  newSortSeed: () => '424242',
  mergeBoardFilters: searchInputMocks.mergeBoardFilters,
  formatMinAscentsFilterCount: (count: number) => String(count),
  countFilteredHolds: (holdsFilter?: Record<string, unknown>) => Object.keys(holdsFilter ?? {}).length,
}));

const countPreviewMock = vi.hoisted(() => ({
  count: 12 as number | undefined,
  // The `enabled` argument of every catalogue-count call, newest last.
  enabled: [] as boolean[],
  // The board every grades lookup asked for, newest last.
  gradeBoards: [] as string[],
}));
vi.mock('../../lib/graphql/hooks', () => ({
  useGrades: (boardName: string) => {
    countPreviewMock.gradeBoards.push(boardName);
    return { data: [] };
  },
  useSearchClimbsCount: (_input: unknown, enabled: boolean) => {
    countPreviewMock.enabled.push(enabled);
    return { data: countPreviewMock.count };
  },
}));

const authMock = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// The climbs pin store, reduced to one pinned kind and a toggle spy, so a test
// can tell which control's pin is which: only the pinned kind's pin reads "Unpin".
const pinStore = vi.hoisted(() => ({ pinnedKind: null as string | null, togglePin: vi.fn() }));
vi.mock('../../lib/pinned-chips-store', () => ({
  usePinnedChips: () => ({
    pinned: pinStore.pinnedKind ? [pinStore.pinnedKind] : [],
    loaded: true,
    isPinned: (kind: string) => kind === pinStore.pinnedKind,
    togglePin: pinStore.togglePin,
  }),
}));

vi.mock('../../lib/create-board-holds', () => ({
  parseSetIdsParam: createBoardHoldsMocks.parseSetIdsParam,
  prewarmCreateBoardHolds: createBoardHoldsMocks.prewarmCreateBoardHolds,
}));

vi.mock('../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: themeVariantMock.variant,
    systemColors: {
      fill: '#eee',
      tertiaryBackground: '#fff',
      separator: '#ccc',
      secondaryLabel: '#777',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../ClimbFilterForm', () => ({
  ClimbFilterForm: ({ model }: { model: NonNullable<typeof filterFormMock.latest> }) => {
    filterFormMock.latest = model;
    return createElement('div', { 'data-testid': 'native-filter-form' });
  },
}));

vi.mock('../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));

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
  opacity: { disabled: 0.5 },
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
  }: {
    options: { key: string; label: string }[];
    selectedKey?: string;
    onSelect?: (key: string) => void;
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
            onClick: () => onSelect?.(option.key),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../RadioGroup', () => ({ RadioGroup: () => null }));
// A clickable toggle keyed by label, so tests can drive the "My drafts" /
// benchmark / tall / wide switches.
vi.mock('../SwitchRow', () => ({
  SwitchRow: ({
    label,
    description,
    value,
    onValueChange,
    disabled,
  }: {
    label: string;
    description?: string;
    value?: boolean;
    onValueChange?: (next: boolean) => void;
    disabled?: boolean;
  }) =>
    createElement(
      'button',
      {
        'data-testid': `switch-${label}`,
        'data-description': description,
        'data-value': String(!!value),
        // Mirrors the real SwitchRow: a disabled row ignores taps.
        onClick: disabled ? undefined : () => onValueChange?.(!value),
        disabled,
      },
      label,
    ),
}));
vi.mock('../Icon', () => ({ Icon: () => null }));
// The iOS detent bound (#3330), as a value no other style carries, so the test
// below can see which view it lands on.
const DETENT_COLUMN = vi.hoisted(() => ({ height: 701 }));
vi.mock('../use-sheet-column-style', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-sheet-column-style')>()),
  useSheetColumnStyle: () => DETENT_COLUMN,
}));
// Model the header action targets without native UI. A disabled Reset ignores
// taps, and the matching count is a noninteractive header subtitle.
type TopBarActionMock = { label?: string; kind?: string; onPress: () => void; disabled?: boolean; prominent?: boolean };
vi.mock('../SheetTopBar', () => ({
  SheetTopBar: ({
    title,
    subtitle,
    leading,
    trailing,
  }: {
    title: string;
    subtitle?: string;
    leading?: TopBarActionMock;
    trailing?: TopBarActionMock;
  }) =>
    createElement(
      'div',
      { 'data-top-bar': title },
      subtitle ? createElement('span', { 'data-subtitle': true }, subtitle) : null,
      [leading, trailing].map((action, index) =>
        action
          ? createElement(
              'button',
              {
                key: index,
                'data-slot': index === 0 ? 'leading' : 'trailing',
                'data-prominent': String(!!action.prominent),
                disabled: action.disabled,
                onClick: action.disabled ? undefined : action.onPress,
              },
              action.label ?? action.kind,
            )
          : null,
      ),
    ),
}));
vi.mock('../grade', () => ({
  GradeRangeRail: ({ onChange }: { onChange: (grade: { minGradeId: number; maxGradeId: number }) => void }) =>
    createElement('button', {
      'data-testid': 'grade-range',
      onClick: () => onChange({ minGradeId: 12, maxGradeId: 14 }),
    }),
}));

// The saved-search chips, one button each, so a test can read their order and
// which one is current, and tap one. The strip itself is tested on its own.
vi.mock('../filter-sheet/RecentSearchRail', () => ({
  RecentSearchRail: ({
    recents,
    currentId,
    onSelect,
  }: {
    recents: readonly RecentFilter[];
    currentId?: string;
    onSelect: (id: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'recent-search-rail' },
      recents.map((recent) =>
        createElement(
          'button',
          {
            key: recent.id,
            'data-recent': recent.id,
            'data-current': recent.id === currentId ? 'true' : 'false',
            onClick: () => onSelect(recent.id),
          },
          recent.label,
        ),
      ),
    ),
}));

type FilterSheetProps = Parameters<typeof ClimbFilterSheet>[0];

// The production parent echoes each committed selection back into props without
// closing. Keep that ownership contract in the component tests, including when
// a test supplies newer external props through rerender.
function CommittedSelectionHarness({ children }: { children: ReactNode }) {
  if (!isValidElement<FilterSheetProps>(children)) throw new Error('Expected a filter sheet');
  const { currentFilters: filters, currentBoardFilters: boardFilters } = children.props;
  const [selection, setSelection] = useState({ filters, boardFilters });
  useEffect(() => {
    setSelection({ filters, boardFilters });
  }, [filters, boardFilters]);
  return cloneElement(children, {
    currentFilters: selection.filters,
    currentBoardFilters: selection.boardFilters,
    onSelectionChange: (nextFilters: ClimbFilters, nextBoardFilters: ClimbBoardFilterState) => {
      children.props.onSelectionChange(nextFilters, nextBoardFilters);
      setSelection({ filters: nextFilters, boardFilters: nextBoardFilters });
    },
  });
}

function renderFilterSheet(overrides: Partial<Parameters<typeof ClimbFilterSheet>[0]> = {}) {
  const props: Parameters<typeof ClimbFilterSheet>[0] = {
    onDismiss: vi.fn(),
    boardConfig,
    currentFilters,
    currentBoardFilters,
    searchName: '',
    onSelectionChange: vi.fn(),
    onNameChange: vi.fn(),
    onClearName: vi.fn(),
    recentFilters: [],
    onApplyRecent: vi.fn(),
    ...overrides,
  };

  return { ...render(<ClimbFilterSheet {...props} />, { wrapper: CommittedSelectionHarness }), props };
}

/** The handoff id the sheet sent with its last picker push: where a route hands its picks back. */
function pushedHandoffId(): string {
  const push = routerPush.mock.calls.at(-1)?.[0] as { params?: { handoffId?: string } } | undefined;
  return push?.params?.handoffId ?? '';
}

// Simulate the climbs screen regaining focus after a sub-picker route pops.
function simulateScreenRefocus() {
  act(() => {
    focusEffectHolder.cb?.();
  });
}

// Simulate the native close callback (iOS: after the slide-down; Android: after
// hide() settles). It is the same onChange(-1) a pan-down fires.
function simulateNativeClose() {
  act(() => {
    bottomSheetModalProps.latest?.onChange?.(-1);
  });
}

// Tap Close, then let the native animation finish.
function closeAndFinish(closeButton: HTMLElement) {
  fireEvent.click(closeButton);
  simulateNativeClose();
}

beforeEach(() => {
  countPreviewMock.count = 12;
  countPreviewMock.enabled = [];
  countPreviewMock.gradeBoards = [];
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
  pinStore.pinnedKind = null;
  platformMock.OS = 'android';
  themeVariantMock.variant = 'material';
  filterFormMock.latest = null;
});

describe('ClimbFilterSheet scroll adapters', () => {
  it.each([
    ['ios', 'bottom-sheet'],
    ['android', 'bottom-sheet'],
    ['web', 'bottom-sheet'],
  ] as const)('uses the %s scroll adapter and keeps the keyboard tap contract', (platform, adapter) => {
    platformMock.OS = platform;
    const { getByTestId } = renderFilterSheet();

    expect(getByTestId('filter-scroll-view').getAttribute('data-adapter')).toBe(adapter);
    expect(bottomSheetScrollViewProps.latest).toMatchObject({
      keyboardShouldPersistTaps: 'handled',
      scrollEventThrottle: 32,
    });
  });
});

// These presses verify live selections and count previews with the actual
// progress mapping and StarRating. Native gesture delivery still needs device QA.
describe.each(['ios', 'android'] as const)('ClimbFilterSheet control interactions on %s (#6340)', (platform) => {
  beforeEach(() => {
    platformMock.OS = platform;
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  function advanceCountPreview() {
    act(() => {
      vi.advanceTimersByTime(250);
    });
  }

  it('selects Sent, clears the previous progress flags and previews and commits the selection immediately', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({
      onSelectionChange,
      currentFilters: { ...currentFilters, showOnlyAttempted: true, hideCompleted: true },
    });
    const sentChip = getByLabelText('mobile.filter.progress.sent');
    fireEvent.click(sentChip);

    expect(sentChip.getAttribute('aria-pressed')).toBe('true');
    expect(getByLabelText('mobile.filter.progress.projects').getAttribute('aria-pressed')).toBe('false');
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    advanceCountPreview();

    const sentFilters = {
      ...currentFilters,
      hideAttempted: undefined,
      hideCompleted: undefined,
      showOnlyAttempted: undefined,
      showOnlyCompleted: true,
    };
    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual(sentFilters);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(sentFilters, currentBoardFilters);
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('selects different stars in My rating and Min rating and carries both into live selections and count previews', () => {
    const onSelectionChange = vi.fn();
    const { getByText } = renderFilterSheet({ onSelectionChange });
    const myRatingControls = within(getByText('mobile.filter.myRating').parentElement as HTMLElement);
    const qualityControls = within(getByText('mobile.filter.section.quality').parentElement as HTMLElement);

    fireEvent.click(myRatingControls.getByLabelText('3 stars'));
    fireEvent.click(qualityControls.getByLabelText('4 stars'));

    expect(myRatingControls.getByLabelText('3 stars').getAttribute('aria-pressed')).toBe('true');
    expect(qualityControls.getByLabelText('4 stars').getAttribute('aria-pressed')).toBe('true');
    expect(hapticSelection).toHaveBeenCalledTimes(2);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    advanceCountPreview();

    const ratedFilters = { ...currentFilters, minUserRating: 3, minRating: 4 };
    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual(ratedFilters);
    const commitsBeforeClose = onSelectionChange.mock.calls.length;
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledTimes(commitsBeforeClose);

    expect(onSelectionChange).toHaveBeenCalledWith(ratedFilters, currentBoardFilters);
  });

  it('clears each star filter with its own Any chip in live selections and count previews', () => {
    const onSelectionChange = vi.fn();
    const { getByText } = renderFilterSheet({
      onSelectionChange,
      currentFilters: { ...currentFilters, minUserRating: 3, minRating: 4 },
    });
    const myRatingControls = within(getByText('mobile.filter.myRating').parentElement as HTMLElement);
    const qualityControls = within(getByText('mobile.filter.section.quality').parentElement as HTMLElement);

    fireEvent.click(myRatingControls.getByLabelText('mobile.filter.anyRating'));
    fireEvent.click(qualityControls.getByLabelText('mobile.filter.anyRating'));

    expect(myRatingControls.getByLabelText('mobile.filter.anyRating').getAttribute('aria-pressed')).toBe('true');
    expect(qualityControls.getByLabelText('mobile.filter.anyRating').getAttribute('aria-pressed')).toBe('true');
    expect(myRatingControls.getByLabelText('3 stars').getAttribute('aria-pressed')).toBe('false');
    expect(qualityControls.getByLabelText('4 stars').getAttribute('aria-pressed')).toBe('false');
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    advanceCountPreview();

    const clearedRatings = { ...currentFilters, minUserRating: undefined, minRating: undefined };
    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual(clearedRatings);
    const commitsBeforeClose = onSelectionChange.mock.calls.length;
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledTimes(commitsBeforeClose);
    expect(onSelectionChange).toHaveBeenCalledWith(clearedRatings, currentBoardFilters);
  });

  it('turns Only-rated off and clears its constraint from live selections and count previews', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({
      onSelectionChange,
      currentFilters: { ...currentFilters, onlyRatedByMe: true },
    });

    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    expect(getByTestId('switch-mobile.filter.onlyRatedByMe').getAttribute('data-value')).toBe('false');
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    advanceCountPreview();

    const clearedOnlyRated = { ...currentFilters, onlyRatedByMe: undefined };
    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual(clearedOnlyRated);
    const commitsBeforeClose = onSelectionChange.mock.calls.length;
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledTimes(commitsBeforeClose);
    expect(onSelectionChange).toHaveBeenCalledWith(clearedOnlyRated, currentBoardFilters);
  });

  it('resets Sent and both ratings together and commits the defaults immediately', () => {
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const onSelectionChange = vi.fn();
    const { getByText, getByLabelText } = renderFilterSheet({
      onSelectionChange,
      currentFilters: { ...currentFilters, showOnlyCompleted: true, minUserRating: 3, minRating: 4 },
    });
    const myRatingControls = within(getByText('mobile.filter.myRating').parentElement as HTMLElement);
    const qualityControls = within(getByText('mobile.filter.section.quality').parentElement as HTMLElement);

    fireEvent.click(getByText('mobile.filter.reset'));

    expect(getByLabelText('mobile.filter.progress.all').getAttribute('aria-pressed')).toBe('true');
    expect(getByLabelText('mobile.filter.progress.sent').getAttribute('aria-pressed')).toBe('false');
    expect(myRatingControls.getByLabelText('mobile.filter.anyRating').getAttribute('aria-pressed')).toBe('true');
    expect(qualityControls.getByLabelText('mobile.filter.anyRating').getAttribute('aria-pressed')).toBe('true');
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    advanceCountPreview();

    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual(DEFAULT_CLIMB_FILTER_STATE);
    expect(searchInputMocks.mergeBoardFilters.mock.calls.at(-1)?.[1]).toEqual({});
    const commitsBeforeClose = onSelectionChange.mock.calls.length;
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledTimes(commitsBeforeClose);
    expect(onSelectionChange).toHaveBeenCalledWith(DEFAULT_CLIMB_FILTER_STATE, {});
  });

  it('previews mutually exclusive Collection choices and commits Any with both constraints cleared', () => {
    const onSelectionChange = vi.fn();
    const { getByText } = renderFilterSheet({ onSelectionChange });
    const collectionControls = within(getByText('mobile.filter.section.quality').parentElement as HTMLElement);

    fireEvent.click(collectionControls.getByTestId('segment-drafts'));
    expect(collectionControls.getByTestId('segment-drafts').getAttribute('data-selected')).toBe('true');
    advanceCountPreview();
    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual({
      ...currentFilters,
      status: 'drafts',
      sortBy: 'creation',
      minAscents: undefined,
    });
    expect(searchInputMocks.mergeBoardFilters.mock.calls.at(-1)?.[1]).toEqual({
      ...currentBoardFilters,
      onlyBenchmarks: undefined,
    });

    fireEvent.click(collectionControls.getByTestId('segment-benchmarks'));
    expect(collectionControls.getByTestId('segment-drafts').getAttribute('data-selected')).toBe('false');
    expect(collectionControls.getByTestId('segment-benchmarks').getAttribute('data-selected')).toBe('true');
    advanceCountPreview();
    expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual({
      ...currentFilters,
      sortBy: 'creation',
      minAscents: undefined,
    });
    expect(searchInputMocks.mergeBoardFilters.mock.calls.at(-1)?.[1]).toEqual({
      ...currentBoardFilters,
      onlyBenchmarks: true,
    });

    fireEvent.click(collectionControls.getByTestId('segment-any'));
    expect(collectionControls.getByTestId('segment-any').getAttribute('data-selected')).toBe('true');
    expect(onSelectionChange).toHaveBeenCalledTimes(3);
    advanceCountPreview();
    const clearedCollection = { ...currentBoardFilters, onlyBenchmarks: undefined };
    expect(searchInputMocks.mergeBoardFilters.mock.calls.at(-1)?.[1]).toEqual(clearedCollection);
    const commitsBeforeClose = onSelectionChange.mock.calls.length;
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledTimes(commitsBeforeClose);
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      { ...currentFilters, sortBy: 'creation', minAscents: undefined },
      clearedCollection,
    );
  });
});

describe('ClimbFilterSheet live selections and dismissal', () => {
  it('places Close leading, secondary Reset trailing, and the count in the scroll body', () => {
    const { container, getByText, queryByText } = renderFilterSheet();
    expect(container.querySelector('[data-top-bar="mobile.filter.title"]')).not.toBeNull();
    expect(getByText('close').getAttribute('data-slot')).toBe('leading');
    expect(getByText('mobile.filter.reset').getAttribute('data-slot')).toBe('trailing');
    expect(getByText('mobile.filter.reset').getAttribute('data-prominent')).toBe('false');
    const countSubtitle = getByText('mobile.filter.matchingCount12');
    expect(countSubtitle.closest('[data-top-bar="mobile.filter.title"]')).not.toBeNull();
    expect(countSubtitle.closest('button')).toBeNull();
    expect(queryByText('mobile.filter.automaticChanges')).toBeNull();
    expect(queryByText('mobile.filter.countNote')).toBeNull();
    expect(queryByText('mobile.filter.showCount12')).toBeNull();
  });

  it('pads the column by the keyboard overlap so the name search stays above it', () => {
    const { container } = renderFilterSheet();
    const columnStyle = () =>
      JSON.parse(container.querySelector('[data-column="true"]')?.getAttribute('data-style') ?? 'null');
    expect(columnStyle()).toEqual(DETENT_COLUMN);
    act(() =>
      keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280, screenY: 564, width: 390 } }),
    );
    expect(columnStyle()).toEqual([DETENT_COLUMN, { paddingBottom: 280 }]);
    act(() => keyboardListeners.get('keyboardDidHide')?.({}));
    expect(columnStyle()).toEqual(DETENT_COLUMN);
  });

  it('hands the native sheet one in-flow child carrying the detent bound (#3330)', () => {
    const { container } = renderFilterSheet();
    const column = container.querySelector('[data-column="true"]') as HTMLElement;
    expect(JSON.parse(column.getAttribute('data-style') ?? 'null')).toEqual(DETENT_COLUMN);
    const inFlowSiblings = [...(column.parentElement?.children ?? [])].filter((element) => {
      if (element === column) return false;
      const style = JSON.parse(element.getAttribute('data-style') ?? '{}') ?? {};
      return style.position !== 'absolute' && style.height !== 0;
    });
    expect(inFlowSiblings).toEqual([]);
  });

  it('commits a switch immediately while keeping the sheet open', () => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const { getByTestId } = renderFilterSheet({ onSelectionChange, onDismiss });
    const toggle = getByTestId('switch-authors.followingClimbs');
    expect(JSON.parse(toggle.parentElement?.getAttribute('data-style') ?? '{}')).toMatchObject({ marginTop: 16 });
    fireEvent.click(toggle);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...currentFilters, onlyFollowedAuthors: true },
      currentBoardFilters,
    );
    expect(toggle.getAttribute('data-value')).toBe('true');
    expect(onDismiss).not.toHaveBeenCalled();
    expect(bottomSheetModalProps.dismiss).not.toHaveBeenCalled();
    expect(managedSheetProps.latest?.open).toBe(true);
  });

  it('publishes once per event under Strict Mode and never during render or mount', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId } = render(
      <StrictMode>
        <ClimbFilterSheet
          onDismiss={vi.fn()}
          boardConfig={boardConfig}
          currentFilters={currentFilters}
          currentBoardFilters={currentBoardFilters}
          onSelectionChange={onSelectionChange}
          onNameChange={vi.fn()}
          onClearName={vi.fn()}
          recentFilters={[]}
          onApplyRecent={vi.fn()}
        />
      </StrictMode>,
    );
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('normalizes My drafts after an auth flip before publishing another choice', () => {
    const onSelectionChange = vi.fn();
    const rendered = renderFilterSheet({ onSelectionChange, currentFilters: { ...currentFilters, status: 'drafts' } });
    authMock.isAuthenticated = false;
    rendered.rerender(<ClimbFilterSheet {...rendered.props} />);
    expect(rendered.queryByTestId('segment-drafts')).toBeNull();
    fireEvent.click(rendered.getByTestId('switch-mobile.filter.betaVideosDescription'));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'any', onlyWithBetaVideos: true }),
      currentBoardFilters,
    );
  });

  it('commits a grade immediately and debounces only the matching-count request', () => {
    vi.useFakeTimers();
    try {
      const onSelectionChange = vi.fn();
      const { getByTestId } = renderFilterSheet({ onSelectionChange });
      searchInputMocks.toClimbSearchInput.mockClear();
      fireEvent.click(getByTestId('grade-range'));
      expect(onSelectionChange).toHaveBeenCalledWith(
        { ...currentFilters, minGrade: 12, maxGrade: 14 },
        currentBoardFilters,
      );
      expect(searchInputMocks.toClimbSearchInput).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(249);
      });
      expect(searchInputMocks.toClimbSearchInput).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(searchInputMocks.toClimbSearchInput.mock.calls.at(-1)?.[0]).toEqual({
        ...currentFilters,
        minGrade: 12,
        maxGrade: 14,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last selection when the next event is a swipe dismissal', () => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const { getByTestId } = renderFilterSheet({ onSelectionChange, onDismiss });
    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    expect(onSelectionChange).toHaveBeenCalledWith({ ...currentFilters, onlyRatedByMe: true }, currentBoardFilters);
    simulateNativeClose();
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelectionChange.mock.invocationCallOrder[0]).toBeLessThan(onDismiss.mock.invocationCallOrder[0]);
  });

  it('combines consecutive controls before a parent render and publishes outside React updaters', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId } = renderFilterSheet({ onSelectionChange });
    act(() => {
      fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
      fireEvent.click(getByTestId('switch-authors.followingClimbs'));
    });
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      { ...currentFilters, onlyRatedByMe: true, onlyFollowedAuthors: true },
      currentBoardFilters,
    );
  });

  it('dismisses on Close and notifies the parent once after the native animation', () => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = renderFilterSheet({ onSelectionChange, onDismiss });
    fireEvent.click(getByText('close'));
    expect(bottomSheetModalProps.dismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    simulateNativeClose();
    simulateNativeClose();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('reads the latest dismissal callback during the slide-down', () => {
    const staleOnDismiss = vi.fn();
    const rendered = renderFilterSheet({ onDismiss: staleOnDismiss });
    fireEvent.click(rendered.getByText('close'));
    const latestOnDismiss = vi.fn();
    rendered.rerender(<ClimbFilterSheet {...rendered.props} onDismiss={latestOnDismiss} />);
    simulateNativeClose();
    expect(latestOnDismiss).toHaveBeenCalledTimes(1);
    expect(staleOnDismiss).not.toHaveBeenCalled();
  });

  it('ignores repeated Close taps and sub-picker rows during the slide-down', () => {
    const { getByText, getByLabelText } = renderFilterSheet();
    fireEvent.click(getByText('close'));
    fireEvent.click(getByText('close'));
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    fireEvent.click(getByLabelText('mobile.holdFilter.title'));
    fireEvent.click(getByLabelText('mobile.zoneFilter.title'));
    expect(bottomSheetModalProps.dismiss).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('does not recommit on unmount and ignores a late native close', () => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const { getByText, getByTestId, unmount } = renderFilterSheet({ onSelectionChange, onDismiss });
    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    fireEvent.click(getByText('close'));
    const lateClose = bottomSheetModalProps.latest?.onChange;
    unmount();
    act(() => lateClose?.(-1));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('ignores a native close after the presentation board or angle changed', () => {
    const onDismiss = vi.fn();
    const rendered = renderFilterSheet({ onDismiss });
    rendered.rerender(<ClimbFilterSheet {...rendered.props} boardConfig={{ ...boardConfig, angle: 45 }} />);
    simulateNativeClose();
    expect(onDismiss).not.toHaveBeenCalled();
  });
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

  it('pushes the setters route with the current selection and count input, and suspends the sheet', () => {
    // Echo the draft into the built input so the serialized param shows what it was built from.
    searchInputMocks.toClimbSearchInput.mockImplementation((draftFilters: unknown) => ({ draftFilters }));
    const { getByLabelText } = renderFilterSheet({ searchName: 'crimp' });

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
        handoffId: expect.stringMatching(/^filter-picker-\d+$/),
        countInput: JSON.stringify({ draftFilters: currentFilters }),
      },
    });
    // Same count input the sheet's own "Show N" uses: page 0, one row, the name.
    expect(searchInputMocks.toClimbSearchInput).toHaveBeenLastCalledWith(
      currentFilters,
      boardConfig,
      { page: 0, pageSize: 1 },
      { name: 'crimp' },
    );
    expect(managedSheetProps.latest?.open).toBe(false);
  });

  it('applies straight from an apply handoff with the latest committed selection, without re-presenting', () => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const { getByLabelText, getByTestId } = renderFilterSheet({ onSelectionChange, onDismiss });

    // A live edit made before opening the picker must ride along.
    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: ['route-setter'], apply: true });
    });

    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...currentFilters, onlyRatedByMe: true, setter: ['route-setter'] },
      currentBoardFilters,
    );
    // The suspended sheet has no native close to wait for, so it closes itself,
    // after committing the filters.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSelectionChange.mock.invocationCallOrder[0]).toBeLessThan(onDismiss.mock.invocationCallOrder[0]);
    expect(bottomSheetModalProps.dismiss).not.toHaveBeenCalled();

    // The pop then refocuses the climbs screen. Even if the parent hasn't
    // unmounted the sheet yet, that refocus must not re-present it.
    simulateScreenRefocus();

    expect(managedSheetProps.latest?.open).toBe(false);
    expect(bottomSheetModalProps.mountCount).toBe(1);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });

  it('applies an empty apply handoff as no setter filter', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: [], apply: true });
    });

    expect(onSelectionChange).toHaveBeenCalledWith({ ...currentFilters, setter: undefined }, currentBoardFilters);
  });

  it('applies a setter handoff through the latest onSelectionChange and onDismiss after the parent re-renders them', () => {
    const staleOnSelectionChange = vi.fn();
    const staleOnDismiss = vi.fn();
    const rendered = renderFilterSheet({ onSelectionChange: staleOnSelectionChange, onDismiss: staleOnDismiss });

    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    // The parent's onSelectionChange changes identity on every search keystroke.
    const latestOnSelectionChange = vi.fn();
    const latestOnDismiss = vi.fn();
    rendered.rerender(
      <ClimbFilterSheet {...rendered.props} onSelectionChange={latestOnSelectionChange} onDismiss={latestOnDismiss} />,
    );
    act(() => {
      emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: ['route-setter'], apply: true });
    });

    expect(latestOnSelectionChange).toHaveBeenCalledTimes(1);
    expect(latestOnDismiss).toHaveBeenCalledTimes(1);
    expect(staleOnSelectionChange).not.toHaveBeenCalled();
    expect(staleOnDismiss).not.toHaveBeenCalled();
  });

  it('feeds a plain setter handoff into the count input without waiting out the debounce', () => {
    vi.useFakeTimers();
    try {
      const { getByLabelText } = renderFilterSheet();
      fireEvent.click(getByLabelText('mobile.filter.setters'));
      searchInputMocks.toClimbSearchInput.mockClear();

      act(() => {
        emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: ['route-setter'] });
      });

      // No timer advanced: the count input already carries the handed-back picks.
      const lastCall = searchInputMocks.toClimbSearchInput.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual({ ...currentFilters, setter: ['route-setter'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('feeds a holds handoff into the count input without waiting out the debounce', () => {
    vi.useFakeTimers();
    try {
      const { getByLabelText } = renderFilterSheet();
      fireEvent.click(getByLabelText('mobile.holdFilter.title'));
      searchInputMocks.mergeBoardFilters.mockClear();

      act(() => {
        emitHoldsFilterSelection({ handoffId: pushedHandoffId(), holdsFilter: { '99': { HAND: 'include' } } });
      });

      // No timer advanced: the count input already carries the handed-back holds.
      expect(searchInputMocks.mergeBoardFilters.mock.calls.at(-1)?.[1]).toEqual({
        ...currentBoardFilters,
        holdsFilter: { '99': { HAND: 'include' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('feeds a zone handoff into the count input without waiting out the debounce', () => {
    vi.useFakeTimers();
    try {
      const { getByLabelText } = renderFilterSheet();
      fireEvent.click(getByLabelText('mobile.zoneFilter.title'));
      searchInputMocks.mergeBoardFilters.mockClear();

      act(() => {
        emitZoneFilterSelection({
          handoffId: pushedHandoffId(),
          zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
          zoneMode: 'allHolds',
          holdsFilter: { '77': { FOOT: 'include' } },
        });
      });

      // No timer advanced: the count input already carries the handed-back zone.
      expect(searchInputMocks.mergeBoardFilters.mock.calls.at(-1)?.[1]).toEqual({
        ...currentBoardFilters,
        holdsFilter: { '77': { FOOT: 'include' } },
        zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
        zoneMode: 'allHolds',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges the setters handed back from the route, re-presents on focus, and applies them', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByLabelText('mobile.filter.setters'));
    act(() => {
      emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: ['route-setter'] });
    });
    simulateScreenRefocus();

    expect(managedSheetProps.latest?.open).toBe(true);

    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...currentFilters, setter: ['route-setter'] },
      currentBoardFilters,
    );
  });

  it('uses the latest committed parent selection during a sub-picker handoff', () => {
    const onSelectionChange = vi.fn();
    const rendered = renderFilterSheet({ onSelectionChange });
    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    rendered.rerender(
      <ClimbFilterSheet
        {...rendered.props}
        currentFilters={{ ...currentFilters, onlyRatedByMe: true }}
        currentBoardFilters={{ ...currentBoardFilters, onlyBenchmarks: true }}
      />,
    );
    act(() => emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: ['route-setter'] }));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...currentFilters, onlyRatedByMe: true, setter: ['route-setter'] },
      { ...currentBoardFilters, onlyBenchmarks: true },
    );
  });

  it('suspends without finalizing the filters and resumes after the native close', () => {
    const onDismiss = vi.fn();
    const rendered = renderFilterSheet({ onDismiss });
    fireEvent.click(rendered.getByLabelText('mobile.filter.setters'));
    simulateNativeClose();
    expect(onDismiss).not.toHaveBeenCalled();
    simulateScreenRefocus();
    expect(managedSheetProps.latest?.open).toBe(true);
    simulateNativeClose();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each(['setters', 'holds', 'zone'] as const)('ignores a stale %s handoff after the board changes', (picker) => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const rendered = renderFilterSheet({ onSelectionChange, onDismiss });
    const label =
      picker === 'setters'
        ? 'mobile.filter.setters'
        : picker === 'holds'
          ? 'mobile.holdFilter.title'
          : 'mobile.zoneFilter.title';
    fireEvent.click(rendered.getByLabelText(label));
    rendered.rerender(<ClimbFilterSheet {...rendered.props} boardConfig={{ ...boardConfig, sizeId: 11 }} />);
    act(() => {
      if (picker === 'setters')
        emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: ['old-board-setter'], apply: true });
      if (picker === 'holds')
        emitHoldsFilterSelection({ handoffId: pushedHandoffId(), holdsFilter: { '99': { HAND: 'include' } } });
      if (picker === 'zone')
        emitZoneFilterSelection({
          handoffId: pushedHandoffId(),
          zoneBox: currentBoardFilters.zoneBox ?? null,
          zoneMode: 'allHolds',
        });
    });
    simulateScreenRefocus();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(managedSheetProps.latest?.open).toBe(false);
  });

  it('pushes the hold filter route and applies the handed-back hold filter', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByLabelText('mobile.holdFilter.title'));

    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/holds',
      params: {
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
        holdsFilter: JSON.stringify(currentBoardFilters.holdsFilter),
        handoffId: expect.stringMatching(/^filter-picker-\d+$/),
        // The committed selection used by the heatmap.
        heatmapSearch: JSON.stringify({
          filters: currentFilters,
          boardFilters: currentBoardFilters,
          searchText: '',
        }),
      },
    });
    expect(managedSheetProps.latest?.open).toBe(false);

    act(() => {
      emitHoldsFilterSelection({ handoffId: pushedHandoffId(), holdsFilter: { '99': { HAND: 'include' } } });
    });
    simulateScreenRefocus();
    closeAndFinish(getByText('close'));

    expect(onSelectionChange).toHaveBeenCalledWith(currentFilters, {
      ...currentBoardFilters,
      holdsFilter: { '99': { HAND: 'include' } },
    });
  });

  it('pushes the zone route and applies the handed-back zone + pruned holds', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onSelectionChange });

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
        handoffId: expect.stringMatching(/^filter-picker-\d+$/),
      },
    });

    act(() => {
      emitZoneFilterSelection({
        handoffId: pushedHandoffId(),
        zoneBox: { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 8 },
        zoneMode: 'allHolds',
        holdsFilter: { '77': { FOOT: 'include' } },
      });
    });
    simulateScreenRefocus();
    closeAndFinish(getByText('close'));

    expect(onSelectionChange).toHaveBeenCalledWith(currentFilters, {
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

  it.each(['android', 'ios', 'web'] as const)(
    'restores the pre-suspend scroll offset on %s, ignoring mount-time scroll noise',
    (platform) => {
      platformMock.OS = platform;
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
    },
  );
});

describe('ClimbFilterSheet picker routes and handoff ids (#6651)', () => {
  const PLAYLIST_PICKERS = {
    stack: 'discover',
    heatmap: false,
    setterList: { kind: 'playlist', playlistId: 'p-1' },
  } as const;

  it('pushes the Climbs routes by default, each with the same id for the sheet', () => {
    const { getByLabelText } = renderFilterSheet();
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    const settersPush = routerPush.mock.calls.at(-1)?.[0] as { pathname: string; params: { handoffId: string } };
    act(() => emitSetterFilterSelection({ handoffId: settersPush.params.handoffId, setters: [] }));
    simulateScreenRefocus();
    fireEvent.click(getByLabelText('mobile.holdFilter.title'));
    const holdsPush = routerPush.mock.calls.at(-1)?.[0] as { pathname: string; params: { handoffId: string } };

    expect(settersPush.pathname).toBe('/(tabs)/climbs/setters');
    expect(holdsPush.pathname).toBe('/(tabs)/climbs/holds');
    expect(holdsPush.params.handoffId).toBe(settersPush.params.handoffId);
  });

  it("pushes the Discover routes for a playlist, and lists the playlist's own setters", () => {
    const { getByLabelText } = renderFilterSheet({ pickers: PLAYLIST_PICKERS });
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    expect(routerPush).toHaveBeenLastCalledWith({
      pathname: '/(tabs)/discover/playlist-setters',
      params: {
        playlistId: 'p-1',
        setters: JSON.stringify(['draft-setter']),
        handoffId: expect.stringMatching(/^filter-picker-\d+$/),
      },
    });
    act(() => emitSetterFilterSelection({ handoffId: pushedHandoffId(), setters: [] }));
    simulateScreenRefocus();

    fireEvent.click(getByLabelText('mobile.zoneFilter.title'));
    expect(routerPush).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: '/(tabs)/discover/zone' }));
  });

  it("names a smart list's setters by type and owner", () => {
    const { getByLabelText } = renderFilterSheet({
      pickers: {
        stack: 'discover',
        heatmap: false,
        setterList: { kind: 'smart', smartType: 'FIVE_STARS', userId: 'u-1' },
      },
    });
    fireEvent.click(getByLabelText('mobile.filter.setters'));
    expect(routerPush).toHaveBeenLastCalledWith({
      pathname: '/(tabs)/discover/playlist-setters',
      params: expect.objectContaining({ smartType: 'FIVE_STARS', userId: 'u-1' }),
    });
  });

  it("opens a list's setters with no board: a setter filter reads every row", () => {
    const { getByLabelText } = renderFilterSheet({ boardConfig: null, pickers: PLAYLIST_PICKERS });
    const setters = getByLabelText('mobile.filter.setters') as HTMLButtonElement;
    expect(setters.disabled).toBe(false);
    fireEvent.click(setters);
    expect(routerPush).toHaveBeenLastCalledWith(
      expect.objectContaining({ pathname: '/(tabs)/discover/playlist-setters' }),
    );
  });

  it('turns the Hold types heatmap off for a list it cannot count', () => {
    const { getByLabelText } = renderFilterSheet({ pickers: PLAYLIST_PICKERS });
    fireEvent.click(getByLabelText('mobile.holdFilter.title'));
    const holdsPush = routerPush.mock.calls.at(-1)?.[0] as { pathname: string; params: Record<string, string> };
    expect(holdsPush.pathname).toBe('/(tabs)/discover/holds');
    expect(holdsPush.params.heatmap).toBe('off');
    expect(holdsPush.params).not.toHaveProperty('heatmapSearch');
  });

  it('ignores a pick addressed to another sheet, and one with no address', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText } = renderFilterSheet({ onSelectionChange });
    fireEvent.click(getByLabelText('mobile.holdFilter.title'));
    act(() => {
      emitHoldsFilterSelection({ handoffId: 'filter-picker-someone-else', holdsFilter: { '99': { HAND: 'include' } } });
      emitHoldsFilterSelection({ handoffId: '', holdsFilter: { '99': { HAND: 'include' } } });
    });
    expect(onSelectionChange).not.toHaveBeenCalled();

    act(() => emitHoldsFilterSelection({ handoffId: pushedHandoffId(), holdsFilter: { '99': { HAND: 'include' } } }));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  // The collision the ids fix: the Climbs sheet stays mounted (suspended) under a
  // setter page pushed from its setter picker; that page's own sheet then opens
  // Hold types. Before the ids both sheets took the picks, so the Climbs list
  // picked up holds chosen for one setter's page.
  it('hands Hold types picks only to the sheet that opened it, with another sheet suspended under it', () => {
    const climbsTabSelectionChange = vi.fn();
    const climbsTabSheet = renderFilterSheet({ onSelectionChange: climbsTabSelectionChange });
    fireEvent.click(climbsTabSheet.getByLabelText('mobile.filter.setters'));
    const climbsTabHandoffId = pushedHandoffId();

    const setterPageSelectionChange = vi.fn();
    const setterPageSheet = renderFilterSheet({
      onSelectionChange: setterPageSelectionChange,
      sections: { setters: false, following: false, recent: false, drafts: false, otherAngles: false },
      pickers: { stack: 'climbs', heatmap: false },
    });
    fireEvent.click(setterPageSheet.getAllByLabelText('mobile.holdFilter.title').at(-1) as HTMLElement);
    const setterPageHandoffId = pushedHandoffId();
    expect(setterPageHandoffId).not.toBe(climbsTabHandoffId);

    act(() => emitHoldsFilterSelection({ handoffId: setterPageHandoffId, holdsFilter: { '42': { FOOT: 'include' } } }));

    expect(setterPageSelectionChange).toHaveBeenCalledWith(currentFilters, {
      ...currentBoardFilters,
      holdsFilter: { '42': { FOOT: 'include' } },
    });
    expect(climbsTabSelectionChange).not.toHaveBeenCalled();
  });

  it('hides My rating where the list turns it off, unless a rating filter is on', () => {
    const hidden = renderFilterSheet({ sections: { myRating: false } });
    expect(hidden.queryByText('mobile.filter.myRating')).toBeNull();
    expect(hidden.queryByTestId('switch-mobile.filter.onlyRatedByMe')).toBeNull();
    // The progress chips around it stay.
    expect(hidden.queryByText('mobile.filter.progress.label')).not.toBeNull();
    hidden.unmount();

    const active = renderFilterSheet({
      sections: { myRating: false },
      currentFilters: { ...currentFilters, onlyRatedByMe: true },
    });
    expect(active.queryByText('mobile.filter.myRating')).not.toBeNull();
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
    expect(rowStyle ?? []).toContainEqual({ opacity: 0.5 });
  });

  it('keeps the Setters row enabled and unstyled when a board config is present', () => {
    const { getByLabelText } = renderFilterSheet();

    const setters = getByLabelText('mobile.filter.setters') as HTMLButtonElement;
    expect(setters.disabled).toBe(false);

    const rowStyle = JSON.parse(setters.getAttribute('data-style') ?? 'null');
    expect(rowStyle ?? []).not.toContainEqual({ opacity: 0.5 });
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

// A Woods climb belongs to the angle it was set at, so its list keeps to the
// browsed angle unless the climber turns on Other angles (#5642). Only an
// angle-bound board offers the switch; elsewhere every climb lists at every angle.
describe('ClimbFilterSheet Other angles switch', () => {
  const woodsBoardConfig = { ...boardConfig, boardName: 'woods' };
  const otherAnglesSwitchId = 'switch-mobile.filter.otherAngles';

  it('offers the switch on Woods, off by default', () => {
    const { getByTestId } = renderFilterSheet({ boardConfig: woodsBoardConfig });

    expect(getByTestId(otherAnglesSwitchId).getAttribute('data-value')).toBe('false');
  });

  it.each([
    ['Kilter', boardConfig],
    ['MoonBoard', { ...boardConfig, boardName: 'moonboard' }],
    ['no board config', null],
  ])('does not offer the switch on %s', (_label, sheetBoardConfig) => {
    const { queryByTestId } = renderFilterSheet({ boardConfig: sheetBoardConfig });

    expect(queryByTestId(otherAnglesSwitchId)).toBeNull();
  });

  it('applies includeOtherAngles when turned on', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ boardConfig: woodsBoardConfig, onSelectionChange });

    fireEvent.click(getByTestId(otherAnglesSwitchId));
    closeAndFinish(getByText('close'));

    const appliedFilters = onSelectionChange.mock.calls.at(-1)?.[0] as ClimbFilters | undefined;
    expect(appliedFilters?.includeOtherAngles).toBe(true);
  });

  it('clears it back to undefined when turned off, so the filter reads as inactive', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({
      boardConfig: woodsBoardConfig,
      currentFilters: { ...currentFilters, includeOtherAngles: true },
      onSelectionChange,
    });

    expect(getByTestId(otherAnglesSwitchId).getAttribute('data-value')).toBe('true');
    fireEvent.click(getByTestId(otherAnglesSwitchId));
    closeAndFinish(getByText('close'));

    const appliedFilters = onSelectionChange.mock.calls.at(-1)?.[0] as ClimbFilters | undefined;
    expect(appliedFilters).toBeDefined();
    expect(appliedFilters?.includeOtherAngles).toBeUndefined();
  });
});

describe('ClimbFilterSheet count subtitle', () => {
  it('updates the header count without duplicating it in the filter body', () => {
    const { container, getByText, queryByText, props, rerender } = renderFilterSheet();
    expect(getByText('mobile.filter.matchingCount12')).toBeDefined();
    countPreviewMock.count = 181054;
    rerender(<ClimbFilterSheet {...props} />);
    expect(queryByText('mobile.filter.matchingCount12')).toBeNull();
    expect(getByText('mobile.filter.matchingCount181054').closest('[data-top-bar]')).not.toBeNull();
    expect(container.querySelectorAll('[data-subtitle="true"]')).toHaveLength(1);
  });

  it('keeps zero results visible without hiding the filter controls', () => {
    countPreviewMock.count = 0;
    const { getByText } = renderFilterSheet();
    expect(getByText('mobile.filter.matchingCount0').closest('[data-top-bar]')).not.toBeNull();
    expect(getByText('mobile.filter.section.name')).toBeDefined();
    expect(getByText('close')).toBeDefined();
  });

  it('omits the subtitle while the result count is unavailable', () => {
    countPreviewMock.count = undefined;
    const { container, getByText } = renderFilterSheet();
    expect(container.querySelector('[data-subtitle="true"]')).toBeNull();
    expect(getByText('mobile.filter.section.name')).toBeDefined();
  });
});

describe('ClimbFilterSheet random sort', () => {
  it('shows a reshuffle button for random and mints a fresh seed on tap', () => {
    const onSelectionChange = vi.fn();
    // Start already on random with an old seed; the reshuffle button must overwrite it.
    const { getByText } = renderFilterSheet({
      onSelectionChange,
      currentFilters: { ...currentFilters, sortBy: 'random', sortSeed: 'old' },
    });

    fireEvent.click(getByText('mobile.filter.sort.reshuffle'));
    closeAndFinish(getByText('close'));

    const applied = onSelectionChange.mock.calls.at(-1)?.[0] as ClimbFilters;
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
    expect(queryByTestId('segment-liked')).toBeNull();
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
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    closeAndFinish(getByText('close'));

    const applied = onSelectionChange.mock.calls.at(-1)?.[0] as ClimbFilters;
    expect(applied.onlyRatedByMe).toBe(true);
  });

  it('selecting the "Unrepeated" popularity bucket sets status to projects', () => {
    const onSelectionChange = vi.fn();
    const { getByLabelText, getByText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByLabelText('mobile.filter.popularityUnrepeated'));
    closeAndFinish(getByText('close'));

    const applied = onSelectionChange.mock.calls.at(-1)?.[0] as ClimbFilters;
    expect(applied.status).toBe('projects');
  });

  it('publishes the Collection transition atomically, clearing Benchmarks when selecting My drafts', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId } = renderFilterSheet({
      onSelectionChange,
      currentBoardFilters: { ...currentBoardFilters, onlyBenchmarks: true },
    });
    fireEvent.click(getByTestId('segment-drafts'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'drafts' }), {
      ...currentBoardFilters,
      onlyBenchmarks: undefined,
    });
  });

  it('keeps Popularity when Collection changes without leaving My drafts', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId } = renderFilterSheet({
      onSelectionChange,
      currentFilters: { ...currentFilters, minAscents: 10 },
    });
    fireEvent.click(getByTestId('segment-benchmarks'));
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...currentFilters, minAscents: 10 },
      { ...currentBoardFilters, onlyBenchmarks: true },
    );
  });

  it('selecting Collection "My drafts" sets status to drafts', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByTestId('segment-drafts'));
    closeAndFinish(getByText('close'));
    expect(onSelectionChange.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'drafts' });
  });

  it('selecting Collection "Benchmarks" clears a drafts status (mutually exclusive)', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByTestId('segment-drafts'));
    fireEvent.click(getByTestId('segment-benchmarks'));
    closeAndFinish(getByText('close'));
    const call = onSelectionChange.mock.calls.at(-1);
    expect(call?.[0]).toMatchObject({ status: 'any' });
    expect(call?.[1]).toMatchObject({ onlyBenchmarks: true });
  });

  it('selecting Collection "Liked" sets onlyFavorited and clears drafts and benchmarks (#6002)', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByTestId('segment-drafts'));
    fireEvent.click(getByTestId('segment-benchmarks'));
    fireEvent.click(getByTestId('segment-liked'));
    expect(onSelectionChange).toHaveBeenCalledTimes(3);
    const call = onSelectionChange.mock.calls.at(-1);
    expect((call?.[0] as ClimbFilters).onlyFavorited).toBe(true);
    expect((call?.[0] as ClimbFilters).status).toBe('any');
    expect((call?.[1] as { onlyBenchmarks?: boolean }).onlyBenchmarks).toBeUndefined();
  });

  it('selecting Collection "Benchmarks" clears Liked', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId } = renderFilterSheet({ onSelectionChange });

    fireEvent.click(getByTestId('segment-liked'));
    fireEvent.click(getByTestId('segment-benchmarks'));
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    const call = onSelectionChange.mock.calls.at(-1);
    expect((call?.[0] as ClimbFilters).onlyFavorited).toBeUndefined();
    expect((call?.[1] as { onlyBenchmarks?: boolean }).onlyBenchmarks).toBe(true);
  });
});

// Regression coverage for #3606: Reset silently left the committed climb-name
// term in place (no wire existed to clear it), and the maintainer separately
// asked for the name to be a visible, editable first row in the sheet.
describe('ClimbFilterSheet name field (#3606)', () => {
  it('publishes Reset once with both filter groups cleared, without closing', () => {
    const onSelectionChange = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = renderFilterSheet({ searchName: 'crimp', onSelectionChange, onDismiss });
    fireEvent.click(getByText('mobile.filter.reset'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(
      { sortBy: 'popular', sortOrder: 'desc', status: 'any', boulders: true, routes: false },
      {},
    );
    expect(onDismiss).not.toHaveBeenCalled();
    expect(bottomSheetModalProps.dismiss).not.toHaveBeenCalled();
  });

  it('clears the name via Reset and leaves Close free of clearing or selection side effects', () => {
    const onClearName = vi.fn();
    const onSelectionChange = vi.fn();
    const { getByText } = renderFilterSheet({ searchName: 'crimpy', onClearName, onSelectionChange });
    fireEvent.click(getByText('mobile.filter.reset'));
    expect(onClearName).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    closeAndFinish(getByText('close'));
    expect(onClearName).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('does not clear a name when the sheet is swiped away', () => {
    const onClearName = vi.fn();
    const onSelectionChange = vi.fn();
    renderFilterSheet({ searchName: 'crimpy', onClearName, onSelectionChange });
    simulateNativeClose();
    expect(onClearName).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('ignores name input and inline clear after the board or angle changes', () => {
    const onNameChange = vi.fn();
    const onClearName = vi.fn();
    const rendered = renderFilterSheet({ searchName: 'old-board-name', onNameChange, onClearName });
    rendered.rerender(<ClimbFilterSheet {...rendered.props} boardConfig={{ ...boardConfig, angle: 45 }} />);
    fireEvent.change(rendered.getByLabelText('mobile.filter.section.name'), { target: { value: 'late text' } });
    fireEvent.click(rendered.getByLabelText('actions.clear'));
    expect(onNameChange).not.toHaveBeenCalled();
    expect(onClearName).not.toHaveBeenCalled();
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

  it('reflects an in-sheet name edit in the matching count after the debounce', () => {
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

// The Holds filter (Current / All / Intact / Lost holds) is gone: a published
// spray climb that lost a hold is always left out of wall lists, so there is
// nothing left to choose.
describe('ClimbFilterSheet without a Holds filter', () => {
  const sprayBoard = { boardName: 'spray', layoutId: 7, sizeId: 7, setIds: '1', angle: 25 };

  it.each([
    ['a catalogue board', boardConfig],
    ['a spray wall', sprayBoard],
  ])('offers no hold-integrity choice on %s', (_label, board) => {
    const { queryByTestId, queryByText } = renderFilterSheet({ boardConfig: board });
    for (const key of ['segment-current', 'segment-intact', 'segment-broken']) {
      expect(queryByTestId(key)).toBeNull();
    }
    expect(queryByText('mobile.filter.holdIntegrity.label')).toBeNull();
  });
});

// #5659 review: on iOS a locked Tall/Wide (chip-row lock) must survive the sheet's
// selection too, or the matching count is taken without it while the list gets it
// back from the lock.
describe('ClimbFilterSheet with a locked Tall/Wide', () => {
  // Kilter Homewall 10x12: both Tall and Wide apply.
  const homewall = { ...boardConfig, layoutId: 8, sizeId: 25 };

  it('keeps a locked dimension in the live selection through Reset', () => {
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({
      onSelectionChange,
      boardConfig: homewall,
      currentFilters: { ...currentFilters, onlyTallClimbs: true, onlyWideClimbs: true },
      lockedDimensions: { tall: true, wide: false },
    });

    fireEvent.click(getByText('mobile.filter.reset'));

    expect(getByTestId('switch-mobile.filter.tall').getAttribute('data-value')).toBe('true');
    expect(getByTestId('switch-mobile.filter.wide').getAttribute('data-value')).toBe('false');
    closeAndFinish(getByText('close'));
    const [appliedFilters] = onSelectionChange.mock.calls[0] as [ClimbFilters, ClimbBoardFilterState];
    expect(appliedFilters.onlyTallClimbs).toBe(true);
    expect(appliedFilters.onlyWideClimbs).toBeFalsy();
    // Reset still cleared everything else.
    expect(appliedFilters.setter).toBeUndefined();
  });

  it('holds a locked switch on and ignores taps on it, while an unlocked one still toggles', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({
      onSelectionChange,
      boardConfig: homewall,
      currentFilters: { ...currentFilters, onlyTallClimbs: true },
      lockedDimensions: { tall: true, wide: false },
    });

    const tallSwitch = getByTestId('switch-mobile.filter.tall');
    expect((tallSwitch as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tallSwitch);
    expect(tallSwitch.getAttribute('data-value')).toBe('true');

    const wideSwitch = getByTestId('switch-mobile.filter.wide');
    fireEvent.click(wideSwitch);
    expect(wideSwitch.getAttribute('data-value')).toBe('true');

    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ onlyTallClimbs: true, onlyWideClimbs: true }),
      currentBoardFilters,
    );
  });

  it('explains a locked switch with an unlock hint, and keeps the usual line on an unlocked one', () => {
    const { getByTestId } = renderFilterSheet({
      boardConfig: homewall,
      currentFilters: { ...currentFilters, onlyTallClimbs: true },
      lockedDimensions: { tall: true, wide: false },
    });

    expect(getByTestId('switch-mobile.filter.tall').getAttribute('data-description')).toBe(
      'mobile.filter.tallLockedHint',
    );
    expect(getByTestId('switch-mobile.filter.wide').getAttribute('data-description')).toBe(
      'mobile.filter.wideDescription',
    );
  });

  // Review of 8a0ac8b14: a pin toggle in the sheet rebuilt `lockedDimensions` on
  // the screen, re-ran the parent sync and put back every filter Reset had cleared.
  it('keeps the committed Reset when the screen re-renders with an equal but new lockedDimensions', () => {
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const onSelectionChange = vi.fn();
    const rendered = renderFilterSheet({
      onSelectionChange,
      boardConfig: homewall,
      currentFilters: { ...currentFilters, onlyWideClimbs: true },
      lockedDimensions: { tall: false, wide: false },
    });

    fireEvent.click(rendered.getByText('mobile.filter.reset'));
    expect(rendered.getByTestId('switch-mobile.filter.wide').getAttribute('data-value')).toBe('false');

    // e.g. the climber taps a pin: the parent re-renders with a fresh object.
    rendered.rerender(<ClimbFilterSheet {...rendered.props} lockedDimensions={{ tall: false, wide: false }} />);

    expect(rendered.getByTestId('switch-mobile.filter.wide').getAttribute('data-value')).toBe('false');
    closeAndFinish(rendered.getByText('close'));
    const [appliedFilters] = onSelectionChange.mock.calls[0] as [ClimbFilters, ClimbBoardFilterState];
    expect(appliedFilters.onlyWideClimbs).toBeFalsy();
    expect(appliedFilters.setter).toBeUndefined();
  });

  it('renders and publishes a locked dimension even before the lock has re-applied it', () => {
    const onSelectionChange = vi.fn();
    const { getByTestId, getByText } = renderFilterSheet({
      onSelectionChange,
      boardConfig: homewall,
      lockedDimensions: { tall: false, wide: true },
    });

    expect(getByTestId('switch-mobile.filter.wide').getAttribute('data-value')).toBe('true');
    fireEvent.click(getByTestId('switch-mobile.filter.onlyRatedByMe'));
    closeAndFinish(getByText('close'));
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ onlyWideClimbs: true }),
      currentBoardFilters,
    );
  });
});

// #5960: a spray wall has no benchmarks and no routes, so the sheet does not offer
// either there, unless a filter picked on another board still needs undoing.
describe('ClimbFilterSheet on a spray wall', () => {
  const sprayBoardConfig = { ...boardConfig, boardName: 'spray', layoutId: 4200, sizeId: 4200, setIds: '1' };

  it('offers Benchmarks and the climb type on a catalogue board', () => {
    const { queryByTestId } = renderFilterSheet();

    expect(queryByTestId('segment-benchmarks')).not.toBeNull();
    expect(queryByTestId('segment-routes')).not.toBeNull();
  });

  it('drops Benchmarks and the climb type on a spray wall', () => {
    const { queryByTestId } = renderFilterSheet({ boardConfig: sprayBoardConfig });

    expect(queryByTestId('segment-benchmarks')).toBeNull();
    expect(queryByTestId('segment-routes')).toBeNull();
    // The rest of the collection control stays.
    expect(queryByTestId('segment-drafts')).not.toBeNull();
  });

  it('keeps a non-default climb type on screen so it can be undone', () => {
    const { getByTestId } = renderFilterSheet({
      boardConfig: sprayBoardConfig,
      currentFilters: { ...currentFilters, boulders: false, routes: true },
    });

    expect(getByTestId('segment-routes').getAttribute('data-selected')).toBe('true');
  });

  it('drops the climb type on a spray-wall playlist, whose resting value is both types', () => {
    const playlistDefaults: ClimbFilters = { ...currentFilters, routes: true, setter: undefined };
    const { queryByTestId } = renderFilterSheet({
      boardConfig: sprayBoardConfig,
      defaultFilters: playlistDefaults,
      currentFilters: playlistDefaults,
    });

    expect(queryByTestId('segment-routes')).toBeNull();
    expect(queryByTestId('segment-both')).toBeNull();
  });

  it('keeps an active Benchmarks filter on screen so it can be undone', () => {
    const { getByTestId } = renderFilterSheet({
      boardConfig: sprayBoardConfig,
      currentBoardFilters: { ...currentBoardFilters, onlyBenchmarks: true },
    });

    expect(getByTestId('segment-benchmarks').getAttribute('data-selected')).toBe('true');
  });
});

// Each sheet pin is wired to its own chip: the pinned state it shows and the
// chip it toggles must both be that control's, never a neighbour's.
describe('ClimbFilterSheet pins', () => {
  // Kilter Homewall 10x12, where Tall and Wide both apply.
  const homewall = { ...boardConfig, layoutId: 8, sizeId: 25 };

  it.each([
    'recent',
    'grade',
    'accuracy',
    'progress',
    'collection',
    'rating',
    'popularity',
    'climbType',
    'tall',
    'wide',
    'beta',
    'sort',
  ])('shows the %s chip as pinned on its own control, and toggles that chip', (kind) => {
    pinStore.pinnedKind = kind;
    const { getByLabelText, getAllByLabelText } = renderFilterSheet({ boardConfig: homewall });

    // Exactly one pin reads pinned: the one on this control.
    fireEvent.click(getByLabelText('mobile.filter.unpinChip'));
    expect(pinStore.togglePin.mock.calls).toEqual([[kind]]);
    // Every other control still offers its own pin.
    expect(getAllByLabelText('mobile.filter.pinChip')).toHaveLength(11);
  });

  // With no saved searches the row stays, so the chip can be hidden before it
  // has ever appeared: a line says where searches will show. Signed out too.
  it.each([true, false])(
    'offers the Recent pin under Climb name with no history (signed in: %s)',
    (isAuthenticated) => {
      authMock.isAuthenticated = isAuthenticated;
      pinStore.pinnedKind = 'recent';
      const { getByText, getByLabelText, queryByTestId } = renderFilterSheet();

      expect(getByText('mobile.search.recentFilters')).toBeTruthy();
      expect(getByText('mobile.filter.recentDescription')).toBeTruthy();
      expect(queryByTestId('recent-search-rail')).toBeNull();
      fireEvent.click(getByLabelText('mobile.filter.unpinChip'));
      expect(pinStore.togglePin.mock.calls).toEqual([['recent']]);
    },
  );
});

describe('ClimbFilterSheet saved searches under Recent', () => {
  const recents: RecentFilter[] = [
    { id: 'newest', label: '"crimp"', filters: currentFilters, searchText: 'crimp', timestamp: 3 },
    {
      id: 'middle',
      label: 'Beta only',
      filters: { ...currentFilters, onlyWithBetaVideos: true },
      searchText: '',
      timestamp: 2,
    },
    { id: 'oldest', label: '"jugs"', filters: currentFilters, searchText: 'jugs', timestamp: 1 },
  ];
  const chipIds = (rail: HTMLElement) =>
    [...rail.querySelectorAll('button')].map((chip) => chip.getAttribute('data-recent'));

  it('shows the saved searches as chips, newest first, in place of the empty line', () => {
    const { getByTestId, queryByText } = renderFilterSheet({ recentFilters: recents });
    expect(chipIds(getByTestId('recent-search-rail'))).toEqual(['newest', 'middle', 'oldest']);
    expect(queryByText('mobile.filter.recentDescription')).toBeNull();
  });

  it('marks the saved search in force as current', () => {
    const { getByTestId } = renderFilterSheet({ recentFilters: recents, searchName: 'jugs' });
    const current = [...getByTestId('recent-search-rail').querySelectorAll('[data-current="true"]')];
    expect(current.map((chip) => chip.getAttribute('data-recent'))).toEqual(['oldest']);
  });

  it('applies the tapped search through the toolbar menu’s handler and stays open', () => {
    const onApplyRecent = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = renderFilterSheet({ recentFilters: recents, onApplyRecent, onDismiss });

    fireEvent.click(getByText('Beta only'));
    expect(onApplyRecent.mock.calls).toEqual([[recents[1].filters, '']]);
    fireEvent.click(getByText('"crimp"'));
    expect(onApplyRecent.mock.calls[1]).toEqual([recents[0].filters, 'crimp']);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps the Recent pin on the row while the chips show', () => {
    pinStore.pinnedKind = 'recent';
    const { getByLabelText } = renderFilterSheet({ recentFilters: recents });
    fireEvent.click(getByLabelText('mobile.filter.unpinChip'));
    expect(pinStore.togglePin.mock.calls).toEqual([['recent']]);
  });
});

// The playlist screen is the sheet's second consumer (#6651). Its seams are all
// optional; every suite above renders without them, which is the Climbs sheet.
describe('ClimbFilterSheet list seams', () => {
  const PLAYLIST_SECTIONS = {
    recent: false,
    drafts: false,
    setters: false,
    holds: false,
    zone: false,
    otherAngles: false,
  } as const;
  const playlistDefaults: ClimbFilters = { ...currentFilters, routes: true, setter: undefined };

  function sortControl(overrides: Partial<NonNullable<FilterSheetProps['sortControl']>> = {}) {
    return {
      options: [
        { key: 'position', label: 'Playlist order' },
        { key: 'difficulty', label: 'Difficulty' },
        { key: 'random', label: 'Random' },
      ],
      selected: 'difficulty',
      active: true,
      orderOptions: [
        { key: 'asc' as const, label: 'Easiest first' },
        { key: 'desc' as const, label: 'Hardest first' },
      ],
      order: 'asc' as const,
      showReshuffle: false,
      onSelect: vi.fn(),
      onOrderChange: vi.fn(),
      onReshuffle: vi.fn(),
      ...overrides,
    };
  }

  it('reads a list’s own live count and turns the catalogue count off', () => {
    const { getByText, container, props, rerender } = renderFilterSheet({ liveCount: { count: 3 } });
    expect(getByText('mobile.filter.matchingCount3')).toBeDefined();
    expect(countPreviewMock.enabled.every((enabled) => !enabled)).toBe(true);

    rerender(<ClimbFilterSheet {...props} liveCount={{ count: null }} />);
    expect(container.querySelector('[data-subtitle="true"]')).toBeNull();
  });

  it('keeps the catalogue count on for the Climbs sheet', () => {
    renderFilterSheet();
    expect(countPreviewMock.enabled.at(-1)).toBe(true);
  });

  it('hides the rows a list turns off, and skips their picker wiring', () => {
    const { queryByLabelText, queryByText, queryByTestId } = renderFilterSheet({
      sections: PLAYLIST_SECTIONS,
      boardConfig: { ...boardConfig, boardName: 'woods' },
    });
    expect(queryByLabelText('mobile.filter.setters')).toBeNull();
    expect(queryByLabelText('mobile.holdFilter.title')).toBeNull();
    expect(queryByLabelText('mobile.zoneFilter.title')).toBeNull();
    expect(queryByText('mobile.search.recentFilters')).toBeNull();
    expect(queryByTestId('switch-mobile.filter.otherAngles')).toBeNull();
    expect(queryByTestId('segment-drafts')).toBeNull();
    expect(queryByTestId('segment-liked')).not.toBeNull();
    // Following stays: it needs no picker.
    expect(queryByTestId('switch-authors.followingClimbs')).not.toBeNull();
    expect(createBoardHoldsMocks.prewarmCreateBoardHolds).not.toHaveBeenCalled();
  });

  it('hides the rows that need an active board when the list has none', () => {
    const { queryByText, queryByTestId } = renderFilterSheet({
      boardConfig: null,
      sections: { ...PLAYLIST_SECTIONS, progress: false, liked: false, following: false, beta: false },
    });
    expect(queryByText('mobile.filter.progress.label')).toBeNull();
    expect(queryByText('mobile.filter.myRating')).toBeNull();
    expect(queryByTestId('segment-liked')).toBeNull();
    expect(queryByTestId('switch-authors.followingClimbs')).toBeNull();
    expect(queryByTestId('switch-mobile.filter.betaVideosDescription')).toBeNull();
    // Rows that apply to every climb stay.
    expect(queryByTestId('segment-benchmarks')).not.toBeNull();
    expect(queryByText('mobile.filter.minRating')).not.toBeNull();
  });

  it('keeps Liked on offer while it is the active collection, board or not', () => {
    const { queryByTestId } = renderFilterSheet({
      sections: { ...PLAYLIST_SECTIONS, liked: false },
      currentFilters: { ...currentFilters, onlyFavorited: true },
    });
    expect(queryByTestId('segment-liked')).not.toBeNull();
  });

  it('keeps My drafts on offer while it is the active collection, so it can be undone', () => {
    const { queryByTestId } = renderFilterSheet({
      sections: PLAYLIST_SECTIONS,
      currentFilters: { ...currentFilters, status: 'drafts' },
    });
    expect(queryByTestId('segment-drafts')).not.toBeNull();
  });

  it('shows a list’s own sorts with their directions in words', () => {
    const control = sortControl();
    const { getByLabelText, queryByLabelText, getByTestId, queryByText } = renderFilterSheet({ sortControl: control });
    expect(queryByLabelText('mobile.filter.sort.popular')).toBeNull();
    expect(getByLabelText('Difficulty').getAttribute('aria-pressed')).toBe('true');
    expect(getByTestId('segment-asc').textContent).toBe('Easiest first');
    expect(getByTestId('segment-asc').getAttribute('data-selected')).toBe('true');
    expect(queryByText('mobile.filter.sort.reshuffle')).toBeNull();

    fireEvent.click(getByLabelText('Playlist order'));
    expect(control.onSelect).toHaveBeenCalledWith('position');
    fireEvent.click(getByTestId('segment-desc'));
    expect(control.onOrderChange).toHaveBeenCalledWith('desc');
  });

  it('swaps the directions for Shuffle again, and shows neither for a one-way key', () => {
    const shuffle = sortControl({ selected: 'random', orderOptions: null, showReshuffle: true });
    const { getByText, queryByTestId, unmount } = renderFilterSheet({ sortControl: shuffle });
    expect(queryByTestId('segment-asc')).toBeNull();
    fireEvent.click(getByText('mobile.filter.sort.reshuffle'));
    expect(shuffle.onReshuffle).toHaveBeenCalledTimes(1);
    unmount();

    const oneWay = sortControl({ selected: 'position', active: false, orderOptions: null });
    const rendered = renderFilterSheet({ sortControl: oneWay });
    expect(rendered.queryByTestId('segment-asc')).toBeNull();
    expect(rendered.queryByText('mobile.filter.sort.reshuffle')).toBeNull();
  });

  it('enables Reset for a list’s sort alone, and hands Reset to the list', () => {
    const onReset = vi.fn();
    const onSelectionChange = vi.fn();
    const onClearName = vi.fn();
    const { getByText } = renderFilterSheet({ sortControl: sortControl(), onReset, onSelectionChange, onClearName });
    const reset = getByText('mobile.filter.reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onClearName).not.toHaveBeenCalled();
  });

  it('leaves Reset off for a list at its own defaults', () => {
    const { getByText } = renderFilterSheet({
      sortControl: sortControl({ selected: 'position', active: false, orderOptions: null }),
      boardFit: { value: false, onChange: vi.fn() },
      onReset: vi.fn(),
    });
    expect((getByText('mobile.filter.reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('measures and resets against the list’s defaults when it brings no Reset of its own', () => {
    const onSelectionChange = vi.fn();
    filterActivityMocks.hasActiveClimbFilters.mockImplementation(() => true);
    const { getByText } = renderFilterSheet({ defaultFilters: playlistDefaults, onSelectionChange });
    expect(filterActivityMocks.hasActiveClimbFilters).toHaveBeenCalledWith(expect.anything(), playlistDefaults);
    fireEvent.click(getByText('mobile.filter.reset'));
    expect(onSelectionChange).toHaveBeenLastCalledWith(playlistDefaults, {});
  });

  it('shows "Fits my board" with its own pin, and switches it', () => {
    const onChange = vi.fn();
    const pins = {
      isPinned: (kind: string) => kind === 'boardFit',
      togglePin: vi.fn(),
      pinnable: ['boardFit', 'grade'] as const,
    };
    const { getByTestId, getByLabelText } = renderFilterSheet({ boardFit: { value: false, onChange }, pins });
    const boardFitSwitch = getByTestId('switch-mobile.filter.boardFit.switch');
    expect(boardFitSwitch.getAttribute('data-description')).toBe('mobile.filter.boardFit.description');
    fireEvent.click(boardFitSwitch);
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.click(getByLabelText('mobile.filter.unpinChip'));
    expect(pins.togglePin).toHaveBeenCalledWith('boardFit');
  });

  it('shows no "Fits my board" when the list leaves it out', () => {
    const { queryByTestId } = renderFilterSheet();
    expect(queryByTestId('switch-mobile.filter.boardFit.switch')).toBeNull();
  });

  it('pins through the list’s own store, and only the kinds it can pin', () => {
    const pins = {
      isPinned: (kind: string) => kind === 'grade',
      togglePin: vi.fn(),
      pinnable: ['grade', 'sort'] as const,
    };
    const { getByLabelText, getAllByLabelText } = renderFilterSheet({ pins });
    expect(getAllByLabelText('mobile.filter.pinChip')).toHaveLength(1);
    fireEvent.click(getByLabelText('mobile.filter.unpinChip'));
    expect(pins.togglePin).toHaveBeenCalledWith('grade');
    expect(pinStore.togglePin).not.toHaveBeenCalled();
  });

  it('reads grades from the list’s board and uses its name placeholder', () => {
    const { getByPlaceholderText } = renderFilterSheet({
      boardConfig: null,
      gradeBoardName: 'tension',
      namePlaceholder: 'Climb name',
    });
    expect(countPreviewMock.gradeBoards.at(-1)).toBe('tension');
    expect(getByPlaceholderText('Climb name')).toBeDefined();
  });
});

describe('ClimbFilterSheet native iOS form (#6872)', () => {
  function formRow(sectionKey: string, rowKey: string) {
    const row = filterFormMock.latest?.sections
      .find((section) => section.key === sectionKey)
      ?.rows.find((entry) => entry.key === rowKey);
    if (!row) throw new Error(`no ${sectionKey}/${rowKey} row in the form model`);
    return row;
  }

  function lastFormRow() {
    const section = filterFormMock.latest?.sections.at(-1);
    const row = section?.rows.at(-1);
    if (!section || !row) throw new Error('the form model has no rows');
    return { section, row };
  }

  it('renders the form with a medium and a large detent on iOS with Liquid Glass', () => {
    platformMock.OS = 'ios';
    themeVariantMock.variant = 'liquidGlass';
    const { getByTestId, queryByTestId } = renderFilterSheet();

    expect(getByTestId('native-filter-form')).toBeTruthy();
    expect(queryByTestId('filter-scroll-view')).toBeNull();
    expect(bottomSheetModalProps.latest).toMatchObject({ snapPoints: ['50%', '90%'] });
  });

  it.each([
    ['ios', 'material'],
    ['android', 'liquidGlass'],
  ] as const)('keeps the RN body and one 90%% detent on %s with the %s variant', (platform, variant) => {
    platformMock.OS = platform;
    themeVariantMock.variant = variant;
    const { getByTestId, queryByTestId } = renderFilterSheet();

    expect(getByTestId('filter-scroll-view')).toBeTruthy();
    expect(queryByTestId('native-filter-form')).toBeNull();
    expect(filterFormMock.latest).toBeNull();
    expect((bottomSheetModalProps.latest as { snapPoints?: unknown } | null)?.snapPoints).toEqual(['90%']);
  });

  it('ends the form on a Quick filters row that suspends the sheet and pushes the Climbs route', () => {
    platformMock.OS = 'ios';
    themeVariantMock.variant = 'liquidGlass';
    renderFilterSheet();

    const { section, row } = lastFormRow();
    expect(section.key).toBe('quickFilters');
    expect(row.kind).toBe('nav');
    act(() => {
      row.onPress?.();
    });

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush.mock.calls[0]?.[0]).toBe('/(tabs)/climbs/quick-filters');
    expect(managedSheetProps.latest?.open).toBe(false);
  });

  it('raises the form to its tall detent when the keyboard shows', () => {
    platformMock.OS = 'ios';
    themeVariantMock.variant = 'liquidGlass';
    renderFilterSheet();

    // iPhone listens on the will-change event (sheet-keyboard-inset.ts).
    expect(keyboardListeners.has('keyboardWillChangeFrame')).toBe(true);
    act(() =>
      keyboardListeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { height: 280, screenY: 564, width: 390 } }),
    );

    expect(bottomSheetModalProps.snapToIndex).toHaveBeenCalledWith(1);
  });

  it('leaves the suspended sheet alone when a picker route raises the keyboard', () => {
    platformMock.OS = 'ios';
    themeVariantMock.variant = 'liquidGlass';
    renderFilterSheet();
    act(() => {
      lastFormRow().row.onPress?.();
    });
    expect(managedSheetProps.latest?.open).toBe(false);

    act(() =>
      keyboardListeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { height: 280, screenY: 564, width: 390 } }),
    );

    expect(bottomSheetModalProps.snapToIndex).not.toHaveBeenCalled();
  });

  it('pushes the Discover Quick filters route for the discover picker stack', () => {
    platformMock.OS = 'ios';
    themeVariantMock.variant = 'liquidGlass';
    renderFilterSheet({ pickers: { stack: 'discover', heatmap: false, setterList: null } });

    act(() => {
      lastFormRow().row.onPress?.();
    });

    expect(routerPush.mock.calls[0]?.[0]).toBe('/(tabs)/discover/quick-filters');
    expect(managedSheetProps.latest?.open).toBe(false);
  });

  it('publishes a Progress pick from the form the way the RN chip does', () => {
    platformMock.OS = 'ios';
    themeVariantMock.variant = 'liquidGlass';
    const onSelectionChange = vi.fn();
    renderFilterSheet({ onSelectionChange });

    act(() => {
      formRow('progress', 'progress').onSelect?.('sent');
    });

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(
      {
        ...currentFilters,
        hideAttempted: undefined,
        hideCompleted: undefined,
        showOnlyAttempted: undefined,
        showOnlyCompleted: true,
      },
      currentBoardFilters,
    );
  });
});
