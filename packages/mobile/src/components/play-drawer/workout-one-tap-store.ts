// What every one-tap Fell / Sent shares (#6231, #6940), whichever surface it is
// on: the player's small row, and the MiniPlayer's pair. UIKit mounts the
// MiniPlayer twice (react-native-screens renders the bottom accessory's regular
// and inline placements at once, and their state is not shared), and the
// player's row can be up at the same time on a tablet or the open Duo. So the
// one-tap guard, the in-flight saves and the saved line live here, once:
//
// - The guard: a tap within `ONE_TAP_GUARD_MS` of the last one, on any surface,
//   is dropped. A tap on the open bar, a scroll that minimizes it, and a tap on
//   the minimized bar's Sent log one go, never two.
// - In flight: a tap for a queue item whose one-tap save hasn't settled yet is
//   dropped, wherever the first tap came from.
// - The notice: the last thing a tap said, so every surface showing Fell / Sent
//   marks the same button. Only the surface that was tapped plays the haptic and
//   speaks it (`use-workout-one-tap.ts`).
import { useCallback, useSyncExternalStore } from 'react';
import type { WorkoutOneTapNotice } from './use-workout-one-tap';

/** What a surface shows of a notice: `row` shows both kinds, `toast` (the MiniPlayer) only a saved go. */
export type OneTapNoticeReader = 'row' | 'toast';

let lastTapAtMs: number | null = null;
const pendingQueueItems = new Set<string>();
let notice: WorkoutOneTapNotice | null = null;
let noticeTimeout: ReturnType<typeof setTimeout> | null = null;
const listeners = new Map<() => void, OneTapNoticeReader>();

function emit() {
  for (const listener of listeners.keys()) listener();
}

/**
 * Claims the guard for a tap at `tappedAtMs`: false when the last tap on any
 * surface was less than `guardMs` ago. A claimed tap restarts the guard.
 */
export function claimOneTapGuard(tappedAtMs: number, guardMs: number): boolean {
  if (lastTapAtMs !== null && tappedAtMs - lastTapAtMs < guardMs) return false;
  lastTapAtMs = tappedAtMs;
  return true;
}

/** True while a one-tap save for this queue item is still in flight, from any surface. */
export function isOneTapSavePending(queueItemUuid: string): boolean {
  return pendingQueueItems.has(queueItemUuid);
}

export function markOneTapSavePending(queueItemUuid: string): void {
  pendingQueueItems.add(queueItemUuid);
}

export function settleOneTapSave(queueItemUuid: string): void {
  pendingQueueItems.delete(queueItemUuid);
}

/**
 * Whether a mounted surface can show this notice: any surface shows a saved
 * go, only a `row` surface shows a message. When none can, the tap says it with
 * the toast instead.
 */
export function hasOneTapNoticeReader(kind: WorkoutOneTapNotice['kind']): boolean {
  for (const reader of listeners.values()) {
    if (kind === 'saved' || reader === 'row') return true;
  }
  return false;
}

/** Shows `next` on every surface for `durationMs`, replacing the last notice and restarting its clock. */
export function setOneTapNotice(next: WorkoutOneTapNotice, durationMs: number): void {
  if (noticeTimeout !== null) clearTimeout(noticeTimeout);
  notice = next;
  noticeTimeout = setTimeout(() => {
    noticeTimeout = null;
    notice = null;
    emit();
  }, durationMs);
  emit();
}

export function clearOneTapNotice(): void {
  if (noticeTimeout !== null) clearTimeout(noticeTimeout);
  noticeTimeout = null;
  if (notice === null) return;
  notice = null;
  emit();
}

function getNotice(): WorkoutOneTapNotice | null {
  return notice;
}

/** The shared notice, for a surface that reads it as `reader`. */
export function useSharedOneTapNotice(reader: OneTapNoticeReader): WorkoutOneTapNotice | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      listeners.set(listener, reader);
      return () => {
        listeners.delete(listener);
      };
    },
    [reader],
  );
  return useSyncExternalStore(subscribe, getNotice, getNotice);
}

export function resetWorkoutOneTapStoreForTests(): void {
  lastTapAtMs = null;
  pendingQueueItems.clear();
  if (noticeTimeout !== null) clearTimeout(noticeTimeout);
  noticeTimeout = null;
  notice = null;
  listeners.clear();
}
