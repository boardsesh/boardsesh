// Build a play-drawer-ready `Climb` from a notification row.
//
// A standalone leaf like `notification-copy.ts` and `notification-climb-render.ts`
// beside it: no React, no theme. The twin of `tick-to-climb.ts`, which does the
// same job for a session tick.
//
// This is what lets a notification open the drawer DIRECTLY instead of routing
// through the climb page. That page is the `ref` fallback for callers that hold
// only a uuid — it re-fetches the climb by uuid and, per its own docblock,
// ignores the preview flag. A notification carries the climb's frames, so it
// never needed the round trip.

import type { Climb, GroupedNotification } from '@boardsesh/shared-schema';

/**
 * Returns null when the row has no frames — there is nothing to draw on the
 * board — and the caller falls back to the climb route.
 *
 * Fields the notification payload doesn't carry (grade, stars, ascents) default
 * the way `tickToClimb` defaults them: the drawer renders the board and the name
 * from these, and fills the rest from its own climb query once open.
 */
export function notificationToClimb(notification: GroupedNotification, angle: number): Climb | null {
  const { climbUuid, climbFrames } = notification;
  if (!climbUuid || !climbFrames) return null;

  return {
    uuid: climbUuid,
    name: notification.climbName ?? climbUuid,
    frames: climbFrames,
    angle,
    ascensionist_count: 0,
    difficulty: '',
    difficulty_error: '',
    quality_average: '0',
    setter_username: notification.setterUsername ?? '',
    stars: 0,
    benchmark_difficulty: null,
    mirrored: false,
    is_no_match: false,
    boardType: notification.boardType ?? undefined,
    layoutId: notification.climbLayoutId ?? undefined,
  };
}
