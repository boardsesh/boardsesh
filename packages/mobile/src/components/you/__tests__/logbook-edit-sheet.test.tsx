// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AscentFeedItem, UpdateTickInput } from '@boardsesh/graphql/operations';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';

const mutations = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

const pickerSelections = vi.hoisted(() => ({
  date: new Date(2026, 0, 9, 0, 0, 0, 0),
  time: new Date(2026, 0, 9, 20, 15, 0, 0),
}));

const nativePlatform = vi.hoisted(() => ({
  OS: 'ios' as 'ios' | 'android',
}));

// What the edit sheet hands its `Sheet` chrome — asserted so the Android
// content-fitting opt-in (#4720) can't be dropped silently.
const sheetProps = vi.hoisted(() => ({
  androidContentSized: undefined as boolean | undefined,
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

const dateTimePickerAndroid = vi.hoisted(() => ({
  open: vi.fn(
    ({ mode, onChange }: { mode: 'date' | 'time'; onChange: (event: { type: 'set' }, selectedDate?: Date) => void }) =>
      onChange({ type: 'set' }, mode === 'date' ? pickerSelections.date : pickerSelections.time),
  ),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => createElement('button', { 'aria-label': accessibilityLabel, disabled, onClick: () => onPress?.() }, children),
  Alert: { alert: vi.fn() },
  Platform: nativePlatform,
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
  },
  // The tick rows read the OS text scale to decide whether to stack. Held at 1
  // so the two-seam layout is what these tests exercise.
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({
    value,
    onChangeText,
    placeholder,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    placeholder?: string;
    accessibilityLabel?: string;
  }) =>
    createElement('textarea', {
      placeholder,
      'aria-label': accessibilityLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  default: ({ mode, onChange }: { mode: 'date' | 'time'; onChange: (event: unknown, selectedDate?: Date) => void }) =>
    createElement(
      'button',
      {
        'data-testid': `picker-${mode}`,
        onClick: () => onChange({ type: 'set' }, mode === 'date' ? pickerSelections.date : pickerSelections.time),
      },
      mode,
    ),
  DateTimePickerAndroid: dateTimePickerAndroid,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-react', () => ({
  useUpdateTick: () => ({ mutate: mutations.updateMutate, isPending: false }),
  useDeleteTick: () => ({ mutate: mutations.deleteMutate, isPending: false }),
}));
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock('../../Sheet', () => ({
  Sheet: ({
    children,
    header,
    footer,
    androidContentSized,
  }: {
    children?: ReactNode;
    header?: ReactNode;
    footer?: ReactNode;
    androidContentSized?: boolean;
  }) => {
    sheetProps.androidContentSized = androidContentSized;
    return createElement('div', null, header, children, footer);
  },
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => createElement('button', { 'aria-label': accessibilityLabel, disabled, onClick: () => onPress?.() }, children),
}));
vi.mock('../../StarRating', () => ({ StarRating: () => null }));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: Array<{ key: string; label: string }>;
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      null,
      ...options.map((option) =>
        createElement(
          'button',
          { key: option.key, 'data-testid': `status-${option.key}`, onClick: () => onSelect(option.key) },
          option.label,
        ),
      ),
    ),
}));
// The tries rail's chip. Kept as a stand-in so the rail's own geometry (layout
// measurement, snap offsets) stays out of a jsdom tree while its selection
// behaviour still runs for real.
vi.mock('../../grade/GradeChip', () => ({
  GradeChip: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement('button', { 'data-testid': `tries-${label}`, onClick: onPress }, label),
}));
vi.mock('../../grade', () => ({ GradeSingleSelectRail: () => null }));
vi.mock('@boardsesh/board-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-config')>();
  return {
    ...actual,
    ANGLES: { kilter: [25, 30, 40, 45], tension: [25, 30, 40, 45] },
  };
});
vi.mock('../../play-drawer/AngleSlider', () => ({
  AngleSlider: ({ angles, onChange }: { angles: number[]; value: number; onChange: (angle: number) => void }) =>
    createElement(
      'div',
      null,
      ...angles.map((angle) =>
        createElement(
          'button',
          { key: angle, 'data-testid': `angle-option-${angle}`, onClick: () => onChange(angle) },
          `${angle}°`,
        ),
      ),
    ),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: [] }) }));
