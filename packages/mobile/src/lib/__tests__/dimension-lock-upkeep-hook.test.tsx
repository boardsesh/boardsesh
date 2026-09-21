// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadDimensionLocks,
  resetDimensionLocksForTests,
  setDimensionLock,
  useDimensionLockUpkeep,
} from '../dimension-lock-store';
import type { DimensionLockState } from '../dimension-chips';

// A lock that's live: iOS, board in scope, chip pinned, pinned set loaded.
const LIVE: DimensionLockState = { lockSupported: true, locked: true, inScope: true, pinned: true, pinsLoaded: true };

describe('useDimensionLockUpkeep', () => {
  beforeEach(async () => {
    // The AsyncStorage test stub is one in-memory map per file; start each case empty.
    await AsyncStorage.clear();
    resetDimensionLocksForTests();
  });

  it('re-applies once when the lock is live and the filter is off', () => {
    const pin = vi.fn();
    renderHook(() => useDimensionLockUpkeep('tall', LIVE, false, pin));
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it('does not re-apply when unlocked, out of scope, unpinned, not loaded, unsupported or already on', () => {
    const cases: [DimensionLockState, boolean][] = [
      [{ ...LIVE, locked: false }, false],
      [{ ...LIVE, inScope: false }, false],
      [{ ...LIVE, pinned: false }, false],
      [{ ...LIVE, pinsLoaded: false }, false],
      [{ ...LIVE, lockSupported: false }, false],
      [LIVE, true],
    ];
    for (const [state, filterActive] of cases) {
      const pin = vi.fn();
      renderHook(() => useDimensionLockUpkeep('wide', state, filterActive, pin));
      expect(pin).not.toHaveBeenCalled();
    }
  });

  it('re-applies after a clear (locked, filter goes on → off)', () => {
    const pin = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useDimensionLockUpkeep('tall', LIVE, active, pin),
      { initialProps: { active: true } }, // already on → nothing to do yet
    );
    expect(pin).not.toHaveBeenCalled();
    rerender({ active: false }); // Reset cleared the filter → re-apply
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it('drops the lock once its chip is unpinned, and does not re-apply', async () => {
    setDimensionLock('wide', true);
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: true });
    const pin = vi.fn();
    renderHook(() => useDimensionLockUpkeep('wide', { ...LIVE, pinned: false }, false, pin));
    expect(pin).not.toHaveBeenCalled();
    await waitFor(async () => {
      await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: false });
    });
  });

  it('keeps the lock while the pinned set is still loading (the defaults are not the user’s pins)', async () => {
    setDimensionLock('tall', true);
    await loadDimensionLocks();
    renderHook(() => useDimensionLockUpkeep('tall', { ...LIVE, pinned: false, pinsLoaded: false }, true, vi.fn()));
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: false });
  });

  it('never clears a lock on a platform that cannot show it', async () => {
    setDimensionLock('tall', true);
    await loadDimensionLocks();
    renderHook(() => useDimensionLockUpkeep('tall', { ...LIVE, lockSupported: false, pinned: false }, false, vi.fn()));
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: false });
  });
});
