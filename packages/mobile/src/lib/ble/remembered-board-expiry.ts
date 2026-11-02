// How long a hang-up keeps the board remembered (plan item 2, 2026-11).
//
// A short tap on a lit bulb hangs up at once, with no confirm and no Undo
// (docs/board-connection-holder.md). Before this, a hang-up also forgot the
// board, so the tap that undoes a slip opened the board picker. Now the
// hang-up stamps the remembered board with `forgetAfter`, and the board counts
// as forgotten only once that time has passed. Pure helpers, kept apart from the
// stores so the stores' mocks don't have to restate them.

import type { StoredLastConnectedBoard } from './last-connected-board-store';

/** How long a hang-up keeps the board remembered: a mistaken tap reconnects with one more tap. */
export const HANG_UP_REMEMBER_MS = 10 * 60 * 1000;

/** True once a hang-up's `forgetAfter` stamp has passed: the board counts as forgotten. */
export function isRememberedBoardExpired(board: StoredLastConnectedBoard, nowMs: number): boolean {
  return board.forgetAfter !== undefined && nowMs >= board.forgetAfter;
}

/** A stamp is a finite number or absent; anything else makes the stored record unusable. */
export function hasValidForgetAfter(candidate: Record<string, unknown>): boolean {
  return (
    candidate.forgetAfter === undefined ||
    (typeof candidate.forgetAfter === 'number' && Number.isFinite(candidate.forgetAfter))
  );
}

/** The earliest `forgetAfter` among these boards, or null when none is stamped. */
export function soonestForgetAfter(boards: ReadonlyArray<StoredLastConnectedBoard | null>): number | null {
  let soonest: number | null = null;
  for (const board of boards) {
    if (board?.forgetAfter === undefined) continue;
    if (soonest === null || board.forgetAfter < soonest) soonest = board.forgetAfter;
  }
  return soonest;
}
