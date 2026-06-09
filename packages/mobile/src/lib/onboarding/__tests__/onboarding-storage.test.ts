import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the secure-store adapter (the seam) rather than expo-secure-store.
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

import { ONBOARDING_SEEN_KEY } from '@boardsesh/key-value-storage';
import { clearOnboardingSeen, hasSeenOnboarding, markOnboardingSeen, replayOnboarding } from '../onboarding-storage';

describe('onboarding storage', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    removeMock.mockReset();
  });

  it('reports unseen on a fresh install (flag absent)', async () => {
    getMock.mockResolvedValue(null);
    await expect(hasSeenOnboarding()).resolves.toBe(false);
    expect(getMock).toHaveBeenCalledWith(ONBOARDING_SEEN_KEY);
  });

  it('reports seen once the flag is true', async () => {
    getMock.mockResolvedValue(true);
    await expect(hasSeenOnboarding()).resolves.toBe(true);
  });

  it('treats a storage read error as unseen (show the tour rather than skip it)', async () => {
    getMock.mockRejectedValue(new Error('keychain unavailable'));
    await expect(hasSeenOnboarding()).resolves.toBe(false);
  });

  it('persists the seen flag as true', async () => {
    setMock.mockResolvedValue(undefined);
    await markOnboardingSeen();
    expect(setMock).toHaveBeenCalledWith(ONBOARDING_SEEN_KEY, true);
  });

  it('propagates a write failure so callers can log/report it', async () => {
    // The onboarding screen catches this rejection (console.warn + reportError)
    // instead of silently swallowing it — a lost write reshows the tour on every
    // cold start, so it must not fail quietly.
    setMock.mockRejectedValue(new Error('keychain locked'));
    await expect(markOnboardingSeen()).rejects.toThrow('keychain locked');
  });

  it('clears the seen flag for replay', async () => {
    removeMock.mockResolvedValue(undefined);
    await clearOnboardingSeen();
    expect(removeMock).toHaveBeenCalledWith(ONBOARDING_SEEN_KEY);
  });

  describe('replayOnboarding', () => {
    it('clears the seen flag BEFORE navigating (race-free)', async () => {
      const order: string[] = [];
      // remove resolves on the next microtask, after which navigate runs.
      removeMock.mockImplementation(async () => {
        order.push('clear');
      });
      const navigate = vi.fn(() => {
        order.push('navigate');
      });

      await replayOnboarding(navigate);

      expect(removeMock).toHaveBeenCalledWith(ONBOARDING_SEEN_KEY);
      expect(navigate).toHaveBeenCalledTimes(1);
      // The clear must settle first; otherwise a fast finish/skip could write the
      // flag and a late clear would wipe it, re-showing the tour on next launch.
      expect(order).toEqual(['clear', 'navigate']);
    });

    it('rejects (without navigating) when the clear fails, so the row can show an error', async () => {
      removeMock.mockRejectedValue(new Error('keychain locked'));
      const navigate = vi.fn();
      await expect(replayOnboarding(navigate)).rejects.toThrow('keychain locked');
      // Don't open a tour that the failed clear would re-show forever — the
      // caller surfaces an error toast instead.
      expect(navigate).not.toHaveBeenCalled();
    });

    it('does not navigate until the clear promise resolves', async () => {
      let resolveClear: () => void = () => {};
      removeMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveClear = resolve;
          }),
      );
      const navigate = vi.fn();

      const pending = replayOnboarding(navigate);
      // The clear is still in flight — navigation must NOT have happened yet.
      await Promise.resolve();
      expect(navigate).not.toHaveBeenCalled();

      resolveClear();
      await pending;
      expect(navigate).toHaveBeenCalledTimes(1);
    });
  });
});
