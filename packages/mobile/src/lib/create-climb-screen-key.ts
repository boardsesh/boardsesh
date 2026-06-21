import type { BoardName } from '@boardsesh/shared-schema';

type CreateClimbKeyBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/**
 * React `key` for the mounted CreateClimbScreen.
 *
 * Keyed on the edited climb (so switching drafts remounts with a fresh undo
 * history) AND on the board's hold-identity tuple (boardName/layoutId/sizeId/
 * setIds). The hook seeds its holds reducer once at mount and never re-sanitizes
 * the painted holds when the board changes, so a board switch under a bare-open
 * create screen (active-board fallback) must remount to drop holds that don't
 * exist on the new layout/size and to re-run the per-board draft restore.
 *
 * `angle` is deliberately EXCLUDED: WebSocket session sync updates the active
 * board's angle, and an angle-only remount would wipe an in-progress paint.
 * Angle does not affect which holds are valid.
 */
export function createClimbScreenKey(editClimbUuid: string | undefined, board: CreateClimbKeyBoard): string {
  return `${editClimbUuid ?? 'new'}:${board.boardName}:${board.layoutId}:${board.sizeId}:${board.setIds}`;
}
