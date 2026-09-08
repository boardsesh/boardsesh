import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Regression guard for the cold-start crash where a merge between two PRs left a
// bare `SCREENSHOT_MODE` reference in this module after the binding was deleted.
// `screenshot-mode.ts` is imported by the auth + theme providers at the top of
// the startup tree, so a top-level ReferenceError here aborts the app on launch
// (expo-updates ErrorRecovery then crashes the process). These tests import the
// module fresh under different env so any top-level throw fails loudly here
// instead of only on a device.

const SCREENSHOT_ENV_KEYS = [
  'EXPO_PUBLIC_SCREENSHOT_MODE',
  'EXPO_PUBLIC_SCREENSHOT_LOCALE',
  'EXPO_PUBLIC_SCREENSHOT_NOW',
  'EXPO_PUBLIC_SCREENSHOT_THEME',
  'EXPO_PUBLIC_SCREENSHOT_VARIANT',
  'EXPO_PUBLIC_SCREENSHOT_WORKOUT',
  'EXPO_PUBLIC_SCREENSHOT_USER_EMAIL',
  'EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD',
  'EXPO_PUBLIC_SCREENSHOT_RENDER_MODE',
  'EXPO_PUBLIC_SCREENSHOT_BOARDS',
] as const;

describe('screenshot-mode', () => {
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

  it('evaluates without throwing in a normal build (no screenshot env)', async () => {
    const screenshotMode = await import('../screenshot-mode');
    // The locale override line is exactly where the bare-`SCREENSHOT_MODE` bug
    // lived. In a normal build the guard is false, so there is no override.
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBeNull();
    expect(screenshotMode.SCREENSHOT_THEME_OVERRIDE).toBe('dark');
    expect(screenshotMode.SCREENSHOT_VARIANT_PREFERENCE).toBe('auto');
    expect(screenshotMode.SCREENSHOT_WORKOUT).toBeNull();
    expect(screenshotMode.SCREENSHOT_USER_EMAIL).toBe('');
    expect(screenshotMode.SCREENSHOT_USER_PASSWORD).toBe('');
  });

  it('pins Aura and the store boards by default, so CI needs no env to get them', async () => {
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_RENDER_MODE).toBe('aura');
    expect(screenshotMode.SCREENSHOT_BOARDS).toEqual(["Marco's Board", 'High Point Climbing Orlando']);
  });

  it('takes a render mode and a board list from the run', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE = 'classic';
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = ' The Cellar | Kilter Board Homewall ';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_RENDER_MODE).toBe('classic');
    expect(screenshotMode.SCREENSHOT_BOARDS).toEqual(['The Cellar', 'Kilter Board Homewall']);
  });

  it('keeps the defaults when the run passes blanks', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE = '  ';
    process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS = ' | ';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_RENDER_MODE).toBe('aura');
    expect(screenshotMode.SCREENSHOT_BOARDS).toEqual(["Marco's Board", 'High Point Climbing Orlando']);
  });

  it('keeps the locale override null when screenshot mode is off, even with a locale set', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE = 'fr';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBeNull();
  });

  it('applies a supported locale override only when screenshot mode is on', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE = 'fr';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBe('fr');
  });

  it('ignores an unsupported locale even in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE = 'zz-not-a-locale';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_LOCALE_OVERRIDE).toBeNull();
  });

  it('keeps the frozen clock null when screenshot mode is off, even with NOW set', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = '2026-01-15T12:00:00.000Z';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_NOW_MS).toBeNull();
  });

  it('freezes the clock to the parsed instant only when screenshot mode is on', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = '2026-01-15T12:00:00.000Z';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_NOW_MS).toBe(Date.parse('2026-01-15T12:00:00.000Z'));
  });

  it('ignores an unparseable NOW even in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_NOW = 'not-a-date';
    const screenshotMode = await import('../screenshot-mode');
    expect(screenshotMode.SCREENSHOT_NOW_MS).toBeNull();
  });

  it('leaves infinite lists paging normally outside screenshot mode', async () => {
    const { screenshotModeNextPageParam } = await import('../screenshot-mode');
    expect(screenshotModeNextPageParam(20, 1)).toBe(20);
    expect(screenshotModeNextPageParam('eyJvIjo4MH0', 4)).toBe('eyJvIjo4MH0');
    // A list that has genuinely run out still stops.
    expect(screenshotModeNextPageParam(undefined, 3)).toBeUndefined();
  });

  it('stops an infinite list after its first page in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    const { screenshotModeNextPageParam } = await import('../screenshot-mode');
    // Nothing is capped before the first page has landed.
    expect(screenshotModeNextPageParam(20, 0)).toBe(20);
    // React Query asks with allPages.length === 1 once page one is in.
    expect(screenshotModeNextPageParam(20, 1)).toBeUndefined();
    expect(screenshotModeNextPageParam('eyJvIjo4MH0', 4)).toBeUndefined();
  });

  it('leaves a hand-rolled pager alone outside screenshot mode', async () => {
    const { screenshotModeLoadMore } = await import('../screenshot-mode');
    const loadMore = vi.fn();
    const wrapped = screenshotModeLoadMore(loadMore);
    // The same function back, so a memoized list prop keeps its identity.
    expect(wrapped).toBe(loadMore);
    wrapped();
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('turns a hand-rolled pager into a no-op in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    const { screenshotModeLoadMore } = await import('../screenshot-mode');
    const loadMore = vi.fn();
    const wrapped = screenshotModeLoadMore(loadMore);
    wrapped();
    wrapped();
    expect(loadMore).not.toHaveBeenCalled();
    // One shared no-op, so wrapping twice does not hand a list a fresh closure.
    expect(screenshotModeLoadMore(vi.fn())).toBe(wrapped);
  });
});
