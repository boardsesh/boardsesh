import React, { createElement, useCallback, type ChangeEvent, type CSSProperties } from 'react';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { applyDatePart, applyTimePart, clampToNow, formatDateForDisplay, formatTimeForDisplay } from './climbed-at';

type ClimbedAtFieldProps = {
  value: Date;
  mode: 'date' | 'time';
  maximumDate: Date;
  onChange: (next: Date) => void;
  onFutureAdjusted?: () => void;
  accessibilityLabel: string;
};

function parseDateInput(input: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, monthIndex, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== monthIndex || parsed.getDate() !== day) return null;
  return parsed;
}

function parseTimeInput(input: string): Date | null {
  const match = /^(\d{2}):(\d{2})$/.exec(input);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const parsed = new Date(2000, 0, 1, hours, minutes, 0, 0);
  return parsed;
}

function isSameCalendarDay(first: Date, second: Date): boolean {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

export const ClimbedAtField = React.memo(function ClimbedAtField({
  value,
  mode,
  maximumDate,
  onChange,
  onFutureAdjusted,
  accessibilityLabel,
}: ClimbedAtFieldProps) {
  const { colorScheme, m3 } = useTheme();

  const commitPicked = useCallback(
    (picked: Date) => {
      const requested =
        mode === 'date'
          ? applyDatePart(value, picked, { clampToPresent: false })
          : applyTimePart(value, picked, { clampToPresent: false });
      const clamped = clampToNow(requested);
      if (clamped.getTime() !== requested.getTime()) onFutureAdjusted?.();
      onChange(clamped);
    },
    [mode, value, onChange, onFutureAdjusted],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked =
        mode === 'date' ? parseDateInput(event.currentTarget.value) : parseTimeInput(event.currentTarget.value);
      if (picked) commitPicked(picked);
    },
    [commitPicked, mode],
  );

  const inputStyle: CSSProperties = {
    backgroundColor: m3.surface,
    border: `1px solid ${m3.outline}`,
    borderRadius: borderRadius.lg,
    boxSizing: 'border-box',
    color: m3.onSurface,
    colorScheme,
    font: 'inherit',
    minHeight: 44,
    padding: `${spacing[2]}px ${spacing[3]}px`,
    width: '100%',
  };

  const maximumTime = isSameCalendarDay(value, maximumDate) ? formatTimeForDisplay(maximumDate) : undefined;
  return createElement('input', {
    type: mode,
    value: mode === 'date' ? formatDateForDisplay(value) : formatTimeForDisplay(value),
    max: mode === 'date' ? formatDateForDisplay(maximumDate) : maximumTime,
    step: mode === 'time' ? 60 : undefined,
    onChange: handleChange,
    'aria-label': accessibilityLabel,
    style: inputStyle,
  });
});

export const _climbedAtWebParsersForTests = { parseDateInput, parseTimeInput };
