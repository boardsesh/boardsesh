// The two wall-maintenance routes, named once.
//
// Both routes are opened from the live board sheet. Keep their names and wall
// parameter together so the action helpers and route readers cannot drift.
//
// The wall is addressed by its `user_boards` uuid, not its layout id: that is the
// handle every other board route already carries (`/boards/edit?boardUuid=…`), it
// is what the spray API's `sprayWall(boardUuid:)` takes, and it survives a reset
// unchanged.

/** The hold editor for one wall: add, move, resize and delete its holds (SW-08). */
export const SPRAY_HOLD_EDITOR_PATH = '/boards/spray/holds';

/** Photograph the wall again after a reset and review what moved (SW-13). */
export const SPRAY_RESET_PATH = '/boards/spray/reset';

/** `/boards/spray/holds?wallUuid=<uuid>`. */
export function sprayHoldEditorHref(boardUuid: string): string {
  return `${SPRAY_HOLD_EDITOR_PATH}?wallUuid=${encodeURIComponent(boardUuid)}`;
}

/** `/boards/spray/reset?wallUuid=<uuid>`. */
export function sprayResetHref(boardUuid: string): string {
  return `${SPRAY_RESET_PATH}?wallUuid=${encodeURIComponent(boardUuid)}`;
}

/** Accept the old boardUuid spelling for restored navigation and saved links. */
export function readSprayWallUuid(params: {
  wallUuid?: string | string[];
  boardUuid?: string | string[];
}): string | null {
  const wallUuid = params.wallUuid ?? params.boardUuid;
  return typeof wallUuid === 'string' && wallUuid.trim().length > 0 ? wallUuid : null;
}
