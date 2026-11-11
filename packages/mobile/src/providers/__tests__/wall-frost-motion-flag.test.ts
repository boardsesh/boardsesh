// `wall-frost-motion`: the driving wall button's moving frost (the Metal-drawn
// lights that breathe and glide to the next climb). A POSITIVE flag: a store
// build keeps the still frost until PostHog says on; a dev build moves unless a
// tester turns it off; screenshot mode never moves, so captures stay identical.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_DEFINITIONS, wallFrostMotionOffered } from '../feature-flags-provider';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the wall-frost-motion flag', () => {
  it('is in the catalog, so PostHog is asked for it and testers can force it', () => {
    expect(FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key as string)).toContain('wall-frost-motion');
  });

  it('keeps the still frost in a store build until the flag is on', () => {
    vi.stubGlobal('__DEV__', false);
    expect(wallFrostMotionOffered(undefined)).toBe(false);
    expect(wallFrostMotionOffered(false)).toBe(false);
    expect(wallFrostMotionOffered('true')).toBe(false);
    expect(wallFrostMotionOffered(true)).toBe(true);
  });

  it('moves in a dev build unless a tester turns it off', () => {
    vi.stubGlobal('__DEV__', true);
    expect(wallFrostMotionOffered(undefined)).toBe(true);
    expect(wallFrostMotionOffered(false)).toBe(false);
  });

  it('never moves in screenshot mode, whatever the flag says', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubGlobal('__DEV__', true);
    expect(wallFrostMotionOffered(true)).toBe(false);
    expect(wallFrostMotionOffered(undefined)).toBe(false);
  });
});
