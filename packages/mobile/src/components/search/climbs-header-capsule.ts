// What the Climbs header's centre slot shows: the climb on the wall, the
// "You have the board" capsule, or nothing.
//
// Owner decision (2026-11-02): the climb on the wall always shows while it was
// lit under an hour ago, or while a live link says it is lit, and it can be
// hidden. Nothing else hides it: not the climb being your own queue head or the
// MiniPlayer's pick, not this phone holding the link, not a crew, not the layout
// (iPhone, iPad, Duo, Material). Age is the only rule, and it lives in
// `presence-freshness.ts` so the player and this header never disagree.
//
// One skin choice remains. While this phone holds the board where the iOS 26
// accessory platter collapses, and the wall shows the climber's own queue head,
// the held capsule IS the climb on the wall: same climb, drawn with the hold
// pattern frost, tap to let go. It carries the same Hide.
//
// A Hide holds until a different climb goes up on that board
// (`wall-capsule-dismissal-store.ts`). The held capsule draws the queue head
// without presence, so when the feed drops (a WebSocket drop, a backend deploy,
// weak gym signal) or "Turn off all lights" clears it, the hidden climb would
// come back in that skin. It does not: the slot stays empty while the queue
// head is the hidden climb.

import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

/** The wall's climb once it is trusted (fresh or linked), with its dismissal scope. */
export type TrustedWallClimb = {
  climb: BoardPresenceClimb;
  boardId: number;
  /** `wallCapsuleOccurrenceKey(boardId, climb)`: board + climb + lit time. */
  occurrenceKey: string;
};

export type ClimbsHeaderCapsuleInput = {
  /** Null when there is no live feed, no climb, or the climb is past the hour with no link. */
  wall: TrustedWallClimb | null;
  /** From `useWallCapsuleDismissal` for `wall`'s climb. */
  dismissal: { loaded: boolean; dismissed: boolean };
  /**
   * This phone holds the board and the accessory platter can collapse (iOS 26
   * iPhone, or an iPad in a narrow Split View), so the header carries the
   * "You have the board" cue.
   */
  heldCue: boolean;
  /** `wall` is the queue head's climb, the climb the held capsule draws. */
  wallIsQueueHead: boolean;
  /** The queue head is the climb hidden on this board. */
  queueHeadHidden: boolean;
};

export type ClimbsHeaderCapsule =
  | { kind: 'wall'; wall: TrustedWallClimb }
  /** `wall` is set when the held capsule is drawing the climb on the wall, and can hide it. */
  | { kind: 'held'; wall: TrustedWallClimb | null }
  | null;

export function resolveClimbsHeaderCapsule({
  wall,
  dismissal,
  heldCue,
  wallIsQueueHead,
  queueHeadHidden,
}: ClimbsHeaderCapsuleInput): ClimbsHeaderCapsule {
  if (wall !== null) {
    // Hidden while a stored Hide may still be loading, so it never flashes, and
    // after Hide until a different climb goes up on that board.
    if (!dismissal.loaded || dismissal.dismissed) return null;
    if (heldCue && wallIsQueueHead) return { kind: 'held', wall };
    return { kind: 'wall', wall };
  }
  if (!heldCue) return null;
  // No trusted wall climb, so the held capsule falls back to the queue head. A
  // hidden climb never comes back that way.
  return queueHeadHidden ? null : { kind: 'held', wall: null };
}
