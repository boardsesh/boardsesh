// The two rules that decide when the Climbs list teaches the quick-actions menu.
// Both are behavioural promises, not implementation details: the tip waits for
// the third visit, and it never shows to someone who already found the menu.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the secure-store adapter (the seam), same as onboarding-storage.test.ts,
// so the counter/flag chain under test is the real one.
const getMock = vi.fn();
const setMock = vi.fn();
const removeMock = vi.fn();
vi.mock('../../preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: (key: string) => getMock(key),
    set: (key: string, value: unknown) => setMock(key, value),
    remove: (key: string) => removeMock(key),
  },
}));

import {
  ONBOARDING_TIP_QUICKACTIONS_KEY,
  ONBOARDING_TIP_QUICKACTIONS_USED_KEY,
  ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY,
} from '@boardsesh/key-value-storage';
import {
  QUICK_ACTIONS_TIP_MIN_VISITS,
  markQuickActionsUsed,
  resetQuickActionsUsedGuard,
  resolveQuickActionsTip,
  shouldArmQuickActionsTip,
} from '../quick-actions-tip';

/** Storage stub: every key absent unless listed. */
function storedValues(values: Record<string, unknown>) {
  getMock.mockImplementation((key: string) => Promise.resolve(values[key] ?? null));
  setMock.mockImplementation((key: string, value: unknown) => {
    values[key] = value;
    return Promise.resolve();
  });
}

describe('shouldArmQuickActionsTip', () => {
  it('never arms for a climber who has already opened the actions menu', () => {
    // The whole point of the rule: there is nothing to teach someone who found
    // the menu on their own, however many times they come back to the list.
    for (const visitCount of [0, 1, 3, 10, 500]) {
      expect(shouldArmQuickActionsTip({ alreadySeen: false, hasOpenedActions: true, visitCount })).toBe(false);
    }
  });

  it('waits for the third Climbs visit', () => {
    const signals = { alreadySeen: false, hasOpenedActions: false };
    expect(shouldArmQuickActionsTip({ ...signals, visitCount: 1 })).toBe(false);
    expect(shouldArmQuickActionsTip({ ...signals, visitCount: 2 })).toBe(false);
    expect(shouldArmQuickActionsTip({ ...signals, visitCount: 3 })).toBe(true);
    expect(QUICK_ACTIONS_TIP_MIN_VISITS).toBe(3);
  });

  it('still honours the old one-shot seen flag', () => {
    // Anyone taught under the first-visit timing must not be taught again.
    expect(shouldArmQuickActionsTip({ alreadySeen: true, hasOpenedActions: false, visitCount: 99 })).toBe(false);
  });
});

describe('resolveQuickActionsTip', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
    resetQuickActionsUsedGuard();
  });

  it('stays quiet on the first two visits, then fires on the third', async () => {
    const values: Record<string, unknown> = {};
    storedValues(values);

    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 1 });
    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 2 });
    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: true, visitCount: 3 });
    expect(values[ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]).toBe(3);
  });

  it('never arms once the actions menu has been opened, and stops counting visits', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_USED_KEY]: true });

    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    // Not even the counter is touched — a climber past the tip writes nothing.
    expect(setMock).not.toHaveBeenCalled();
  });

  it('never arms for someone who already saw the tip under the old timing', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_KEY]: true, [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: 9 });

    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
  });

  it('stops writing the counter once the threshold is reached', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: QUICK_ACTIONS_TIP_MIN_VISITS });

    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: true, visitCount: 3 });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('stays quiet when the store is unreadable rather than nagging', async () => {
    getMock.mockRejectedValue(new Error('keychain unavailable'));

    await expect(resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
  });
});

describe('markQuickActionsUsed', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
    resetQuickActionsUsedGuard();
    setMock.mockResolvedValue(undefined);
  });

  it('persists the flag the tip reads', async () => {
    await markQuickActionsUsed();
    expect(setMock).toHaveBeenCalledWith(ONBOARDING_TIP_QUICKACTIONS_USED_KEY, true);
  });

  it('writes once per launch even though every menu open calls it', async () => {
    await markQuickActionsUsed();
    await markQuickActionsUsed();
    await markQuickActionsUsed();
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});
