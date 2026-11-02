// Source-of-truth selector for the wall's lit climb on the status surfaces.
//
// The wall's lit climb used to override the bottom accessory (the queue bar). It
// no longer does — the accessory shows the local queue head only, and the wall's
// lit climb gets its own surfaces: the iPad wall strip, the sidebar cell, and the
// Climbs header's WallStatusCapsule, which since the 2026-11-02 owner decision
// shows the wall's climb even when it IS your queue head
// (`resolveClimbsHeaderCapsule`).
//
// PERF (RN hot-path checklist): this read is O(1) — it uses only the current wall
// climb from the split presence context and never scans history. It re-renders on
// a wall event (bounded, not per-frame), which is exactly when the strip's content
// must change.

import { useMemo } from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useBoardPresenceWallClimb } from '@boardsesh/board-presence-react';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';

/**
 * The wall's lit climb while a board feed is live, else `null`.
 *
 * Returns the RAW `BoardPresenceClimb` (not the minimal converted `Climb`) so the
 * surfaces can show the sender — `sentByDisplayName`/`sentByAvatarUrl`/`sentByUserId`
 * — which `boardPresenceClimbToClimb` drops. Convert to a `Climb` at the point of
 * use (e.g. opening the play drawer).
 *
 * It used to take the queue head's uuid and return `null` when the wall showed
 * it, so the Climbs header capsule stayed hidden in the solo case. The owner
 * reversed that on 2026-11-02: the capsule shows the climb on the wall whatever
 * the queue holds, so no caller filters any more.
 */
export function useLiveWallClimb(): BoardPresenceClimb | null {
  const { enabled, boardId } = useBoardPresenceControls();
  // Already `null` unless a feed is live with a current climb — the isLive gate
  // is subsumed by this narrower context, so this hook re-renders only on an
  // actual wall-climb change instead of every presence event (holder/stats too).
  const wallClimb = useBoardPresenceWallClimb();

  // `wallClimb` only changes on a wall event (bounded, not per-frame), so the memo
  // recomputes off a stable input set and the read stays O(1) on the hot path.
  return useMemo(() => {
    const live = enabled && boardId !== null && wallClimb !== null;
    return live ? wallClimb : null;
  }, [enabled, boardId, wallClimb]);
}
