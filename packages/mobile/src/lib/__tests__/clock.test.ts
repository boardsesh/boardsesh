import { describe, it, expect, afterEach, vi } from 'vitest';
import { nowMs, nowDate } from '../clock';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('clock', () => {
  it('uses the actual clock even when a capture timestamp is configured', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_NOW', '2026-01-15T12:00:00.000Z');
    expect(nowMs()).toBe(Date.now());
    expect(nowDate().toISOString()).toBe('2026-11-15T12:00:00.000Z');
    vi.advanceTimersByTime(1000);
    expect(nowMs()).toBe(Date.parse('2026-11-15T12:00:01.000Z'));
  });
});
