// @vitest-environment jsdom
import { useCallback, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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
    renderHook(() => useDimensionLockUpkeep({ key: 'tall', state: LIVE, filterActive: false, searchReady: true, pin }));
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
      renderHook(() => useDimensionLockUpkeep({ key: 'wide', state, filterActive, searchReady: true, pin }));
      expect(pin).not.toHaveBeenCalled();
    }
  });

  it('re-applies after a clear (locked, filter goes on → off)', () => {
    const pin = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useDimensionLockUpkeep({ key: 'tall', state: LIVE, filterActive: active, searchReady: true, pin }),
      { initialProps: { active: true } }, // already on → nothing to do yet
    );
    expect(pin).not.toHaveBeenCalled();
    rerender({ active: false }); // Reset cleared the filter → re-apply
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it('waits for the search restore, then re-applies (restore lands after locks and pins load)', () => {
    // A cold start in miniature: locks and pins are already loaded (LIVE), but the
    // board's saved search is still being restored. The restore replaces the whole
    // search, so a filter re-applied before it would be overwritten and the chip
    // would read locked over an unfiltered list.
    const pin = vi.fn();
    const { result } = renderHook(() => {
      const [filters, setFilters] = useState({ onlyTallClimbs: false });
      const [searchReady, setSearchReady] = useState(false);
      const pinTall = useCallback(() => {
        pin();
        setFilters((previous) => ({ ...previous, onlyTallClimbs: true }));
      }, []);
      useDimensionLockUpkeep({
        key: 'tall',
        state: LIVE,
        filterActive: filters.onlyTallClimbs,
        searchReady,
        pin: pinTall,
      });
      // The screen's restore: replaceSearch + setRestoredKey in one batch.
      const restore = useCallback((saved: { onlyTallClimbs: boolean }) => {
        setFilters(saved);
        setSearchReady(true);
      }, []);
      return { filters, restore };
    });
    expect(pin).not.toHaveBeenCalled();
    act(() => result.current.restore({ onlyTallClimbs: false }));
    expect(pin).toHaveBeenCalledTimes(1);
    expect(result.current.filters.onlyTallClimbs).toBe(true);
  });

  it('drops the lock once its chip is unpinned, and does not re-apply', async () => {
    setDimensionLock('wide', true);
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: true });
    const pin = vi.fn();
    renderHook(() =>
      useDimensionLockUpkeep({
        key: 'wide',
        state: { ...LIVE, pinned: false },
        filterActive: false,
        searchReady: true,
        pin,
      }),
    );
    expect(pin).not.toHaveBeenCalled();
    await waitFor(async () => {
      await expect(loadDimensionLocks()).resolves.toEqual({ tall: false, wide: false });
    });
  });

  it('keeps the lock while the pinned set is still loading (the defaults are not the user’s pins)', async () => {
    setDimensionLock('tall', true);
    await loadDimensionLocks();
    renderHook(() =>
      useDimensionLockUpkeep({
        key: 'tall',
        state: { ...LIVE, pinned: false, pinsLoaded: false },
        filterActive: true,
        searchReady: true,
        pin: vi.fn(),
      }),
    );
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: false });
  });

  it('never clears a lock on a platform that cannot show it', async () => {
    setDimensionLock('tall', true);
    await loadDimensionLocks();
    renderHook(() =>
      useDimensionLockUpkeep({
        key: 'tall',
        state: { ...LIVE, lockSupported: false, pinned: false },
        filterActive: false,
        searchReady: true,
        pin: vi.fn(),
      }),
    );
    await expect(loadDimensionLocks()).resolves.toEqual({ tall: true, wide: false });
  });
});
