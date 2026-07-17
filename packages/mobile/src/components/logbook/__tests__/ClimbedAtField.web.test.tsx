// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    m3: { surface: '#fff', onSurface: '#111', outline: '#777' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ borderRadius: { lg: 8 }, spacing: { 2: 8, 3: 12 } }));

import { ClimbedAtField, _climbedAtWebParsersForTests } from '../ClimbedAtField.web';

afterEach(() => vi.useRealTimers());

describe('ClimbedAtField.web', () => {
  it('merges a browser date selection onto the existing time', () => {
    const onChange = vi.fn();
    render(
      createElement(ClimbedAtField, {
        value: new Date(2025, 0, 5, 14, 30),
        mode: 'date',
        maximumDate: new Date(2025, 11, 31, 23, 59),
        onChange,
        accessibilityLabel: 'Climbed date',
      }),
    );

    fireEvent.change(screen.getByLabelText('Climbed date'), { target: { value: '2025-01-10' } });
    const next = onChange.mock.calls[0]?.[0] as Date;
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
  });

  it('clamps a future browser time and reports the adjustment', () => {
    vi.useFakeTimers();
    const now = new Date(2025, 0, 10, 9, 0);
    vi.setSystemTime(now);
    const onChange = vi.fn();
    const onFutureAdjusted = vi.fn();
    render(
      createElement(ClimbedAtField, {
        value: new Date(2025, 0, 10, 8, 0),
        mode: 'time',
        maximumDate: now,
        onChange,
        onFutureAdjusted,
        accessibilityLabel: 'Climbed time',
      }),
    );

    fireEvent.change(screen.getByLabelText('Climbed time'), { target: { value: '20:00' } });
    expect(onFutureAdjusted).toHaveBeenCalledTimes(1);
    const adjustedDate = onChange.mock.calls[0]?.[0] as Date | undefined;
    expect(adjustedDate).toBeInstanceOf(Date);
    expect(adjustedDate?.getTime()).toBe(now.getTime());
  });

  it('rejects malformed browser values', () => {
    expect(_climbedAtWebParsersForTests.parseDateInput('2025-02-31')).toBeNull();
    expect(_climbedAtWebParsersForTests.parseTimeInput('25:00')).toBeNull();
  });
});
