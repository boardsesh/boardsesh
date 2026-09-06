// Whether a notification row can draw board art, and on which board.
//
// A standalone leaf, like `notification-copy.ts` beside it: no React, no theme,
// no renderer. That is load-bearing rather than tidiness — the list's
// `getItemType` must call this outside a component, and the screen's test would
// otherwise drag the whole theme chain (PlatformColor, ios-colors) in behind it.

import type { GroupedNotification } from '@boardsesh/shared-schema';
import { getBoardConfigForClimb, type PlaylistBoardConfig } from '../../lib/playlists/board-details-for-playlist';

/** Everything needed to draw a row's board art, or null when the row isn't about a climb. */
export type NotificationClimbRender = { frames: string; boardConfig: PlaylistBoardConfig };

/**
 * The board art a notification row can draw, if any — a new climb, a proposal,
 * or a comment or like on an ascent (the resolver walks the tick to its climb
 * for those).
 *
 * Returns null whenever the payload can't produce a render: a row that isn't
 * about a climb, or a backend deploy that predates `climbFrames`. The row then
 * keeps its avatar, which is deliberate — a blank tile in a list reads as
 * broken, a missing one reads as "this row just isn't about a climb".
 *
 * `getBoardConfigForClimb` rather than the playlist variant because
 * `compatibleSizeIds` picks the size: Woods numbers holds independently per
 * size, so the layout default renders a completely different climb
 * (docs/board-art-geometry.md). It is sync and memoised, so this costs a lookup
 * per row, not a query.
 */
export function notificationClimbRender(notification: GroupedNotification): NotificationClimbRender | null {
  const { climbFrames, boardType, climbLayoutId, climbCompatibleSizeIds } = notification;
  // Layout is required, not optional. `getBoardConfigForClimb` tolerates a
  // missing one and falls back to the layout default — which on a board whose
  // sizes number holds independently draws a DIFFERENT climb rather than
  // failing. The resolver sets frames and layout together, so this can only
  // fire on a malformed payload; better a plain avatar than the wrong holds.
  if (!climbFrames || !boardType || climbLayoutId == null) return null;
  const boardConfig = getBoardConfigForClimb(boardType, climbLayoutId, climbCompatibleSizeIds);
  return boardConfig ? { frames: climbFrames, boardConfig } : null;
}
