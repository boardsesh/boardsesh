// @vitest-environment jsdom
vi.mock('../../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { createElement, forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  filtersForStatusSegment,
  logbookSortFor,
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';
import type { LogbookBoardOption } from '../use-logbook-board-options';

type PressableProps = {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean };
  disabled?: boolean;
};

const sheetHost = vi.hoisted(() => ({
  onChange: undefined as ((index: number) => void) | undefined,
  dismiss: vi.fn(),
  mountCount: 0,
}));
const managedSheet = vi.hoisted(() => ({ open: undefined as boolean | undefined }));
const layouts = vi.hoisted(() => new Map<string, (event: { nativeEvent: { layout: { y: number } } }) => void>());
const scrollTo = vi.hoisted(() => vi.fn());
const focusEffect = vi.hoisted(() => ({ callback: null as null | (() => void) }));
const pinStore = vi.hoisted(() => ({ pinnedKind: null as string | null, togglePin: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: ({
    children,
    testID,
    onLayout,
  }: {
    children?: ReactNode;
    testID?: string;
    onLayout?: (event: { nativeEvent: { layout: { y: number } } }) => void;
  }) => {
    if (testID && onLayout) layouts.set(testID, onLayout);
    return createElement('div', { 'data-testid': testID }, children);
  },
  Keyboard: {
    addListener: () => ({ remove: () => {} }),
    isVisible: () => false,
    metrics: () => undefined,
  },
  LayoutAnimation: { configureNext: () => {} },
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled }: PressableProps) => {
    const renderedChildren = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        'aria-label': accessibilityLabel,
        'aria-selected': accessibilityState?.selected,
        disabled,
      },
      renderedChildren,
    );
  },
  TextInput: ({
    value,
    onChangeText,
    placeholder,
    accessibilityLabel,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    accessibilityLabel?: string;
  }) =>
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
    absoluteFill: {},
  },
}));

vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => {
    focusEffect.callback = callback;
  },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef<{ dismiss: () => void }, { children?: ReactNode; onChange?: (index: number) => void }>(
    function BottomSheetModal({ children, onChange }, ref) {
      sheetHost.onChange = onChange;
      useImperativeHandle(ref, () => ({ dismiss: sheetHost.dismiss }), []);
      useState(() => {
        sheetHost.mountCount += 1;
        return null;
      });
      return createElement('div', null, children);
    },
  ),
  BottomSheetScrollView: forwardRef<{ scrollTo: () => void }, { children?: ReactNode }>(function BottomSheetScrollView(
    { children },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollTo }), []);
    return createElement('div', null, children);
  }),
}));

vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ open, onClose }: { open?: boolean; onClose?: () => void }) => {
    managedSheet.open = open;
    return {
      onChange: (index: number) => {
        if (index === -1) onClose?.();
      },
      onFullyDismissed: () => {},
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

// Returns the key with its interpolated values, so a pin's label names its control.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options == null ? key : `${key}:${Object.values(options).join(',')}`,
  }),
}));

vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({
    title,
    subtitle,
    leading,
    trailing,
  }: {
    title: string;
    subtitle?: string;
    leading?: { onPress: () => void };
    trailing?: { label: string; onPress: () => void; disabled?: boolean };
  }) =>
    createElement(
      'div',
      { 'data-testid': 'top-bar', 'data-title': title },
      subtitle ? createElement('span', { 'data-testid': 'subtitle' }, subtitle) : null,
      leading ? createElement('button', { 'data-testid': 'close', onClick: leading.onPress }, 'close') : null,
      trailing
        ? createElement(
            'button',
            {
              'data-testid': 'reset',
              disabled: trailing.disabled,
              onClick: trailing.disabled ? undefined : trailing.onPress,
            },
            trailing.label,
          )
        : null,
    ),
}));

vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
    accessibilityLabel,
  }: {
    options: { key: string; label: string }[];
    selectedKey: string;
    onSelect: (key: string) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': `segments-${accessibilityLabel}`, 'data-selected': selectedKey },
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, 'data-testid': `segment-${option.key}`, onClick: () => onSelect(option.key) },
          option.label,
        ),
      ),
    ),
}));

vi.mock('../../StarRating', () => ({
  StarRating: ({ value, onChange }: { value: number | undefined; onChange: (stars: number | undefined) => void }) =>
    createElement(
      'div',
      { 'data-testid': 'stars', 'data-value': String(value) },
      [1, 2, 3, 4, 5].map((stars) =>
        createElement('button', { key: stars, 'data-testid': `star-${stars}`, onClick: () => onChange(stars) }),
      ),
    ),
}));

vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement(
      'button',
      { 'data-testid': `switch-${label}`, 'data-value': String(value), onClick: () => onValueChange(!value) },
      label,
    ),
}));

vi.mock('../../grade', () => ({
  GradeRangeRail: ({ onChange }: { onChange: (bound: { minGradeId?: number; maxGradeId?: number }) => void }) =>
    createElement('button', {
      'data-testid': 'grade-rail',
      onClick: () => onChange({ minGradeId: 16, maxGradeId: 18 }),
    }),
}));

vi.mock('../../filter-sheet/AngleRangeRail', () => ({
  AngleRangeRail: ({
    value,
    onChange,
  }: {
    value: readonly [number, number] | null;
    onChange: (next: [number, number] | null) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'angle-rail', 'data-value': JSON.stringify(value) },
      createElement('button', { 'data-testid': 'angle-40', onClick: () => onChange([40, 40]) }),
      createElement('button', { 'data-testid': 'angle-any', onClick: () => onChange(null) }),
    ),
}));

vi.mock('../logbook-facet-controls', () => ({
  DateRangeRow: ({
    label,
    onChange,
    minimumDate,
    maximumDate,
  }: {
    label: string;
    onChange: (iso: string) => void;
    minimumDate?: Date;
    maximumDate?: Date;
  }) =>
    createElement('button', {
      'data-testid': `date-${label}`,
      'data-min': minimumDate ? minimumDate.toDateString() : '',
      'data-max': maximumDate ? maximumDate.toDateString() : '',
      onClick: () => onChange('2026-06-10'),
    }),
}));

vi.mock('../../../lib/logbook-pinned-chips-store', () => ({
  useLogbookPinnedChips: () => ({
    pinned: pinStore.pinnedKind ? [pinStore.pinnedKind] : [],
    loaded: true,
    isPinned: (kind: string) => kind === pinStore.pinnedKind,
    togglePin: pinStore.togglePin,
  }),
}));

