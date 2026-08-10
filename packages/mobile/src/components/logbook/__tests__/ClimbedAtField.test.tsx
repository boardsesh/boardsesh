// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The date/time the mocked pickers report on interaction.
const pickerSelection = vi.hoisted(() => ({ value: new Date(2025, 0, 10, 8, 30, 0, 0) }));
const nativePlatform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { 'aria-label': accessibilityLabel, onClick: () => onPress?.() }, children),
  Platform: nativePlatform,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  default: ({ mode, onChange }: { mode: 'date' | 'time'; onChange: (event: unknown, selected?: Date) => void }) =>
    createElement(
      'button',
      { 'data-testid': `picker-${mode}`, onClick: () => onChange({ type: 'set' }, pickerSelection.value) },
      mode,
    ),
  DateTimePickerAndroid: {
    open: ({ onChange }: { onChange: (event: { type: 'set' }, selected?: Date) => void }) =>
      onChange({ type: 'set' }, pickerSelection.value),
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#111', secondaryLabel: '#666' },
    // The iOS picker is tinted with the brand primary and told which scheme to
    // resolve its own chrome for.
    brandColors: { primary: '#6D28D9' },
    colorScheme: 'light',
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: { lg: 12, full: 9999 },
}));

import { ClimbedAtField } from '../ClimbedAtField';

beforeEach(() => {
  nativePlatform.OS = 'ios';
  pickerSelection.value = new Date(2025, 0, 10, 8, 30, 0, 0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClimbedAtField', () => {
  it('iOS: renders the inline picker and merges the picked day onto the existing time', () => {
    const onChange = vi.fn();
    const onFutureAdjusted = vi.fn();
    render(
      createElement(ClimbedAtField, {
        value: new Date(2025, 0, 5, 14, 0, 0, 0),
        mode: 'date',
        maximumDate: new Date(2030, 0, 1),
        onChange,
        onFutureAdjusted,
        accessibilityLabel: 'Date',
      }),
    );

    fireEvent.click(screen.getByTestId('picker-date'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const merged = onChange.mock.calls[0][0] as Date;
    expect(merged.getFullYear()).toBe(2025);
    expect(merged.getMonth()).toBe(0);
    expect(merged.getDate()).toBe(10); // day from the selection
    expect(merged.getHours()).toBe(14); // time preserved from `value`
    expect(onFutureAdjusted).not.toHaveBeenCalled();
  });

  it('Android: renders a tappable trigger showing the formatted value and reports on tap', () => {
    nativePlatform.OS = 'android';
    const onChange = vi.fn();
    render(
      createElement(ClimbedAtField, {
        value: new Date(2025, 0, 5, 14, 0, 0, 0),
        mode: 'date',
        maximumDate: new Date(2030, 0, 1),
        onChange,
        accessibilityLabel: 'Date',
      }),
    );

    expect(screen.getByText('2025-01-05')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Date'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as Date).getDate()).toBe(10);
  });

  it('clamps a future selection to now and reports the adjustment', () => {
    vi.useFakeTimers();
    const now = new Date(2025, 0, 10, 9, 0, 0, 0);
    vi.setSystemTime(now);
    pickerSelection.value = new Date(2025, 0, 10, 20, 0, 0, 0); // 20:00 is after "now" (09:00)

    const onChange = vi.fn();
    const onFutureAdjusted = vi.fn();
    render(
      createElement(ClimbedAtField, {
        value: new Date(2025, 0, 10, 8, 0, 0, 0),
        mode: 'time',
        maximumDate: now,
        onChange,
        onFutureAdjusted,
        accessibilityLabel: 'Time',
      }),
    );

    fireEvent.click(screen.getByTestId('picker-time'));

    expect(onFutureAdjusted).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0][0] as Date).getTime()).toBe(now.getTime());
  });
});
