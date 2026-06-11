import { describe, expect, it } from 'vitest';
import { formatRepTimerElapsed, getRepTimerElapsedSeconds } from '../rep-timer';

describe('rep timer formatting', () => {
  it('derives elapsed whole seconds from the latest saved tick timestamp', () => {
    const nowMs = Date.parse('2026-06-12T07:15:42.900Z');
    expect(getRepTimerElapsedSeconds('2026-06-12T07:15:00.000Z', nowMs)).toBe(42);
  });

  it('treats naive backend tick timestamps as UTC', () => {
    const nowMs = Date.parse('2026-06-12T07:15:42.000Z');
    expect(getRepTimerElapsedSeconds('2026-06-12 07:15:00', nowMs)).toBe(42);
  });

  it('clamps missing, invalid, and future timestamps to zero', () => {
    const nowMs = Date.parse('2026-06-12T07:15:00.000Z');
    expect(getRepTimerElapsedSeconds(null, nowMs)).toBe(0);
    expect(getRepTimerElapsedSeconds('not-a-date', nowMs)).toBe(0);
    expect(getRepTimerElapsedSeconds('2026-06-12T07:15:01.000Z', nowMs)).toBe(0);
  });

  it('formats sub-hour and hour-long rests with stable tabular fields', () => {
    expect(formatRepTimerElapsed(0)).toBe('0:00');
    expect(formatRepTimerElapsed(9)).toBe('0:09');
    expect(formatRepTimerElapsed(75)).toBe('1:15');
    expect(formatRepTimerElapsed(3725)).toBe('1:02:05');
  });
});
