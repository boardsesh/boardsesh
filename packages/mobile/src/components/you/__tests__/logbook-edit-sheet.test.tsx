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
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@gorhom/bottom-sheet', () => ({
  default: class BottomSheet {},
  BottomSheetTextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    placeholder?: string;
  }) =>
    createElement('textarea', {
      placeholder,
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
  Sheet: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
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
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../grade', () => ({ GradeSingleSelectRail: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: [] }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      fill: '#eee',
      label: '#111',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
    },
    brandColors: { primary: '#6D28D9', error: '#C81E1E' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: { lg: 12 },
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
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: new Date(2026, 0, 8, 10, 5, 0, 0).toISOString(),
    frames: null,
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
  pickerSelections.date = new Date(2026, 0, 9, 0, 0, 0, 0);
  pickerSelections.time = new Date(2026, 0, 9, 20, 15, 0, 0);
  dateTimePickerAndroid.open.mockClear();
  mutations.updateMutate.mockClear();
  mutations.deleteMutate.mockClear();
  toast.showToast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogbookEditSheet', () => {
  it('saves the selected local date and time as an ISO timestamp', () => {
    renderSheet();

    fireEvent.click(screen.getByTestId('picker-date'));
    fireEvent.click(screen.getByTestId('picker-time'));
    fireEvent.click(screen.getByText('mobile.logbook.save'));

    const variables = firstUpdateVariables();

    expect(variables.uuid).toBe('tick-1');
    expectSavedClimbedAt(variables.input.climbedAt);
  });

  it('saves Android date and time picker selections', () => {
    nativePlatform.OS = 'android';
    renderSheet();

    fireEvent.click(screen.getByLabelText('mobile.logbook.dateLabel'));
    fireEvent.click(screen.getByLabelText('mobile.logbook.timeLabel'));
    fireEvent.click(screen.getByText('mobile.logbook.save'));

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

    fireEvent.click(screen.getByLabelText('mobile.logbook.timeLabel'));

    expect(toast.showToast).toHaveBeenCalledWith('mobile.logbook.futureTimeAdjusted', 'warning');
    fireEvent.click(screen.getByText('mobile.logbook.save'));

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

    fireEvent.click(screen.getByLabelText('mobile.logbook.dateLabel'));

    expect(toast.showToast).toHaveBeenCalledWith('mobile.logbook.futureTimeAdjusted', 'warning');
    fireEvent.click(screen.getByText('mobile.logbook.save'));

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

    expect(toast.showToast).toHaveBeenCalledWith('mobile.logbook.futureTimeAdjusted', 'warning');
    fireEvent.click(screen.getByText('mobile.logbook.save'));

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

    fireEvent.click(screen.getByText('mobile.logbook.save'));

    const variables = firstUpdateVariables();

    expect(variables.uuid).toBe('tick-1');
    expect(variables.input).not.toHaveProperty('climbedAt');
  });

  it('hides tries and saves one attempt when flash is selected', () => {
    renderSheet(makeAscent({ status: 'send', attemptCount: 5 }));
    expect(screen.getByText('mobile.logbook.triesLabel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('status-flash'));

    expect(screen.queryByText('mobile.logbook.triesLabel')).toBeNull();
    fireEvent.click(screen.getByText('mobile.logbook.save'));

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

  it('preserves attempts when flash selection is reverted before saving', () => {
    renderSheet(makeAscent({ status: 'send', attemptCount: 5 }));

    fireEvent.click(screen.getByTestId('status-flash'));
    fireEvent.click(screen.getByTestId('status-send'));
    fireEvent.click(screen.getByText('mobile.logbook.save'));

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
});
