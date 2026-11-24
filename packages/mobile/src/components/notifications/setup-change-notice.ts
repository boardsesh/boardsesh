// The `board_setup_changed_by_climber` notice's Undo, as data: whether a row
// offers it and what the inbox's handler answers. Its own leaf, so the row can
// read it without pulling the mutation and dialog providers into its graph.

import type { GroupedNotification } from '@boardsesh/shared-schema';

/**
 * How an Undo ended:
 * - `undone`: the old setup is back.
 * - `already_undone`: someone put it back first (another device, another
 *   person the notice went to, an admin). The row reads as undone.
 * - `changed_since`: the board changed again after the climber's change, so
 *   there is nothing to put back.
 * - `not_allowed`: the server no longer lets this viewer undo it (`NOT_FOUND`:
 *   the board moved gyms or went private, or their role at the gym ended).
 * - `cancelled`: the viewer kept the change, or it stopped being live while
 *   the confirm was up.
 *
 * Any other failure (no connection, a server error) throws, and the row says
 * to try again.
 */
export type UndoSetupChangeOutcome = 'undone' | 'already_undone' | 'changed_since' | 'not_allowed' | 'cancelled';

export type UndoSetupChange = (notification: GroupedNotification) => Promise<UndoSetupChangeOutcome>;

/**
 * Whether this notice offers Undo: the climber's change is still on the board.
 * The notice goes to the board's creator and to the gym's owner and admins,
 * each of whom passes the server's undo rule when it is sent, so the row needs
 * no viewer check. A role can end later; the server then answers `NOT_FOUND`
 * and the row says Undo is no longer theirs (`not_allowed`).
 */
export function canUndoSetupChange(notification: Pick<GroupedNotification, 'type' | 'directoryNotice'>): boolean {
  const notice = notification.directoryNotice;
  return (
    notification.type === 'board_setup_changed_by_climber' &&
    !!notice?.setupChangeEventId &&
    notice.setupChangeState === 'LIVE'
  );
}
