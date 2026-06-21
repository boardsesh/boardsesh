// Source-of-truth selector for the current-climb accessory.
//
// When the `board-presence` flag is on AND a board feed is live with a current
// climb, the accessory should reflect the wall's actual lit climb instead of the
// local queue head. Otherwise it stays on the local queue head (today's
// behaviour).
//
// PERF (RN hot-path checklist): this read is O(1) — it uses only the current
// wall climb from the split presence context and never scans history.

import { useMemo } from 'react';
import type { Climb } from '@boardsesh/queue';
import { useBoardPresenceCurrent, useBoardPresenceHasClimb } from '@boardsesh/board-presence-react';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';

/**
 * Returns the climb the accessory should show. With the flag off (or no live
 * wall feed / no wall climb), returns `localClimb` unchanged so behaviour is
 * exactly as today. With a live wall feed, returns the wall's current climb.
 *
 * Pass the local queue head as `localClimb`; the override never affects queue
 * navigation/swipe — only what the leading slot displays.
 */
export function useWallOrQueueCurrentClimb(localClimb: Climb | null): Climb | null {
  const { enabled, boardId } = useBoardPresenceControls();
  const { currentClimb: wallClimb, isLive } = useBoardPresenceCurrent();

  const useWall = enabled && boardId !== null && isLive && wallClimb !== null;

  return useMemo(() => {
    if (useWall && wallClimb) {
      if (localClimb?.uuid === wallClimb.climbUuid) {
        return localClimb;
      }
      return boardPresenceClimbToClimb(wallClimb);
    }
    return localClimb;
    // `wallClimb` only changes on a wall event (bounded, not per-frame), so
    // recomputing when its identity changes keeps the read O(1) on the hot path.
  }, [useWall, wallClimb, localClimb]);
}

/**
 * True when the accessory is pinned to a live wall feed — i.e. the leading slot
 * is showing the wall's lit climb rather than the local queue head. The carousel
 * uses this to (a) open the wall climb on tap and (b) suppress the horizontal
 * prev/next swipe, which would otherwise step the invisible local queue while
 * the pinned label never moves (so the swipe looks dead). O(1) read.
 */
export function useIsWallPinned(): boolean {
  const { enabled, boardId } = useBoardPresenceControls();
  const { currentClimb: wallClimb, isLive } = useBoardPresenceCurrent();
  return enabled && boardId !== null && isLive && wallClimb !== null;
}

/**
 * Presence-only sibling of {@link useIsWallPinned}: true when a live wall feed has
 * a current climb. Reads the presence-only `useBoardPresenceHasClimb` boolean
 * instead of `useBoardPresenceCurrent`, so consumers re-render only when wall
 * presence appears/disappears — NOT on every board-level climb change. Use this
 * (not `useIsWallPinned`) to gate chrome that mounts the accessory / tab tree.
 */
export function useHasWallClimb(): boolean {
  const { enabled, boardId } = useBoardPresenceControls();
  const hasWallClimb = useBoardPresenceHasClimb();
  return enabled && boardId !== null && hasWallClimb;
}
