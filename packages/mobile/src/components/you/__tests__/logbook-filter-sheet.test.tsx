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
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';

type PressableProps = {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  disabled?: boolean;
};

// react-native: minimal host shims. Platform.OS is read per-render by DateRangeRow
// (and once by androidSafeSnapPoints via useMemo), so a hoisted mutable object lets
// each test set it before render.
const nativePlatform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', () => ({
  Platform: nativePlatform,
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

// The sheet commits the draft on close (there's no Apply button). The component
// drives close through the coordinator's onChange(-1) (see the useManagedSheet
// mock below, which forwards -1 to onClose → handleDismiss → onApply), so capture
// the onChange it hands BottomSheetModal — a test fires -1 to simulate the
// swipe/scrim close. Children render inline.
const sheetMock = vi.hoisted(() => ({ onChange: undefined as ((index: number) => void) | undefined }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: ({ children, onChange }: { children?: ReactNode; onChange?: (index: number) => void }) => {
    sheetMock.onChange = onChange;
    return createElement('div', null, children);
  },
  BottomSheetScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

// Isolate the sheet from the presentation coordinator (its serialization is
// covered by sheet-presentation-provider.test.tsx). These tests drive Apply /
// Reset through the component's own controls, so a no-op managed handle is enough.
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: ({ onClose }: { onClose?: () => void }) => ({
    onChange: (index: number) => {
      if (index === -1) onClose?.();
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

// datetimepicker: the inline iOS picker fires onChange when clicked; the Android
// imperative dialog is unused by these iOS-focused tests but must export.
const dateTimePickerSelection = vi.hoisted(() => ({ date: new Date(2026, 0, 15, 0, 0, 0, 0) }));
vi.mock('@react-native-community/datetimepicker', () => ({
  default: ({
    onChange,
    accessibilityLabel,
  }: {
    onChange: (event: unknown, date?: Date) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      {
        'data-testid': 'date-picker',
        'aria-label': accessibilityLabel,
        onClick: () => onChange({ type: 'set' }, dateTimePickerSelection.date),
      },
      'picker',
    ),
  DateTimePickerAndroid: { open: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// SegmentedControl drives both the preset sort and the status filter. Keying the
// option buttons off accessibilityLabel lets a test target the right control
// (sort = `mobile.logbook.sort`, status = `mobile.logbook.statusLabel`).
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
    accessibilityLabel,
  }: {
    options: Array<{ key: string; label: string }>;
    onSelect: (key: string) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': `segmented-${accessibilityLabel ?? 'unlabeled'}` },
      ...options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'data-testid': `segment-${accessibilityLabel ?? 'unlabeled'}-${option.key}`,
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

// Render section children inline so the status control and date rows inside the
// (default-expanded Refine / Advanced) sections are always reachable.
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({ children, title }: { children?: ReactNode; title: string }) =>
    createElement('section', { 'data-testid': `section-${title}` }, children),
}));

vi.mock('../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../grade', () => ({ GradeRangeRail: () => null, readableTextColor: () => '#000000' }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: [] }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#111', secondaryLabel: '#666', separator: '#ccc' },
    brandColors: { primary: '#6D28D9', accent: '#FFB000', onPrimary: '#fff' },
    chartColors: { separator: '#ccc' },
  }),
}));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { separator: '#ccc', systemGray: '#999', black: '#000' },
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: { lg: 12 },
}));

import { LogbookFilterSheet } from '../LogbookFilterSheet';

function renderSheet(overrides: Partial<Parameters<typeof LogbookFilterSheet>[0]> = {}) {
  const props: Parameters<typeof LogbookFilterSheet>[0] = {
    onDismiss: vi.fn(),
    currentFilters: DEFAULT_LOGBOOK_FILTERS,
    currentSort: DEFAULT_LOGBOOK_SORT,
    onApply: vi.fn(),
    onClearSearch: vi.fn(),
    ...overrides,
  };
  return { ...render(createElement(LogbookFilterSheet, props)), props };
}

function lastApply(onApply: ReturnType<typeof vi.fn>): {
  filters: LogbookFilterState;
  sort: LogbookSortState;
} {
  const calls = onApply.mock.calls;
  const [filters, sort] = calls[calls.length - 1] as [LogbookFilterState, LogbookSortState];
  return { filters, sort };
}

// Close the sheet (swipe/scrim) — a coordinator onChange(-1) → onClose →
// handleDismiss, which commits the draft via onApply.
function closeSheet() {
  act(() => sheetMock.onChange?.(-1));
}

beforeEach(() => {
  vi.clearAllMocks();
  nativePlatform.OS = 'ios';
  dateTimePickerSelection.date = new Date(2026, 0, 15, 0, 0, 0, 0);
});