vi.mock('../../../lib/haptics', () => ({
  hapticSuccess: vi.fn(),
  hapticError: vi.fn(),
  hapticSelection: vi.fn(),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    systemColors: {
      fill: '#eee',
      label: '#111',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#ddd',
      secondaryBackground: '#fff',
    },
    brandColors: {
      primary: '#6D28D9',
      primaryFill: '#6D28D9',
      onPrimary: '#FFFFFF',
      warning: '#B45309',
      error: '#C81E1E',
    },
    spacing: new Proxy({}, { get: () => 0 }),
    borderRadius: new Proxy({}, { get: () => 0 }),
    opacity: { disabled: 0.4 },
    textStyles: { subheadline: {} },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: new Proxy({}, { get: () => 0 }),
}));

import { LogbookEditSheet } from '../LogbookEditSheet';

function makeAscent(overrides: Partial<AscentFeedItem> = {}): AscentFeedItem {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    climbName: 'Moon Patrol',
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 1,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 3,
    quality: 4,
    difficulty: 20,
    difficultyName: 'V5',
    consensusDifficulty: 20,
    consensusDifficultyName: 'V5',
    boardseshDifficulty: null,
    boardseshConfidence: null,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: new Date(2026, 0, 8, 10, 5, 0, 0).toISOString(),
    frames: null,
    hasBetaVideo: null,
    ...overrides,
  };
}

function renderSheet(ascent = makeAscent()) {
  const sheetRef = { current: null };
  return render(
    createElement(LogbookEditSheet, {
      sheetRef,
      ascent,
      onClose: vi.fn(),
    }),
  );
}

function save() {
  fireEvent.click(screen.getByText('mobile.tick.save'));
}

function firstUpdateVariables(): { uuid: string; input: UpdateTickInput } {
  const [variables] = mutations.updateMutate.mock.calls[0] as [{ uuid: string; input: UpdateTickInput }, unknown];
  return variables;
}

function expectSavedClimbedAt(isoTimestamp: string | undefined) {
  expect(isoTimestamp).toBeDefined();
  if (!isoTimestamp) return;
  expect(formatTickAbsoluteTime(isoTimestamp, 'YYYY-MM-DD HH:mm')).toBe('2026-01-09 20:15');
}

function expectClimbedAtIso(isoTimestamp: string | undefined, expectedDate: Date) {
  expect(isoTimestamp).toBeDefined();
  if (!isoTimestamp) return;
  expect(isoTimestamp).toBe(expectedDate.toISOString());
}

