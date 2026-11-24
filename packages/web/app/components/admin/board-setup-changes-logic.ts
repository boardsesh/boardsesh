import { isBoardSetupChangedSinceError } from '@boardsesh/graphql/errors';
import type { BoardSetupChange, BoardSetupChangeState } from '@boardsesh/shared-schema';

/**
 * The admin's "Setup changes by climbers" tab at `/admin/board-reports`, as
 * plain data (docs/product/directory-reports.md, "Undo"): which change can be
 * undone, where its links go, and what a row reads after an undo.
 */

/** Changes per page; the server's default too. */
export const SETUP_CHANGES_PAGE_SIZE = 50;

/** Only a change the board still has can be put back. */
export function canUndoSetupChange(change: Pick<BoardSetupChange, 'state'>): boolean {
  return change.state === 'LIVE';
}

/**
 * What a row reads after Undo: `UNDONE` when it went through, `CHANGED_SINCE`
 * when the server refused it because the board changed again (or someone undid
 * it first, which the server reports the same way), null for any other
 * failure, which leaves the row as it was.
 */
export function stateAfterUndo(outcome: { ok: true } | { ok: false; error: unknown }): BoardSetupChangeState | null {
  if (outcome.ok) return 'UNDONE';
  return isBoardSetupChangedSinceError(outcome.error) ? 'CHANGED_SINCE' : null;
}

/** The list with one change's state replaced; the other rows are kept as they are. */
export function withChangeState(
  changes: readonly BoardSetupChange[],
  eventId: string,
  state: BoardSetupChangeState,
): BoardSetupChange[] {
  return changes.map((change) => (change.eventId === eventId ? { ...change, state } : change));
}

/** A page appended to the list, skipping any change already in it (a change made between two reads). */
export function appendSetupChanges(
  current: readonly BoardSetupChange[],
  page: readonly BoardSetupChange[],
): BoardSetupChange[] {
  const seen = new Set(current.map((change) => change.eventId));
  return [...current, ...page.filter((change) => !seen.has(change.eventId))];
}

/** The board's page: `/b/{slug}` lands on its climb list. */
export function setupChangeBoardHref(board: BoardSetupChange['board']): string {
  return `/b/${encodeURIComponent(board.slug)}`;
}

/** The gym's page, by slug, or by uuid for a legacy gym without one. */
export function setupChangeGymHref(gym: NonNullable<BoardSetupChange['gym']>): string {
  return `/gym/${encodeURIComponent(gym.slug ?? gym.uuid)}`;
}
