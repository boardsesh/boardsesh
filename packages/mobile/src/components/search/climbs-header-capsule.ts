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
  /** From `useWallCapsuleDismissed` for `wall`'s occurrence. */
  dismissal: { loaded: boolean; dismissed: boolean };
  /**
   * This phone holds the board and the accessory platter can collapse (iOS 26
   * iPhone, or an iPad in a narrow Split View), so the header carries the
   * "You have the board" cue.
   */
  heldCue: boolean;
  /** The queue head's climb uuid, the climb the held capsule draws. */
  queueHeadUuid: string | null;
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
  queueHeadUuid,
}: ClimbsHeaderCapsuleInput): ClimbsHeaderCapsule {
  if (wall !== null) {
    // Hidden while a stored Hide may still be loading, so it never flashes, and
    // after Hide until another climb (or a re-light) changes the occurrence.
    if (!dismissal.loaded || dismissal.dismissed) return null;
    if (heldCue && queueHeadUuid !== null && wall.climb.climbUuid === queueHeadUuid) return { kind: 'held', wall };
    return { kind: 'wall', wall };
  }
  return heldCue ? { kind: 'held', wall: null } : null;
}
