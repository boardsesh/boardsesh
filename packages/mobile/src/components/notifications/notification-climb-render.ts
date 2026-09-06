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

// The board behind a (boardType, layout, sizes) key is static, so the resolved
// config never changes. The FIFO cap just bounds memory; the real key space
// (board x layout x size-set) sits far below it, so it effectively never evicts.
const BOARD_CONFIG_CACHE_LIMIT = 64;
const boardConfigCache = new Map<string, PlaylistBoardConfig | null>();

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
 * (docs/board-art-geometry.md).
 *
 * That helper deliberately skips the memo its sibling has, on the stated
 * assumption that it is "called once per resolve rather than once per row" —
 * and this IS a per-row caller, twice over (the list's `getItemType` and the
 * row itself). So the memo lives here, keyed on the four fields the resolution
 * reads. The perf playbook's rule is that per-row work reads a pre-built index
 * rather than scanning; `resolveRenderBoard` runs a sizes filter and a
 * biggest-size reduce, which is exactly the scan that rule is about.
 */
export function notificationClimbRender(notification: GroupedNotification): NotificationClimbRender | null {
  const { climbFrames, boardType, climbLayoutId, climbCompatibleSizeIds } = notification;
  // Layout is required, not optional. `getBoardConfigForClimb` tolerates a
  // missing one and falls back to the layout default — which on a board whose
  // sizes number holds independently draws a DIFFERENT climb rather than
  // failing. The resolver sets frames and layout together, so this can only
  // fire on a malformed payload; better a plain avatar than the wrong holds.
  if (!climbFrames || !boardType || climbLayoutId == null) return null;

  const cacheKey = `${boardType}|${climbLayoutId}|${climbCompatibleSizeIds?.join(',') ?? ''}`;
  let boardConfig = boardConfigCache.get(cacheKey);
  if (boardConfig === undefined) {
    boardConfig = getBoardConfigForClimb(boardType, climbLayoutId, climbCompatibleSizeIds);
    if (boardConfigCache.size >= BOARD_CONFIG_CACHE_LIMIT) {
      const oldestKey = boardConfigCache.keys().next().value;
      if (oldestKey !== undefined) boardConfigCache.delete(oldestKey);
    }
    boardConfigCache.set(cacheKey, boardConfig);
  }

  return boardConfig ? { frames: climbFrames, boardConfig } : null;
}
