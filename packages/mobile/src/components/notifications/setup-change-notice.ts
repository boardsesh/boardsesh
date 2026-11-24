// The `board_setup_changed_by_climber` notice's Undo, as data: whether a row
// offers it and what the inbox's handler answers. Its own leaf, so the row can
// read it without pulling the mutation and dialog providers into its graph.

import type { GroupedNotification } from '@boardsesh/shared-schema';

/**
 * How an Undo ended. `changed_since`: the board changed again after the
 * climber's change (or someone undid it first), so there is nothing to put
 * back. A failure that is not one of these throws.
 */
export type UndoSetupChangeOutcome = 'undone' | 'changed_since' | 'cancelled';

export type UndoSetupChange = (notification: GroupedNotification) => Promise<UndoSetupChangeOutcome>;

/**
 * Whether this notice offers Undo: the climber's change is still on the board.
 * Only the board's creator gets this notice, and the server lets the creator
 * (with the gym's staff and admins) undo it, so the row needs no viewer check.
 */
export function canUndoSetupChange(notification: Pick<GroupedNotification, 'type' | 'directoryNotice'>): boolean {
  const notice = notification.directoryNotice;
  return (
    notification.type === 'board_setup_changed_by_climber' &&
    !!notice?.setupChangeEventId &&
    notice.setupChangeState === 'LIVE'
  );
}
