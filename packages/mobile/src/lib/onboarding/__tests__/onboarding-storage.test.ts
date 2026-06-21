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

import {
  ONBOARDING_BOARD_TIP_KEY,
  ONBOARDING_SEEN_KEY,
  ONBOARDING_TIP_WORKOUT_KEY,
} from '@boardsesh/key-value-storage';
import {
  clearBoardRevealTipPending,
  clearOnboardingSeen,
  hasBoardRevealTipPending,
  hasSeenOnboarding,
  hasSeenTip,
  markOnboardingSeen,
  markTipSeen,
  replayOnboarding,
  setBoardRevealTipPending,
} from '../onboarding-storage';

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

  describe('board-history reveal banner flag', () => {
    it('arms the banner', async () => {
      setMock.mockResolvedValue(undefined);
      await setBoardRevealTipPending();
      expect(setMock).toHaveBeenCalledWith(ONBOARDING_BOARD_TIP_KEY, true);
    });

    it('reports pending only when the flag is true', async () => {
      getMock.mockResolvedValue(true);
      await expect(hasBoardRevealTipPending()).resolves.toBe(true);
      getMock.mockResolvedValue(null);
      await expect(hasBoardRevealTipPending()).resolves.toBe(false);
    });

    it('treats a read error as not-pending (a missed banner beats a stuck one)', async () => {
      getMock.mockRejectedValue(new Error('keychain unavailable'));
      await expect(hasBoardRevealTipPending()).resolves.toBe(false);
    });

    it('clears the banner flag once shown', async () => {
      removeMock.mockResolvedValue(undefined);
      await clearBoardRevealTipPending();
      expect(removeMock).toHaveBeenCalledWith(ONBOARDING_BOARD_TIP_KEY);
    });
  });

  describe('just-in-time tip flags', () => {
    it('reports a tip seen only when the flag is true', async () => {
      getMock.mockResolvedValue(true);
      await expect(hasSeenTip(ONBOARDING_TIP_WORKOUT_KEY)).resolves.toBe(true);
      getMock.mockResolvedValue(null);
      await expect(hasSeenTip(ONBOARDING_TIP_WORKOUT_KEY)).resolves.toBe(false);
    });

    it('treats a read error as seen (a flaky store must not nag the same tip)', async () => {
      getMock.mockRejectedValue(new Error('keychain unavailable'));
      await expect(hasSeenTip(ONBOARDING_TIP_WORKOUT_KEY)).resolves.toBe(true);
    });

    it('marks a tip seen by its key', async () => {
      setMock.mockResolvedValue(undefined);
      await markTipSeen(ONBOARDING_TIP_WORKOUT_KEY);
      expect(setMock).toHaveBeenCalledWith(ONBOARDING_TIP_WORKOUT_KEY, true);
    });
  });
});
