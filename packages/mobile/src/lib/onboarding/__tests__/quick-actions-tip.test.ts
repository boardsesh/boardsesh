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
let quickActionsTip: typeof import('../quick-actions-tip');

beforeEach(async () => {
  vi.resetModules();
  quickActionsTip = await import('../quick-actions-tip');
  getMock.mockReset();
  setMock.mockReset().mockResolvedValue(undefined);
  removeMock.mockReset();
});

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
      expect(quickActionsTip.shouldArmQuickActionsTip({ alreadySeen: false, hasOpenedActions: true, visitCount })).toBe(
        false,
      );
    }
  });

  it('waits for the third Climbs visit', () => {
    const signals = { alreadySeen: false, hasOpenedActions: false };
    expect(quickActionsTip.shouldArmQuickActionsTip({ ...signals, visitCount: 1 })).toBe(false);
    expect(quickActionsTip.shouldArmQuickActionsTip({ ...signals, visitCount: 2 })).toBe(false);
    expect(quickActionsTip.shouldArmQuickActionsTip({ ...signals, visitCount: 3 })).toBe(true);
    expect(quickActionsTip.QUICK_ACTIONS_TIP_MIN_VISITS).toBe(3);
  });

  it('still honours the old one-shot seen flag', () => {
    // Anyone taught under the first-visit timing must not be taught again.
    expect(
      quickActionsTip.shouldArmQuickActionsTip({ alreadySeen: true, hasOpenedActions: false, visitCount: 99 }),
    ).toBe(false);
  });
});

describe('resolveQuickActionsTip', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
  });

  it('stays quiet on the first two visits, then fires on the third', async () => {
    const values: Record<string, unknown> = {};
    storedValues(values);

    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 1 });
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 2 });
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: true, visitCount: 3 });
    expect(values[ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]).toBe(3);
  });

  it('never arms once the actions menu has been opened, and stops counting visits', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_USED_KEY]: true });

    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    // Not even the counter is touched — a climber past the tip writes nothing.
    expect(setMock).not.toHaveBeenCalled();
  });

  it('never arms for someone who already saw the tip under the old timing', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_KEY]: true, [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: 9 });

    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
  });

  it('stops writing the counter once the threshold is reached', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: quickActionsTip.QUICK_ACTIONS_TIP_MIN_VISITS });

    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: true, visitCount: 3 });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('stays quiet when the store is unreadable rather than nagging', async () => {
    getMock.mockRejectedValue(new Error('keychain unavailable'));

    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
  });
});

describe('markQuickActionsUsed', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
    setMock.mockResolvedValue(undefined);
  });

  it('persists the flag the tip reads', async () => {
    await quickActionsTip.markQuickActionsUsed();
    expect(setMock).toHaveBeenCalledWith(ONBOARDING_TIP_QUICKACTIONS_USED_KEY, true);
  });

  it('stays quiet while the menu-used flag is still being saved', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: 3 });
    let finishWrite!: () => void;
    setMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    const pendingWrite = quickActionsTip.markQuickActionsUsed();
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    finishWrite();
    await pendingWrite;
  });

  it('writes once per launch even though every menu open calls it', async () => {
    await quickActionsTip.markQuickActionsUsed();
    await quickActionsTip.markQuickActionsUsed();
    await quickActionsTip.markQuickActionsUsed();
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});

describe('pending tip persistence', () => {
  it('does not re-arm on rapid refocus before the seen flag is saved', async () => {
    storedValues({ [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: 3 });
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: true, visitCount: 3 });
    let finishWrite!: () => void;
    setMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    const pendingWrite = quickActionsTip.markQuickActionsTipSeen();
    await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    await quickActionsTip.markQuickActionsTipSeen();
    expect(setMock).toHaveBeenCalledExactlyOnceWith(ONBOARDING_TIP_QUICKACTIONS_KEY, true);
    finishWrite();
    await pendingWrite;
  });

  it.each(['markQuickActionsTipSeen', 'markQuickActionsUsed'] as const)(
    'keeps this launch quiet when %s cannot persist',
    async (markHandled) => {
      storedValues({ [ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY]: 3 });
      setMock.mockRejectedValue(new Error('keychain unavailable'));
      await expect(quickActionsTip[markHandled]()).resolves.toBeUndefined();
      await expect(quickActionsTip.resolveQuickActionsTip()).resolves.toEqual({ armed: false, visitCount: 0 });
    },
  );

  it('ignores stale unseen reads when the menu opens before they finish', async () => {
    let finishRead!: (seen: boolean) => void;
    getMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishRead = resolve;
      }),
    );
    const pendingDecision = quickActionsTip.resolveQuickActionsTip();
    await quickActionsTip.markQuickActionsUsed();
    finishRead(false);
    await expect(pendingDecision).resolves.toEqual({ armed: false, visitCount: 0 });
    expect(setMock).toHaveBeenCalledExactlyOnceWith(ONBOARDING_TIP_QUICKACTIONS_USED_KEY, true);
  });
});
