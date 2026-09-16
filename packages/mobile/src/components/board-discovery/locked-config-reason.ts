// WHY the board edit form's config rows are locked — not just whether.
//
// The two reasons are unrelated and the copy for one is wrong for the other.
// Telling a wall's own owner "you don't have permission to change this board's
// layout, size, or hold sets" is false twice over: they have every permission
// there is, and there is no layout to change — a wall's configuration IS its
// photograph. Boolean `lockedConfig` could not say that, so it said the only
// thing it knew.

import { toBoardName } from '@boardsesh/board-config';

export type LockedConfigReason =
  /** The viewer may not change this board at all. The server's `canEdit` answer. */
  | 'permission'
  /** A spray wall: its layout row was created when the wall was photographed. */
  | 'spray';

/** The board fields the rule reads. Structural so a partial board works uncast. */
export type LockedConfigBoard = {
  boardType: string;
  canEdit?: boolean;
};

/**
 * Why this board's config rows are locked, or `null` when they are not.
 *
 * Permission is checked FIRST, and that order is the decision: on a wall the
 * viewer may not edit, both reasons hold, but only one of them is actionable.
 * "Shoot the wall again" is advice for the owner; for everyone else the true and
 * useful sentence is that this is not their board to change.
 *
 * `canEdit` is optional on `UserBoard` — a partial board built from an offline
 * snapshot carries no answer — and "unknown" reads as locked, the same way the
 * form has always read it.
 */
export function lockedConfigReason(board: LockedConfigBoard): LockedConfigReason | null {
  if (board.canEdit !== true) return 'permission';
  if (toBoardName(board.boardType) === 'spray') return 'spray';
  return null;
}
