import { describe, it, expect, vi } from 'vitest';
import {
  buildDimensionChip,
  isDimensionChipLocked,
  shouldClearDimensionLock,
  shouldReapplyDimension,
  type DimensionLockState,
} from '../dimension-chips';

// A lock that's live: iOS, board in scope, chip pinned, pinned set loaded.
const LIVE: DimensionLockState = { lockSupported: true, locked: true, inScope: true, pinned: true, pinsLoaded: true };

describe('isDimensionChipLocked', () => {
  it('shows a stored lock only where the platform can set it (iOS)', () => {
    expect(isDimensionChipLocked(LIVE)).toBe(true);
    expect(isDimensionChipLocked({ ...LIVE, locked: false })).toBe(false);
    // Android / web: a lock left in storage by an older build never shows.
    expect(isDimensionChipLocked({ ...LIVE, lockSupported: false })).toBe(false);
  });
});

describe('shouldReapplyDimension', () => {
  it('re-applies a live lock whose filter was cleared', () => {
    expect(shouldReapplyDimension(LIVE, false)).toBe(true);
  });

  it('does nothing when the filter is already on', () => {
    expect(shouldReapplyDimension(LIVE, true)).toBe(false);
  });

  it('never re-applies a locked but unpinned chip, so its token stays clearable', () => {
    expect(shouldReapplyDimension({ ...LIVE, pinned: false }, false)).toBe(false);
  });

  it('waits for the pinned set to load (the defaults include Tall and Wide)', () => {
    expect(shouldReapplyDimension({ ...LIVE, pinsLoaded: false }, false)).toBe(false);
  });

  it('ignores a lock on a board size without the dimension', () => {
    expect(shouldReapplyDimension({ ...LIVE, inScope: false }, false)).toBe(false);
  });

  it('ignores a stored lock on Android / web, where the chip cannot show or clear it', () => {
    expect(shouldReapplyDimension({ ...LIVE, lockSupported: false }, false)).toBe(false);
  });

  it('does nothing without a lock', () => {
    expect(shouldReapplyDimension({ ...LIVE, locked: false }, false)).toBe(false);
  });
});

describe('shouldClearDimensionLock', () => {
  it('drops the lock of an unpinned chip once the pinned set has loaded', () => {
    expect(shouldClearDimensionLock({ ...LIVE, pinned: false })).toBe(true);
  });

  it('keeps it while pinned, before the pinned set loads, without a lock, or where locks are unsupported', () => {
    expect(shouldClearDimensionLock(LIVE)).toBe(false);
    expect(shouldClearDimensionLock({ ...LIVE, pinned: false, pinsLoaded: false })).toBe(false);
    expect(shouldClearDimensionLock({ ...LIVE, pinned: false, locked: false })).toBe(false);
    expect(shouldClearDimensionLock({ ...LIVE, pinned: false, lockSupported: false })).toBe(false);
  });

  it('keeps the lock of a pinned chip on a board without the dimension (it wakes up on a board that has it)', () => {
    expect(shouldClearDimensionLock({ ...LIVE, inScope: false })).toBe(false);
  });
});

describe('buildDimensionChip', () => {
  function build(locked: boolean, filterActive: boolean) {
    const setFilter = vi.fn();
    const setLock = vi.fn();
    const chip = buildDimensionChip({ key: 'tall', locked, filterActive, setFilter, setLock });
    return { chip, setFilter, setLock };
  }

  it('tap turns an unlocked chip on, and off again', () => {
    const off = build(false, false);
    expect(off.chip).toMatchObject({ key: 'tall', active: false, locked: false });
    off.chip.onToggle();
    expect(off.setFilter).toHaveBeenCalledWith(true);

    const on = build(false, true);
    expect(on.chip.active).toBe(true);
    on.chip.onToggle();
    expect(on.setFilter).toHaveBeenCalledWith(false);
  });

  it('a locked chip reads as active and ignores tap', () => {
    const { chip, setFilter, setLock } = build(true, false);
    expect(chip).toMatchObject({ active: true, locked: true });
    chip.onToggle();
    expect(setFilter).not.toHaveBeenCalled();
    expect(setLock).not.toHaveBeenCalled();
  });

  it('locking turns the filter on straight away', () => {
    const { chip, setFilter, setLock } = build(false, false);
    chip.onToggleLock();
    expect(setLock).toHaveBeenCalledWith(true);
    expect(setFilter).toHaveBeenCalledWith(true);
  });

  it('unlocking leaves the filter as it is (one more tap turns it off)', () => {
    const { chip, setFilter, setLock } = build(true, true);
    chip.onToggleLock();
    expect(setLock).toHaveBeenCalledWith(false);
    expect(setFilter).not.toHaveBeenCalled();
  });
});
