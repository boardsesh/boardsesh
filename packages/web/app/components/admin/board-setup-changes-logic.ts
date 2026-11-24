import { isBoardSetupAlreadyUndoneError, isBoardSetupChangedSinceError } from '@boardsesh/graphql/errors';
import type { BoardSetupChange } from '@boardsesh/shared-schema';

/**
 * The admin's "Setup changes by climbers" tab at `/admin/board-reports`, as
 * plain data (docs/product/directory-reports.md, "Undo"): which tab the URL
 * opens, which change can be undone, where its links go, and what an undo
 * came to.
 */

/** The page's two tabs: the report queue, and climbers' setup changes. */
export type BoardReportsTab = 'reports' | 'setup-changes';

/** `?tab=setup-changes` opens the climbers' setup changes; anything else the report queue. */
export function readBoardReportsTab(value: string | string[] | undefined | null): BoardReportsTab {
  return value === 'setup-changes' ? 'setup-changes' : 'reports';
}

/**
 * The page's URL once `tab` is picked, for `router.replace`: `?tab=setup-changes`
 * for the setup changes, no `tab` for the report queue (the default). Every other
 * parameter (the digest's `?report=`) stays.
 */
export function boardReportsTabHref(pathname: string, search: string, tab: BoardReportsTab): string {
  const params = new URLSearchParams(search);
  if (tab === 'reports') params.delete('tab');
  else params.set('tab', tab);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Changes per page; the server's default too. */
export const SETUP_CHANGES_PAGE_SIZE = 50;

/** Only a change the board still has can be put back. */
export function canUndoSetupChange(change: Pick<BoardSetupChange, 'state'>): boolean {
  return change.state === 'LIVE';
}

/**
 * What an Undo came to, for the message after it:
 * - `undone`: the old setup is back.
 * - `already_undone`: someone put it back first (`BOARD_SETUP_ALREADY_UNDONE`).
 * - `changed_since`: the board changed again, so it can't be put back
 *   (`BOARD_SETUP_CHANGED_SINCE`).
 * - `failed`: anything else; nothing changed.
 *
 * The rows themselves come from the server: the panel reads the first page
 * again after every outcome, so each change shows the state it has now.
 */
export type SetupUndoOutcome = 'undone' | 'already_undone' | 'changed_since' | 'failed';

export function setupUndoOutcome(outcome: { ok: true } | { ok: false; error: unknown }): SetupUndoOutcome {
  if (outcome.ok) return 'undone';
  if (isBoardSetupAlreadyUndoneError(outcome.error)) return 'already_undone';
  if (isBoardSetupChangedSinceError(outcome.error)) return 'changed_since';
  return 'failed';
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
