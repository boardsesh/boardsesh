import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `nowMs()`/`nowDate()` are the app's single source of "now" (see clock.ts).
// The module-level `SCREENSHOT_NOW_MS` constant in `screenshot-mode.ts` is
// only re-evaluated on import, so every case here resets modules and
// dynamically re-imports under fresh env — same pattern as
// `screenshot-mode.test.ts`.
const SCREENSHOT_ENV_KEYS = ['EXPO_PUBLIC_SCREENSHOT_MODE', 'EXPO_PUBLIC_SCREENSHOT_NOW'] as const;

describe('clock', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of SCREENSHOT_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SCREENSHOT_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('returns the frozen instant when screenshot mode is on with a valid ISO timestamp', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = '2026-01-15T12:00:00.000Z';
    const { nowMs } = await import('../clock');
    expect(nowMs()).toBe(Date.parse('2026-01-15T12:00:00.000Z'));
  });

  it('falls back to the real clock when EXPO_PUBLIC_SCREENSHOT_NOW is unparseable', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = 'not-a-date';
    const { nowMs } = await import('../clock');
    const before = Date.now();
    const result = nowMs();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('falls back to the real clock when screenshot mode is off, even with a valid EXPO_PUBLIC_SCREENSHOT_NOW', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = '2026-01-15T12:00:00.000Z';
    const { nowMs } = await import('../clock');
    const before = Date.now();
    const result = nowMs();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('nowDate() wraps nowMs() in a Date', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = '2026-01-15T12:00:00.000Z';
    const { nowMs, nowDate } = await import('../clock');
    expect(nowDate().getTime()).toBe(nowMs());
    expect(nowDate().toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });
});
