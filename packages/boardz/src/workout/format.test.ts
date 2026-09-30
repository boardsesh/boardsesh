import { describe, expect, it } from 'vitest';
import { formatCountdown, formatSeconds, formatSecondsShort } from './format';

describe('formatSeconds', () => {
  it('reads like a setting', () => {
    expect(formatSeconds(0)).toBe('Off');
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(120)).toBe('2 min');
    expect(formatSeconds(150)).toBe('2 min 30 s');
  });
});

describe('formatCountdown', () => {
  it('rounds up so the clock never shows 0:00 before time is up', () => {
    expect(formatCountdown(125_000)).toBe('2:05');
    expect(formatCountdown(200)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('shortens settings to mono figures', () => {
    expect(formatSecondsShort(0)).toBe('Off');
    expect(formatSecondsShort(45)).toBe('45s');
    expect(formatSecondsShort(120)).toBe('2:00');
    expect(formatSecondsShort(150)).toBe('2:30');
  });
});
