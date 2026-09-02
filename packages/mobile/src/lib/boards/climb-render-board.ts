// Which board a single climb should be DRAWN on.
//
// A queue item, a party peer's "spill" climb, or a restored launch snapshot
// carries its own `boardType` + `layoutId` and can outlive the board it came
// from: browse the Homewall, switch the active board to the 12x12, and the
// climb that carries over as `currentClimbQueueItem` still belongs to the
// Homewall. Drawing it against the 12x12's placements matches none of its hold
// ids, so the renderer drops every hold and paints a veil over bare board art
// (#5099).
//
// The rule: the active board keeps the climb whenever it can actually render
// it; otherwise the climb goes back to its OWN board, at its own angle, and the
// caller is told the two boards disagree so it can offer the switch. A climb
// with no board metadata is drawn on the active board exactly as before — we
// can't judge it, and failing closed would blank surfaces that work today.
//
// The size/hold-containment half of that decision already exists for playlist
// rows; this module is the named, board-shaped door onto it.

import { classifyClimbBoardCompatibility, formatBoardDisplayName, toBoardName } from '@boardsesh/board-config';
import { getLayoutName } from '@boardsesh/board-constants/product-sizes';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import {
  getPlaylistRenderBoardTarget,
  resolvePlaylistClimbRenderBoard,
  type ClimbRenderBoardInput,
  type PlaylistClimbRenderBoardFit,
} from '../playlists/playlist-climb-render-board';

/**
 * `'exact'` — drawn on the active board.
 * `'upsized'` — same board model, but the climb needs a bigger size than the
 *   wall the climber is on.
 * `'incompatible'` — a different board model entirely; drawn on its own board.
 */
export type ClimbRenderBoardFit = PlaylistClimbRenderBoardFit;

export type ClimbRenderBoardResult = {
  /** The board to draw this climb on. */
  boardConfig: BoardConfig;
  fit: ClimbRenderBoardFit;
  /** The active board can't render this climb — offer the board switch. */
  incompatible: boolean;
};

/**
 * The climb fields this resolver reads. Structural on purpose so the queue
 * `Climb`, the schema `Climb`, and the thinner board-presence climbs all
 * satisfy it without a cast.
 */
export type ClimbRenderBoardClimb = {
  boardType?: string | null;
  layoutId?: number | null;
  angle?: number | null;
  frames?: string | null;
  compatibleSizeIds?: readonly number[] | null;
};

function drawOnActiveBoard(boardConfig: BoardConfig): ClimbRenderBoardResult {
  return { boardConfig, fit: 'exact', incompatible: false };
}

function toResolverInput(climb: ClimbRenderBoardClimb, fallbackAngle: number): ClimbRenderBoardInput {
  return {
    boardType: climb.boardType ?? undefined,
    layoutId: climb.layoutId,
    frames: climb.frames,
    compatibleSizeIds: climb.compatibleSizeIds,
    // The angle the climb was graded at — that's the angle its own board should
    // be drawn at when it falls back off the active one.
    angle: typeof climb.angle === 'number' ? climb.angle : fallbackAngle,
  };
}

/**
 * Resolve the board a single climb should be rendered on.
 *
 * Returns `null` only when there is nothing to draw on at all: no active board
 * AND no resolvable board of the climb's own.
 */
export function resolveClimbRenderBoard(
  climb: ClimbRenderBoardClimb | null | undefined,
  activeBoardConfig: BoardConfig | null,
): ClimbRenderBoardResult | null {
  if (!climb) return activeBoardConfig ? drawOnActiveBoard(activeBoardConfig) : null;

  if (!activeBoardConfig) {
    const resolved = resolvePlaylistClimbRenderBoard(toResolverInput(climb, 0), null);
    if (!resolved) return null;
    return { boardConfig: resolved.renderBoard, fit: resolved.fit, incompatible: resolved.incompatible };
  }

  const activeBoardName = toBoardName(activeBoardConfig.boardName);
  const identity = activeBoardName
    ? classifyClimbBoardCompatibility(
        { boardName: activeBoardName, layoutId: activeBoardConfig.layoutId },
        { boardType: climb.boardType, layoutId: climb.layoutId },
      )
    : 'unknown';

  // No usable board signal on either side: keep today's behaviour and draw the
  // climb on the active board rather than guessing a board for it.
  if (identity === 'unknown') return drawOnActiveBoard(activeBoardConfig);
  // A climb with no layout can only be placed by GUESSING one — the brand's
  // first layout, via `getDefaultRenderBoard`. That guess can land on exactly
  // the wrong-placement render this resolver exists to prevent, so a missing
  // layout always fails open, even when the brand disagrees with the active
  // board. (With a layout in hand the fallback is the climb's real board.)
  if (climb.layoutId == null) return drawOnActiveBoard(activeBoardConfig);

  const resolved = resolvePlaylistClimbRenderBoard(
    toResolverInput(climb, activeBoardConfig.angle),
    activeBoardConfig,
    getPlaylistRenderBoardTarget(activeBoardConfig),
  );
  // The climb names a board we can't build render data for (an unknown board
  // string, a retired layout). Drawing it on the active board is what happened
  // before this resolver existed, and it beats blanking the surface.
  if (!resolved) return drawOnActiveBoard(activeBoardConfig);

  return { boardConfig: resolved.renderBoard, fit: resolved.fit, incompatible: resolved.incompatible };
}

/**
 * How to name a board in the switch-board prompt.
 *
 * The brand alone ("Kilter") cannot tell the #5099 case apart — Homewall and
 * Original are both Kilter — so prefer the layout's own catalogue name when it
 * already carries the brand ("Kilter Board Homewall"). Layout names that don't
 * ("Original Layout" on Tension) would read as a different product, so those
 * keep the brand. No new strings either way: this is the `{{board}}` value the
 * existing `session.boardMismatch.*` copy interpolates.
 */
export function formatRenderBoardLabel(boardConfig: BoardConfig): string {
  const brand = formatBoardDisplayName(boardConfig.boardName);
  const boardName = toBoardName(boardConfig.boardName);
  const layoutName = boardName ? getLayoutName(boardName, boardConfig.layoutId) : '';
  return layoutName.toLowerCase().includes(brand.toLowerCase()) ? layoutName : brand;
}

/**
 * Same board ART: name, layout, size and hold sets. Angle is deliberately not
 * compared — it tilts the picture, it does not change which holds exist. Used
 * to decide whether a neighbouring climb can be peeked under the board the
 * drawer is currently drawing.
 */
export function sameRenderBoard(left: BoardConfig | null, right: BoardConfig | null): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return (
    left.boardName === right.boardName &&
    left.layoutId === right.layoutId &&
    left.sizeId === right.sizeId &&
    left.setIds === right.setIds
  );
}
