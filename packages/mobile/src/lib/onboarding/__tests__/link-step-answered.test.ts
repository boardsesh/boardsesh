import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../preference-store', () => ({
  getPreference: preferences.get,
  setPreference: preferences.set,
}));

import { hasAnsweredLinkStep, markLinkStepAnswered } from '../link-step-answered';

beforeEach(() => {
  preferences.get.mockReset().mockResolvedValue(undefined);
  preferences.set.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
});

afterEach(() => vi.unstubAllEnvs());

describe('link-step answer storage', () => {
  it.each([
    { stored: true, answered: true },
    { stored: false, answered: false },
    { stored: undefined, answered: false },
  ])('reads the persisted answer: %j', async ({ stored, answered }) => {
    preferences.get.mockResolvedValue(stored);
    await expect(hasAnsweredLinkStep()).resolves.toBe(answered);
    expect(preferences.get).toHaveBeenCalledExactlyOnceWith('onboardingLinkStepAnswered');
  });

  it('suppresses the optional prompt when its persisted answer cannot be read', async () => {
    preferences.get.mockRejectedValue(new Error('storage unavailable'));
    await expect(hasAnsweredLinkStep()).resolves.toBe(true);
  });

  it('keeps screenshot mode quiet without reading storage', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    await expect(hasAnsweredLinkStep()).resolves.toBe(true);
    expect(preferences.get).not.toHaveBeenCalled();
  });

  it('persists an explicit answer in the app preferences', async () => {
    await markLinkStepAnswered();
    expect(preferences.set).toHaveBeenCalledExactlyOnceWith('onboardingLinkStepAnswered', true);
  });

  it('lets the route report a failed answer write while still leaving', async () => {
    const storageError = new Error('write unavailable');
    preferences.set.mockRejectedValue(storageError);
    await expect(markLinkStepAnswered()).rejects.toBe(storageError);
  });
});
