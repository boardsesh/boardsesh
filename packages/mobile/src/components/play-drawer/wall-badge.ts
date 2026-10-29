/**
 * The badge on the board art that says whether the climb on screen is lit on
 * the wall (#6939). The board image draws the same glowing holds either way, so
 * without it a first-timer can't tell a lit climb from a preview.
 *
 * Pure like `wall-state.ts`: which badge, and which top corner it takes, are
 * table-tested here rather than by rendering PlayCore.
 */

import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldPlacement } from '../board-renderer/types';

/**
 * - `onWall` — the climb on screen is the one lit on the board.
 * - `previewNotLit` — solo, looking at another climb while a wall is lit or driven.
 * - `onlyYou` — in a crew, looking at a climb nobody else sees.
 * - `notOnWall` — nothing lights it: no board connected, or the board kept it dark.
 */
export type WallBadgeKind = 'onWall' | 'previewNotLit' | 'onlyYou' | 'notOnWall';

export type WallBadgeResolution = WallBadgeKind | null;

export type WallBadgeInput = {
  isAnonymous: boolean;
  /** A board with lights is selected. False for spray walls and boards flagged ledless. */
  boardHasLights: boolean;
  /** The switch-board overlay covers the board: it says what's wrong itself. */
  boardMismatch: boolean;
  /** The displayed climb needs another board, even when that board is reachable at this gym. */
  climbBoardMismatch: boolean;
  displayedClimbUuid: string | null;
  /** The climber's own committed climb (the queue head), if any. */
  committedHeadUuid: string | null;
  /** The climb physically lit on the board, if any. */
  wallClimbUuid: string | null;
  /** A preview is pinned. */
  isPreview: boolean;
  /** Someone else is in the session. */
  inCrew: boolean;
  /** A wall is genuinely being driven — see `WallPillStateInput.wallDriven`. */
  wallDriven: boolean;
  /**
   * The link is up but the current climb is dark: the #4979 hold kept it off,
   * or its lights were turned off. The presence feed can still name it.
   */
  currentDark: boolean;
  /**
   * The climb the board-presence feed says was turned off and not lit since
   * (#7015): the crewmate driving the wall used Turn off all lights. `null` when
   * no clear was seen. Keyed on the climb, never "the wall is dark", so a queue
   * that moved ahead of the presence echo isn't called dark.
   */
  presenceClearedClimbUuid: string | null;
};

export function resolveWallBadge({
  isAnonymous,
  boardHasLights,
  boardMismatch,
  climbBoardMismatch,
  displayedClimbUuid,
  committedHeadUuid,
  wallClimbUuid,
  isPreview,
  inCrew,
  wallDriven,
  currentDark,
  presenceClearedClimbUuid,
}: WallBadgeInput): WallBadgeResolution {
  if (isAnonymous || !boardHasLights || boardMismatch || displayedClimbUuid === null) return null;
  // A reachable board keeps the drawer and its navigation usable, but this
  // board cannot light that climb. Neither a live link nor a late presence echo
  // makes the retained artwork physically lit after a board switch.
  if (climbBoardMismatch) return 'notOnWall';
  if (currentDark && displayedClimbUuid === committedHeadUuid) return 'notOnWall';
  // A crewmate's phone turned the lights off on this climb. Checked before the
  // driven-wall fall-through below, which would otherwise call it lit.
  if (displayedClimbUuid === presenceClearedClimbUuid && displayedClimbUuid === committedHeadUuid) return 'notOnWall';
  if (displayedClimbUuid === wallClimbUuid) return 'onWall';
  if (isPreview && displayedClimbUuid !== committedHeadUuid) {
    if (inCrew) return 'onlyYou';
    return wallDriven || wallClimbUuid !== null ? 'previewNotLit' : 'notOnWall';
  }
  if (!wallDriven) return 'notOnWall';
  // The climber's own current climb on a driven wall: the link lights whatever
  // is current. The board-presence echo that names the lit climb comes from the
  // server and can lag a swipe or never come at all offline, so waiting for it
  // would flash "Not on the wall" on every step, or claim it over a lit board.
  return 'onWall';
}

export type WallBadgeSide = 'left' | 'right';

export type WallBadgeSideInput = {
  litHoldIds: Iterable<number>;
  holds: readonly HoldPlacement[];
  mirrored: boolean;
  boardWidth: number;
  boardHeight: number;
  /** The badge plus its inset, as fractions of the drawn board's width and height. */
  footprint: { width: number; height: number };
};

/**
 * Which top corner the badge takes: the one the climb's holds leave clear. A hold
 * counts when its circle's bounding box reaches into the badge's box. Fewer
 * holds wins, and a tie (both clear, or both covered as much) goes left, where
 * the eye starts.
 */
export function resolveWallBadgeSide({
  litHoldIds,
  holds,
  mirrored,
  boardWidth,
  boardHeight,
  footprint,
}: WallBadgeSideInput): WallBadgeSide {
  if (boardWidth <= 0 || boardHeight <= 0) return 'left';
  const byId = new Map<number, HoldPlacement>();
  for (const hold of holds) byId.set(hold.id, hold);

  let left = 0;
  let right = 0;
  for (const holdId of litHoldIds) {
    const hold = byId.get(holdId);
    if (!hold) continue;
    // A mirrored climb draws each hold at its mirror's place (useParseFrames).
    const drawn = mirrored && hold.mirroredHoldId != null ? (byId.get(hold.mirroredHoldId) ?? hold) : hold;
    const x = drawn.cx / boardWidth;
    const y = drawn.cy / boardHeight;
    const rx = drawn.r / boardWidth;
    const ry = drawn.r / boardHeight;
    if (y - ry >= footprint.height) continue;
    if (x - rx < footprint.width) left += 1;
    if (x + rx > 1 - footprint.width) right += 1;
  }
  return left <= right ? 'left' : 'right';
}

/** Every hold the climb lights, across all of its frames. */
export function litHoldIdsFromFrames(frames: string, boardName: BoardName): Set<number> {
  const ids = new Set<number>();
  if (!frames) return ids;
  for (const frame of Object.values(convertLitUpHoldsStringToMap(frames, boardName))) {
    for (const holdId of Object.keys(frame)) ids.add(Number(holdId));
  }
  return ids;
}
