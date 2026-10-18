import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The raw bytes behind the settings store, so a test can plant a value no
// current build would write.
const storedBytes = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => storedBytes.get(key),
    set: (key: string, value: string) => storedBytes.set(key, value),
    remove: (key: string) => storedBytes.delete(key),
    clearAll: () => storedBytes.clear(),
  }),
}));

import { getAppEntryHref, getAppEntryTab } from '../app-entry-route';
import { setSetting } from '../../settings/hooks';

describe('ordinary app entry', () => {
  beforeEach(() => {
    storedBytes.clear();
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('opens the library without changing its tab position', () => {
    expect(getAppEntryTab()).toBe('climbs');
    expect(getAppEntryHref()).toBe('/(tabs)/climbs');
  });

  it('opens Home once the climber chose Home in Settings', () => {
    setSetting('startupScreen', 'home');
    expect(getAppEntryTab()).toBe('home');
    expect(getAppEntryHref()).toBe('/(tabs)/home');
  });

  it('goes back to Climbs when the climber switches back', () => {
    setSetting('startupScreen', 'home');
    setSetting('startupScreen', 'climbs');
    expect(getAppEntryTab()).toBe('climbs');
  });

  // A value from a later build, a hand-edited store or broken bytes must not
  // strand anyone on a tab that does not exist.
  it.each(['"profile"', '"Home"', 'true', 'null', '{"tab":"home"}', 'not-json'])(
    'opens Climbs when storage holds %s',
    (bytes) => {
      storedBytes.set('startupScreen', bytes);
      expect(getAppEntryTab()).toBe('climbs');
      expect(getAppEntryHref()).toBe('/(tabs)/climbs');
    },
  );

  it('preserves the screenshot orchestrator Home readiness contract', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(getAppEntryTab()).toBe('home');
    expect(getAppEntryHref()).toBe('/(tabs)/home');
  });

  it('starts screenshot captures on Home even when the simulator was left on Climbs', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    setSetting('startupScreen', 'climbs');
    expect(getAppEntryTab()).toBe('home');
  });
});