vi.mock('../../use-sheet-column-style', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../use-sheet-column-style')>()),
  useSheetColumnStyle: () => ({ height: 701 }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { fill: '#eee', tertiaryBackground: '#fff', separator: '#ccc', tertiaryLabel: '#999', label: '#000' },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#fff' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));

import { LogbookFilterSheet } from '../LogbookFilterSheet';

const TODAY = new Date(2026, 5, 20);

const TWO_BOARDS: LogbookBoardOption[] = [
  {
    boardType: 'kilter',
    label: 'Kilter',
    layouts: [
      { layoutId: 1, label: 'Kilter Original' },
      { layoutId: 8, label: 'Kilter Homewall' },
    ],
  },
  { boardType: 'tension', label: 'Tension', layouts: [{ layoutId: 10, label: 'Tension 2 Mirror' }] },
];

type SheetProps = Parameters<typeof LogbookFilterSheet>[0];

// The real parent applies every change at once and hands the result back in
// props. The harness does the same, so the tests see the live-apply contract.
function LiveHarness(props: SheetProps) {
  const [filters, setFilters] = useState(props.filters);
  const [sort, setSort] = useState(props.sort);
  return createElement(LogbookFilterSheet, {
    ...props,
    filters,
    sort,
    onChangeFilters: (patch: Partial<LogbookFilterState>) => {
      props.onChangeFilters(patch);
      setFilters((previous) => ({ ...previous, ...patch }));
    },
    onChangeSort: (nextSort: LogbookSortState) => {
      props.onChangeSort(nextSort);
      setSort(nextSort);
    },
  });
}

function renderSheet(overrides: Partial<SheetProps> = {}) {
  const props: SheetProps = {
    onDismiss: vi.fn(),
    filters: DEFAULT_LOGBOOK_FILTERS,
    sort: DEFAULT_LOGBOOK_SORT,
    name: '',
    viewerIsOwner: true,
    grades: [],
    boardOptions: TWO_BOARDS,
    matchCount: null,
    today: TODAY,
    onChangeFilters: vi.fn(),
    onChangeSort: vi.fn(),
    onNameChange: vi.fn(),
    onClearName: vi.fn(),
    onReset: vi.fn(),
    onOpenSetters: vi.fn((beforePush: () => void) => {
      beforePush();
      return true;
    }),
    ...overrides,
  };
  return { props, ...render(createElement(LiveHarness, props)) };
}

beforeEach(() => {
  sheetHost.onChange = undefined;
  sheetHost.dismiss.mockReset();
  sheetHost.mountCount = 0;
  managedSheet.open = undefined;
  focusEffect.callback = null;
  pinStore.pinnedKind = null;
  pinStore.togglePin.mockReset();
  layouts.clear();
  scrollTo.mockReset();
});

describe('LogbookFilterSheet header', () => {
  it('titles the sheet and says how many entries match', () => {
    const { getByTestId } = renderSheet({ matchCount: 12 });
    expect(getByTestId('top-bar').getAttribute('data-title')).toBe('mobile.logbook.filterSheet.title');
    expect(getByTestId('subtitle').textContent).toBe('mobile.logbook.filterSheet.entryCount:12');
  });

  it('shows no count without an honest one (loading, or the date feed)', () => {
    const { queryByTestId } = renderSheet();
    expect(queryByTestId('subtitle')).toBeNull();
  });

  it('greys Reset out until something is set, the name included', () => {
    expect((renderSheet().getByTestId('reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Reset for a typed name, and Reset clears the field and asks the parent to reset', () => {
    const { getByTestId, getByLabelText, props } = renderSheet();
    const field = getByLabelText('mobile.logbook.filterSheet.sectionName') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'crimp' } });
    expect(props.onNameChange).toHaveBeenCalledWith('crimp');
    expect((getByTestId('reset') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByTestId('reset'));
    expect(props.onReset).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('');
  });

  it('enables Reset for a filter or a sort alone', () => {
    expect(
      (
        renderSheet({ filters: { ...DEFAULT_LOGBOOK_FILTERS, benchmarkOnly: true } }).getByTestId(
          'reset',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('enables Reset for a non-default sort', () => {
    const { getByTestId } = renderSheet({ sort: logbookSortFor('grade', 'desc') });
    expect((getByTestId('reset') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('live apply', () => {
  it('commits each control as it changes, and X only closes', () => {
    const { getByTestId, props } = renderSheet();
    fireEvent.click(getByTestId('segment-flashes'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith(filtersForStatusSegment('flashes'));
    fireEvent.click(getByTestId('grade-rail'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ minGrade: 16, maxGrade: 18 });

    vi.mocked(props.onChangeFilters).mockClear();
    fireEvent.click(getByTestId('close'));
    expect(sheetHost.dismiss).toHaveBeenCalledTimes(1);
    expect(props.onChangeFilters).not.toHaveBeenCalled();
    // The native close lands after the slide-down; only then does the parent let go.
    act(() => sheetHost.onChange?.(-1));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clears the committed name from the field ×', () => {
    const { getByLabelText, props } = renderSheet({ name: 'crimp' });
    const field = getByLabelText('mobile.logbook.filterSheet.sectionName') as HTMLInputElement;
    expect(field.value).toBe('crimp');
    fireEvent.click(getByLabelText('actions.clear'));
    expect(props.onClearName).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('');
  });
});

describe('Your ascents', () => {
  it('drives the four status segments from the stored fields', () => {
    const { getByTestId, props } = renderSheet({ filters: { ...DEFAULT_LOGBOOK_FILTERS, flashOnly: true } });
    const segments = getByTestId('segments-mobile.logbook.filterSheet.status');
    expect(segments.getAttribute('data-selected')).toBe('flashes');
    fireEvent.click(getByTestId('segment-attempts'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({
      includeSends: false,
      includeAttempts: true,
      flashOnly: false,
    });
    expect(segments.getAttribute('data-selected')).toBe('attempts');
    fireEvent.click(getByTestId('segment-all'));
    expect(segments.getAttribute('data-selected')).toBe('all');
  });

  it('sets a minimum star rating and clears it from Any', () => {
    const { getByTestId, getByLabelText, props } = renderSheet();
    fireEvent.click(getByTestId('star-3'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ minQuality: 3 });
    expect(getByTestId('stars').getAttribute('data-value')).toBe('3');
    fireEvent.click(getByLabelText('mobile.logbook.filterSheet.anyStars'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ minQuality: '' });
    expect(getByTestId('stars').getAttribute('data-value')).toBe('undefined');
  });

  it('picks a rolling window, and shows the From / To rows only for Custom', () => {
    const { getByLabelText, queryByTestId, props } = renderSheet();
    expect(queryByTestId('date-mobile.logbook.dateFrom')).toBeNull();
    fireEvent.click(getByLabelText('mobile.logbook.dateWindow.month'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ dateWindow: 'month' });
    fireEvent.click(getByLabelText('mobile.logbook.dateWindow.custom'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ dateWindow: 'custom' });
    expect(queryByTestId('date-mobile.logbook.dateFrom')).not.toBeNull();
    expect(queryByTestId('date-mobile.logbook.dateTo')).not.toBeNull();
  });

  it('keeps From before To and both before today', () => {
    const { getByTestId, props } = renderSheet({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, dateWindow: 'custom', fromDate: '2026-06-03', toDate: '2026-06-12' },
    });
    const from = getByTestId('date-mobile.logbook.dateFrom');
    const to = getByTestId('date-mobile.logbook.dateTo');
    expect(from.getAttribute('data-max')).toBe(new Date(2026, 5, 12).toDateString());
    expect(to.getAttribute('data-min')).toBe(new Date(2026, 5, 3).toDateString());
    expect(to.getAttribute('data-max')).toBe(TODAY.toDateString());
    fireEvent.click(from);
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ fromDate: '2026-06-10', dateWindow: 'custom' });
  });

  it('caps From at today while To is open', () => {
    const { getByTestId } = renderSheet({ filters: { ...DEFAULT_LOGBOOK_FILTERS, dateWindow: 'custom' } });
    expect(getByTestId('date-mobile.logbook.dateFrom').getAttribute('data-max')).toBe(TODAY.toDateString());
    expect(getByTestId('date-mobile.logbook.dateTo').getAttribute('data-min')).toBe('');
  });

  it('says "Their" on someone else\'s logbook', () => {
    const { queryByText, getByText } = renderSheet({ viewerIsOwner: false });
    expect(getByText('mobile.logbook.filterSheet.sectionTheirAscents')).toBeTruthy();
    expect(getByText('mobile.logbook.filterSheet.theirStars')).toBeTruthy();
    expect(getByText('mobile.logbook.filterSheet.sortKey.theirGrade')).toBeTruthy();
    expect(queryByText('mobile.logbook.filterSheet.sectionYourAscents')).toBeNull();
    expect(queryByText('mobile.logbook.filterSheet.yourStars')).toBeNull();
    expect(queryByText('mobile.logbook.filterSheet.sortKey.yourGrade')).toBeNull();
  });
});

describe('The climb', () => {
  it('hides Board for a climber with one board', () => {
    const { queryByLabelText } = renderSheet({ boardOptions: TWO_BOARDS.slice(0, 1) });
    expect(queryByLabelText('mobile.filter.allBoards')).toBeNull();
  });

  it('offers All boards and each board, then Layout chips for a board with two or more layouts', () => {
    const { getByLabelText, queryByLabelText, props } = renderSheet();
    expect(queryByLabelText('mobile.logbook.filterSheet.allLayouts')).toBeNull();
    fireEvent.click(getByLabelText('Kilter'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ boardType: 'kilter', layoutIds: [] });
    fireEvent.click(getByLabelText('Kilter Homewall'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ layoutIds: [8] });
    fireEvent.click(getByLabelText('Kilter Original'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ layoutIds: [8, 1] });
    fireEvent.click(getByLabelText('Kilter Homewall'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ layoutIds: [1] });
    fireEvent.click(getByLabelText('mobile.logbook.filterSheet.allLayouts'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ layoutIds: [] });
    // A one-layout board has nothing to pick.
    fireEvent.click(getByLabelText('Tension'));
    expect(queryByLabelText('mobile.logbook.filterSheet.allLayouts')).toBeNull();
    fireEvent.click(getByLabelText('mobile.filter.allBoards'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ boardType: '', layoutIds: [] });
  });

  it('keeps a saved board that is no longer offered, so it can be cleared', () => {
    const { getByLabelText } = renderSheet({
      boardOptions: TWO_BOARDS.slice(0, 1),
      filters: { ...DEFAULT_LOGBOOK_FILTERS, boardType: 'moonboard' },
    });
    expect(getByLabelText('MoonBoard').getAttribute('aria-selected')).toBe('true');
  });

  it('feeds the angle rail and widens Any back to the whole board', () => {
    const { getByTestId, props } = renderSheet();
    expect(getByTestId('angle-rail').getAttribute('data-value')).toBe('null');
    fireEvent.click(getByTestId('angle-40'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ angleRange: [40, 40] });
    expect(getByTestId('angle-rail').getAttribute('data-value')).toBe('[40,40]');
    fireEvent.click(getByTestId('angle-any'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ angleRange: [-5, 70] });
  });

  it('names the picked setters on the row, and suspends before the picker opens', () => {
    const { getByLabelText, props } = renderSheet({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, setterUsernames: ['alex', 'sam'] },
    });
    const setterRows = document.querySelectorAll('[aria-label="mobile.logbook.filterSheet.setter"]');
    expect(setterRows).toHaveLength(1);
    expect(setterRows[0].textContent).toContain('mobile.logbook.capsules.setters:2');
    expect(managedSheet.open).toBe(true);
    fireEvent.click(getByLabelText('mobile.logbook.filterSheet.setter'));
    expect(props.onOpenSetters).toHaveBeenCalledTimes(1);
    // Suspended: the native sheet is told to close without unmounting.
    expect(managedSheet.open).toBe(false);
    // The close that suspension causes is not the climber closing the sheet.
    act(() => sheetHost.onChange?.(-1));
    expect(props.onDismiss).not.toHaveBeenCalled();
    // Back from the picker: the sheet re-presents under a fresh host.
    const mountsBefore = sheetHost.mountCount;
    act(() => focusEffect.callback?.());
    expect(managedSheet.open).toBe(true);
    expect(sheetHost.mountCount).toBe(mountsBefore + 1);
  });

  it('stays put when the picker refuses to open', () => {
    const onOpenSetters = vi.fn(() => false);
    const { getByLabelText } = renderSheet({ onOpenSetters });
    fireEvent.click(getByLabelText('mobile.logbook.filterSheet.setter'));
    expect(onOpenSetters).toHaveBeenCalledTimes(1);
    // Not suspended: the sheet is still the one on screen.
    expect(managedSheet.open).toBe(true);
  });

  it('reads Any with no setter picked', () => {
    renderSheet();
    expect(document.querySelector('[aria-label="mobile.logbook.filterSheet.setter"]')?.textContent).toContain(
      'mobile.logbook.filterSheet.setterAny',
    );
  });

  it('switches Benchmarks', () => {
    const { getByTestId, props } = renderSheet();
    fireEvent.click(getByTestId('switch-mobile.logbook.filterSheet.onlyBenchmarks'));
    expect(props.onChangeFilters).toHaveBeenLastCalledWith({ benchmarkOnly: true });
  });
});

describe('opening on When', () => {
  const layOut = () =>
    act(() => {
      layouts.get('logbook-filter-ascents')?.({ nativeEvent: { layout: { y: 400 } } });
      layouts.get('logbook-filter-when')?.({ nativeEvent: { layout: { y: 180 } } });
    });

  it('scrolls the When block to the top once it is measured, and only once', () => {
    renderSheet({ initialSection: 'when', filters: { ...DEFAULT_LOGBOOK_FILTERS, dateWindow: 'custom' } });
    layOut();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The section's offset plus the block's, less a 12pt breath above the label.
    expect(scrollTo).toHaveBeenCalledWith({ y: 568, animated: false });
    layOut();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('opens at the top otherwise', () => {
    renderSheet();
    layOut();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('Sort', () => {
  it('keeps the order when the key changes, and keeps the key when the order changes', () => {
    const { getByLabelText, getByTestId, props } = renderSheet();
    fireEvent.click(getByLabelText('mobile.logbook.filterSheet.sortKey.name'));
    expect(props.onChangeSort).toHaveBeenLastCalledWith(logbookSortFor('climbName', 'desc'));
    fireEvent.click(getByTestId('segment-asc'));
    expect(props.onChangeSort).toHaveBeenLastCalledWith(logbookSortFor('climbName', 'asc'));
    fireEvent.click(getByLabelText('mobile.logbook.filterSheet.sortKey.grade'));
    expect(props.onChangeSort).toHaveBeenLastCalledWith(logbookSortFor('grade', 'asc'));
    expect(getByTestId('segments-mobile.logbook.filterSheet.order').getAttribute('data-selected')).toBe('asc');
  });
});

describe('pins', () => {
  const PIN_LABELS: Array<[string, string]> = [
    ['grade', 'mobile.logbook.filterSheet.gradeRange'],
    ['status', 'mobile.logbook.filterSheet.status'],
    ['stars', 'mobile.logbook.filterSheet.yourStars'],
    ['date', 'mobile.logbook.filterSheet.when'],
    ['board', 'mobile.logbook.filterSheet.board'],
    ['angle', 'mobile.logbook.angle'],
    ['setter', 'mobile.logbook.filterSheet.setter'],
    ['benchmarks', 'mobile.logbook.filterSheet.benchmarks'],
    ['sort', 'mobile.logbook.filterSheet.sortBy'],
  ];

  it.each(PIN_LABELS)('wires the %s pin to its own kind', (kind, label) => {
    const { getByLabelText } = renderSheet();
    fireEvent.click(getByLabelText(`mobile.filter.pinChip:${label}`));
    expect(pinStore.togglePin).toHaveBeenCalledWith(kind);
  });

  it('shows Unpin on the pinned kind only', () => {
    pinStore.pinnedKind = 'stars';
    const { getByLabelText, queryByLabelText } = renderSheet();
    expect(getByLabelText('mobile.filter.unpinChip:mobile.logbook.filterSheet.yourStars')).toBeTruthy();
    expect(queryByLabelText('mobile.filter.unpinChip:mobile.logbook.filterSheet.gradeRange')).toBeNull();
  });
});
