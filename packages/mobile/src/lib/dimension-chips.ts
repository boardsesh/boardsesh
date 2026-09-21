// Pure rules for the Tall / Wide board-shape chips on the climbs screen: how a
// chip reacts to tap and to Lock / Unlock, and when a stored lock is allowed to
// act. No React and no platform imports, so every rule is unit-testable; the
// screen feeds in the platform, board scope, pinned set and stored locks.
//
// The lock (long-press Lock / Unlock) exists only on iOS, whose SwiftUI chip has
// a long-press menu. Android and web chips just toggle, so a lock stored there
// (e.g. left over from an older build) must never act: it isn't shown and can't
// be cleared from the chip.

export type DimensionKey = 'tall' | 'wide';

/**
 * One Tall/Wide chip as the chip row renders it. Tap toggles the filter;
 * `onToggleLock` backs the iOS long-press Lock / Unlock. A locked chip shows a
 * lock icon, reads as active, and ignores tap until unlocked.
 */
export type DimensionChip = {
  key: DimensionKey;
  active: boolean;
  locked: boolean;
  onToggle: () => void;
  onToggleLock: () => void;
};

/** Everything that decides whether one dimension's stored lock may act. */
export type DimensionLockState = {
  /** This platform's chip can show and set the lock (iOS only). */
  lockSupported: boolean;
  /** The persisted lock for this dimension. */
  locked: boolean;
  /** The board size has this dimension (getTallWideScope). */
  inScope: boolean;
  /** This dimension's chip is in the user's pinned set. */
  pinned: boolean;
  /** The pinned set has loaded; before that `pinned` reflects the defaults. */
  pinsLoaded: boolean;
};

/**
 * Whether the chip should present as locked. A lock the platform can't show is
 * ignored outright, so an Android/web chip always toggles.
 */
export function isDimensionChipLocked({ lockSupported, locked }: DimensionLockState): boolean {
  return lockSupported && locked;
}

/**
 * Re-apply rule: put a locked dimension's filter back on after a Reset or clear,
 * but only while its chip is actually in the row (supported platform, board in
 * scope, chip pinned, pinned set loaded). An unpinned chip's filter shows as a
 * removable token instead, and re-applying it there would make that token
 * impossible to clear.
 */
export function shouldReapplyDimension(state: DimensionLockState, filterActive: boolean): boolean {
  return isDimensionChipLocked(state) && state.inScope && state.pinned && state.pinsLoaded && !filterActive;
}

/**
 * Unpinning a chip drops its lock, so pinning it again weeks later doesn't
 * switch the filter on by itself. Waits for the pinned set to load (before that
 * `pinned` is only the default set) and only touches a lock this platform can set.
 */
export function shouldClearDimensionLock(state: DimensionLockState): boolean {
  return isDimensionChipLocked(state) && state.pinsLoaded && !state.pinned;
}

/**
 * Builds one chip. `setFilter` turns the dimension's filter on or off;
 * `setLock` persists the lock. A locked chip ignores tap, and locking also turns
 * the filter on so the chip's lit state matches the list straight away.
 */
export function buildDimensionChip({
  key,
  locked,
  filterActive,
  setFilter,
  setLock,
}: {
  key: DimensionKey;
  locked: boolean;
  filterActive: boolean;
  setFilter: (on: boolean) => void;
  setLock: (locked: boolean) => void;
}): DimensionChip {
  return {
    key,
    active: locked || filterActive,
    locked,
    onToggle: () => {
      if (locked) return;
      setFilter(!filterActive);
    },
    onToggleLock: () => {
      const next = !locked;
      setLock(next);
      if (next) setFilter(true);
    },
  };
}