describe('LogbookFilterSheet', () => {
  // Behavior 1: selecting the "Hardest" preset and applying commits a preset
  // sort with mode 'preset' / preset 'hardest'.
  it('applies the hardest preset sort', () => {
    const onApply = vi.fn();
    const { getByTestId } = renderSheet({ onApply });

    fireEvent.click(getByTestId('segment-mobile.logbook.sort-hardest'));
    closeSheet();

    const { sort } = lastApply(onApply);
    expect(sort.mode).toBe('preset');
    expect(sort.preset).toBe('hardest');
  });

  // Behavior 2: starting from flashOnly=true, switching status to attempts-only
  // drops includeSends AND auto-clears the now-hidden flashOnly flag.
  it('auto-clears flashOnly when sends are deselected', () => {
    const onApply = vi.fn();
    const { getByTestId } = renderSheet({
      onApply,
      currentFilters: { ...DEFAULT_LOGBOOK_FILTERS, includeSends: true, includeAttempts: true, flashOnly: true },
    });

    fireEvent.click(getByTestId('segment-mobile.logbook.statusLabel-attempts'));
    closeSheet();

    const { filters } = lastApply(onApply);
    expect(filters.includeSends).toBe(false);
    expect(filters.includeAttempts).toBe(true);
    expect(filters.flashOnly).toBe(false);
  });

  // Behavior 3: Reset clears the toolbar search and, on the next Apply, commits
  // the package defaults for both filters and sort. The Reset control is in the
  // header with no accessibilityLabel, so it's targeted by its text key.
  it('resets to defaults and clears the search', () => {
    const onApply = vi.fn();
    const onClearSearch = vi.fn();
    const { getByText, getByTestId } = renderSheet({
      onApply,
      onClearSearch,
      // Start dirty so a no-op Reset would be observable as a failure.
      currentFilters: { ...DEFAULT_LOGBOOK_FILTERS, includeSends: false, benchmarkOnly: true },
      currentSort: { ...DEFAULT_LOGBOOK_SORT, mode: 'preset', preset: 'hardest' },
    });

    // Sanity: the dirty preset is reflected before reset.
    expect(getByTestId('segment-mobile.logbook.sort-hardest')).toBeTruthy();

    fireEvent.click(getByText('mobile.logbook.reset'));
    expect(onClearSearch).toHaveBeenCalledTimes(1);

    closeSheet();

    const { filters, sort } = lastApply(onApply);
    expect(filters).toEqual(DEFAULT_LOGBOOK_FILTERS);
    expect(sort).toEqual(DEFAULT_LOGBOOK_SORT);
  });

  // Behavior 4: an empty fromDate on iOS shows a tappable "reveal" affordance
  // (not a committed date). Applying without touching it keeps fromDate ''.
  it('does not inject a date when the empty From field is left untouched', () => {
    const onApply = vi.fn();
    const { getByLabelText } = renderSheet({
      onApply,
      currentFilters: { ...DEFAULT_LOGBOOK_FILTERS, fromDate: '' },
    });

    // With fromDate '' and no reveal, the From row renders a Pressable labelled
    // by the field label, not an inline date picker.
    expect(getByLabelText('mobile.logbook.dateFrom')).toBeTruthy();

    closeSheet();

    const { filters } = lastApply(onApply);
    expect(filters.fromDate).toBe('');
  });

  // Behavior 5: a programmatic close (parent unmounts the sheet without a
  // pan-down / scrim onChange(-1)) still commits the in-progress draft, so an
  // edit isn't discarded silently.
  it('commits the draft on unmount when closed programmatically', () => {
    const onApply = vi.fn();
    const { getByTestId, unmount } = renderSheet({ onApply });

    fireEvent.click(getByTestId('segment-mobile.logbook.sort-hardest'));
    // No closeSheet() — the parent just unmounts.
    unmount();

    expect(onApply).toHaveBeenCalledTimes(1);
    const { sort } = lastApply(onApply);
    expect(sort.preset).toBe('hardest');
  });

  // Behavior 5 (continued): a user pan-down that already committed must not
  // double-apply when the parent then unmounts the sheet.
  it('does not double-commit when a user close is followed by unmount', () => {
    const onApply = vi.fn();
    const { getByTestId, unmount } = renderSheet({ onApply });

    fireEvent.click(getByTestId('segment-mobile.logbook.sort-hardest'));
    closeSheet();
    unmount();

    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // Behavior 4 (continued): tapping the From field reveals the picker but still
  // commits nothing until a date is actually picked — Apply leaves fromDate ''.
  it('reveals the From picker without committing a date until one is picked', () => {
    const onApply = vi.fn();
    const { getByLabelText, getByTestId, queryByTestId } = renderSheet({
      onApply,
      currentFilters: { ...DEFAULT_LOGBOOK_FILTERS, fromDate: '' },
    });

    // Before reveal: no inline date picker for the From row.
    expect(queryByTestId('date-picker')).toBeNull();

    // Tap the From reveal Pressable (labelled 'mobile.logbook.dateFrom'). The To
    // row already shows a committed picker only if it has a value; here both From
    // and To are empty, so this label is unique to the From reveal Pressable.
    fireEvent.click(getByLabelText('mobile.logbook.dateFrom'));

    // After reveal the inline picker exists, but onChange has NOT fired.
    expect(getByTestId('date-picker')).toBeTruthy();

    // Close without picking a date: fromDate stays ''.
    closeSheet();

    const { filters } = lastApply(onApply);
    expect(filters.fromDate).toBe('');
  });
});
