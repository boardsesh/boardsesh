import { useCallback } from 'react';
import { getSetting, setSetting, useSetting } from './hooks';
import { offlineBoardKey, type OfflineBoardScope } from './offline-board-key';

/**
 * Read/write the per-board offline flag on top of the `syncEnabledBoards` setting.
 * Enabling adds the board's `"boardType:layoutId:sizeId"` key; disabling removes it.
 * The downloaded rows + checkpoints are deliberately left in place on disable — they
 * are the expensive shared reference cache, so re-enabling resumes from the checkpoint
 * instead of re-crawling. Triggering the actual download after enabling is the caller's
 * job (the My Boards screen kicks a sync); this module only owns the setting.
 */

export function isOfflineBoardEnabled(scope: OfflineBoardScope): boolean {
  return getSetting('syncEnabledBoards').includes(offlineBoardKey(scope));
}

export function setOfflineBoardEnabled(scope: OfflineBoardScope, enabled: boolean): void {
  const key = offlineBoardKey(scope);
  const current = getSetting('syncEnabledBoards');
  const alreadyEnabled = current.includes(key);
  if (enabled === alreadyEnabled) return;
  const next = enabled ? [...current, key] : current.filter((entry) => entry !== key);
  setSetting('syncEnabledBoards', next);
}

/**
 * Reactive per-board offline flag. Returns `[enabled, setEnabled]`, re-rendering
 * when any board is toggled (the underlying `syncEnabledBoards` store is a single
 * MMKV key). The setter is stable per (boardType, layoutId, sizeId).
 */
export function useOfflineBoardEnabled(scope: OfflineBoardScope): [boolean, (enabled: boolean) => void] {
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const enabled = enabledBoards.includes(offlineBoardKey(scope));

  const { boardType, layoutId, sizeId } = scope;
  const setEnabled = useCallback(
    (next: boolean) => setOfflineBoardEnabled({ boardType, layoutId, sizeId }, next),
    [boardType, layoutId, sizeId],
  );

  return [enabled, setEnabled];
}
