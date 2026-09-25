import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppEntryHref, getAppEntryTab } from '../app-entry-route';

describe('ordinary app entry', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('opens the library without changing its tab position', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', undefined);
    expect(getAppEntryTab()).toBe('climbs');
    expect(getAppEntryHref()).toBe('/(tabs)/climbs');
  });

  it('preserves the screenshot orchestrator Home readiness contract', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(getAppEntryTab()).toBe('home');
    expect(getAppEntryHref()).toBe('/(tabs)/home');
  });
});
