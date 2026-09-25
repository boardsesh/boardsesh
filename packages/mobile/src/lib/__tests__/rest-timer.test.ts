import { describe, expect, it } from 'vitest';
import {
  formatRestTimerElapsed,
  formatRestTimerSigned,
  formatRestTimerTarget,
  getRestTimerElapsedSeconds,
  getRestTimerElapsedSecondsFromStart,
  getRestTimerStartMs,
  isRestTimerTargetExceeded,
  isRestTimerTargetReached,
} from '../rest-timer';

describe('rest timer formatting', () => {
  it('derives elapsed whole seconds from the latest saved tick timestamp', () => {
    const nowMs = Date.parse('2026-06-12T07:15:42.900Z');
    expect(getRestTimerElapsedSeconds('2026-06-12T07:15:00.000Z', nowMs)).toBe(42);
  });

  it('treats naive backend tick timestamps as UTC', () => {
    const nowMs = Date.parse('2026-06-12T07:15:42.000Z');
    expect(getRestTimerElapsedSeconds('2026-06-12 07:15:00', nowMs)).toBe(42);
  });

  it('exposes a reusable timer start timestamp for local controls', () => {
    const startMs = getRestTimerStartMs('2026-06-12 07:15:00');
    expect(startMs).toBe(Date.parse('2026-06-12T07:15:00.000Z'));
    expect(getRestTimerElapsedSecondsFromStart(startMs, Date.parse('2026-06-12T07:16:05.000Z'))).toBe(65);
  });

  it('clamps missing, invalid, and future timestamps to zero', () => {
    const nowMs = Date.parse('2026-06-12T07:15:00.000Z');
    expect(getRestTimerElapsedSeconds(null, nowMs)).toBe(0);
    expect(getRestTimerElapsedSeconds('not-a-date', nowMs)).toBe(0);
    expect(getRestTimerElapsedSeconds('2026-06-12T07:15:01.000Z', nowMs)).toBe(0);
    expect(getRestTimerStartMs(null)).toBeNull();
    expect(getRestTimerStartMs('not-a-date')).toBeNull();
  });

  it('formats sub-hour and hour-long rests with stable tabular fields', () => {
    expect(formatRestTimerElapsed(0)).toBe('0:00');
    expect(formatRestTimerElapsed(9)).toBe('0:09');
    expect(formatRestTimerElapsed(75)).toBe('1:15');
    expect(formatRestTimerElapsed(3725)).toBe('1:02:05');
  });

  it('formats and evaluates configured target durations', () => {
    expect(formatRestTimerTarget(180)).toBe('3m');
    expect(formatRestTimerTarget(95)).toBe('1:35');
    expect(isRestTimerTargetReached(179, 180)).toBe(false);
    expect(isRestTimerTargetReached(180, 180)).toBe(true);
    expect(isRestTimerTargetExceeded(180, 180)).toBe(false);
    expect(isRestTimerTargetExceeded(181, 180)).toBe(true);
  });
});

describe('formatRestTimerSigned', () => {
  it('reads like the plain clock while there is rest left', () => {
    expect(formatRestTimerSigned(60)).toBe('1:00');
    expect(formatRestTimerSigned(9)).toBe('0:09');
    expect(formatRestTimerSigned(0)).toBe('0:00');
  });

  it('carries the sign once the rest is spent, so overrun is readable at a glance', () => {
    expect(formatRestTimerSigned(-1)).toBe('-0:01');
    expect(formatRestTimerSigned(-75)).toBe('-1:15');
  });

  it('truncates toward zero rather than flipping the sign on a fraction', () => {
    expect(formatRestTimerSigned(-0.4)).toBe('0:00');
    expect(formatRestTimerSigned(0.9)).toBe('0:00');
  });
});