beforeEach(() => {
  nativePlatform.OS = 'ios';
  sheetProps.androidContentSized = undefined;
  pickerSelections.date = new Date(2026, 0, 9, 0, 0, 0, 0);
  pickerSelections.time = new Date(2026, 0, 9, 20, 15, 0, 0);
  dateTimePickerAndroid.open.mockClear();
  mutations.updateMutate.mockReset();
  mutations.deleteMutate.mockReset();
  toast.showToast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogbookEditSheet', () => {
  it('opts the sheet into Android content-fitting so the form is not lost in a full-screen sheet (#4720)', () => {
    renderSheet();
    expect(sheetProps.androidContentSized).toBe(true);
  });

  it('saves the selected local date and time as an ISO timestamp', () => {
    renderSheet();

    fireEvent.click(screen.getByTestId('picker-date'));
    fireEvent.click(screen.getByTestId('picker-time'));
    save();

    const variables = firstUpdateVariables();

    expect(variables.uuid).toBe('tick-1');
    expectSavedClimbedAt(variables.input.climbedAt);
  });

  it('saves Android date and time picker selections', () => {
    nativePlatform.OS = 'android';
    renderSheet();

    fireEvent.click(screen.getByLabelText('mobile.tick.dateLabel'));
    fireEvent.click(screen.getByLabelText('mobile.tick.timeLabel'));
    save();

    expect(dateTimePickerAndroid.open).toHaveBeenCalledWith(expect.objectContaining({ mode: 'date' }));
    expect(dateTimePickerAndroid.open).toHaveBeenCalledWith(expect.objectContaining({ mode: 'time' }));

    const variables = firstUpdateVariables();

    expect(variables.uuid).toBe('tick-1');
    expectSavedClimbedAt(variables.input.climbedAt);
  });

  it('warns when Android time selection is clamped to now', () => {
    nativePlatform.OS = 'android';
    vi.useFakeTimers();
    const now = new Date(2026, 0, 9, 10, 0, 0, 0);
    vi.setSystemTime(now);
    renderSheet(
      makeAscent({
        climbedAt: new Date(2026, 0, 9, 9, 30, 0, 0).toISOString(),
      }),
    );

    fireEvent.click(screen.getByLabelText('mobile.tick.timeLabel'));

    expect(toast.showToast).toHaveBeenCalledWith('mobile.tick.futureTimeAdjusted', 'warning');
    save();

    const variables = firstUpdateVariables();

    expectClimbedAtIso(variables.input.climbedAt, now);
  });

  it('warns when Android date selection is clamped to now', () => {
    nativePlatform.OS = 'android';
    vi.useFakeTimers();
    const now = new Date(2026, 0, 9, 10, 0, 0, 0);
    vi.setSystemTime(now);
    pickerSelections.date = new Date(2026, 0, 9, 0, 0, 0, 0);
    renderSheet(
      makeAscent({
        climbedAt: new Date(2026, 0, 8, 23, 50, 0, 0).toISOString(),
      }),
    );

    fireEvent.click(screen.getByLabelText('mobile.tick.dateLabel'));

    expect(toast.showToast).toHaveBeenCalledWith('mobile.tick.futureTimeAdjusted', 'warning');
    save();

    const variables = firstUpdateVariables();

    expectClimbedAtIso(variables.input.climbedAt, now);
  });

  it('warns when iOS time selection is clamped to now', () => {
    vi.useFakeTimers();
    const now = new Date(2026, 0, 9, 10, 0, 0, 0);
    vi.setSystemTime(now);
    renderSheet(
      makeAscent({
        climbedAt: new Date(2026, 0, 9, 9, 30, 0, 0).toISOString(),
      }),
    );

    fireEvent.click(screen.getByTestId('picker-time'));

    expect(toast.showToast).toHaveBeenCalledWith('mobile.tick.futureTimeAdjusted', 'warning');
    save();

    const variables = firstUpdateVariables();

    expectClimbedAtIso(variables.input.climbedAt, now);
  });

  it('re-seeds climbed-at when a different ascent opens in the sheet', () => {
    nativePlatform.OS = 'android';
    const firstAscent = makeAscent({
      uuid: 'tick-1',
      climbedAt: new Date(2026, 0, 8, 10, 5, 0, 0).toISOString(),
    });
    const secondAscent = makeAscent({
      uuid: 'tick-2',
      climbedAt: new Date(2026, 1, 3, 7, 45, 0, 0).toISOString(),
    });
    const { rerender } = renderSheet(firstAscent);

    expect(screen.getByText('2026-01-08')).toBeTruthy();
    expect(screen.getByText('10:05')).toBeTruthy();

    rerender(
      createElement(LogbookEditSheet, {
        sheetRef: { current: null },
        ascent: secondAscent,
        onClose: vi.fn(),
      }),
    );

    expect(screen.getByText('2026-02-03')).toBeTruthy();
    expect(screen.getByText('07:45')).toBeTruthy();
  });

  it('does not send climbed-at when the date and time were not edited', () => {
    renderSheet();

    save();

    const variables = firstUpdateVariables();

    expect(variables.uuid).toBe('tick-1');
    expect(variables.input).not.toHaveProperty('climbedAt');
  });

  it('keeps the tries row mounted but inert when flash is selected', () => {
    renderSheet(makeAscent({ status: 'send', attemptCount: 5 }));
    expect(screen.getByText('mobile.tick.triesLabel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('status-flash'));

    // The row stays put — ~92pt no longer disappears from under the climber's
    // finger — and the flash-is-one-try clamp is shown rather than implied.
    expect(screen.getByText('mobile.tick.triesLabel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tries-7'));

    save();

    expect(mutations.updateMutate).toHaveBeenCalledWith(
      {
        uuid: 'tick-1',
        input: expect.objectContaining({
          status: 'flash',
          attemptCount: 1,
        }),
      },
      expect.any(Object),
    );
  });

  it('sets any visible try count in a single tap', () => {
    renderSheet(makeAscent({ status: 'send', attemptCount: 3 }));

    fireEvent.click(screen.getByTestId('tries-9'));
    save();

    expect(firstUpdateVariables().input.attemptCount).toBe(9);
  });

  it('preserves attempts when flash selection is reverted before saving', () => {
    renderSheet(makeAscent({ status: 'send', attemptCount: 5 }));

    fireEvent.click(screen.getByTestId('status-flash'));
    fireEvent.click(screen.getByTestId('status-send'));
    save();

    expect(mutations.updateMutate).toHaveBeenCalledWith(
      {
        uuid: 'tick-1',
        input: expect.objectContaining({
          status: 'send',
          attemptCount: 5,
        }),
      },
      expect.any(Object),
    );
  });

  it('includes the ascent angle unchanged in the save payload', () => {
    renderSheet(makeAscent({ angle: 40 }));

    save();

    const variables = firstUpdateVariables();
    expect(variables.input.angle).toBe(40);
  });

  it('saves a new angle after the slider is moved', () => {
    renderSheet(makeAscent({ angle: 40 }));

    fireEvent.click(screen.getByTestId('angle-option-25'));
    save();

    const variables = firstUpdateVariables();
    expect(variables.input.angle).toBe(25);
  });

  it('re-seeds angle when a different ascent opens the sheet', () => {
    const firstAscent = makeAscent({ uuid: 'tick-1', angle: 40 });
    const secondAscent = makeAscent({ uuid: 'tick-2', angle: 25 });
    const { rerender } = renderSheet(firstAscent);

    save();
    expect(firstUpdateVariables().input.angle).toBe(40);
    mutations.updateMutate.mockClear();

    rerender(
      createElement(LogbookEditSheet, {
        sheetRef: { current: null },
        ascent: secondAscent,
        onClose: vi.fn(),
      }),
    );

    save();
    expect(firstUpdateVariables().input.angle).toBe(25);
  });

  it('prints a failed save in the action bar instead of a toast the sheet covers', () => {
    mutations.updateMutate.mockImplementation((_variables: unknown, handlers: { onError: () => void }) =>
      handlers.onError(),
    );
    renderSheet();

    save();

    expect(screen.getByText('mobile.logbook.saveError')).toBeTruthy();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('prints a failed delete in the same slot', async () => {
    mutations.deleteMutate.mockImplementation((_uuid: string, handlers: { onError: () => void }) => handlers.onError());
    renderSheet();

    fireEvent.click(screen.getByLabelText('mobile.tick.deleteRow'));
    await Promise.resolve();

    expect(await screen.findByText('mobile.logbook.deleteError')).toBeTruthy();
    expect(toast.showToast).not.toHaveBeenCalled();
  });
});
