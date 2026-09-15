// The two wall-maintenance routes, named once.
//
// Neither screen exists on this branch: the hold editor is SW-08 (#5441) and the
// "new photo" reset flow is SW-13 (#5446), both in flight on their own branches.
// Naming the paths here rather than inlining two string literals in
// `BoardDetailSheet` is what lets this slice ship the owner's front door now and
// lets those slices land their screens at a path that is already spelled the same
// way in one place — a literal typed twice is a literal that drifts.
//
// The wall is addressed by its `user_boards` uuid, not its layout id: that is the
// handle every other board route already carries (`/boards/edit?boardUuid=…`), it
// is what the spray API's `sprayWall(boardUuid:)` takes, and it survives a reset
// unchanged.

/** The hold editor for one wall: add, move, resize and delete its holds (SW-08). */
export const SPRAY_HOLD_EDITOR_PATH = '/boards/spray/holds';

/** Photograph the wall again after a reset and review what moved (SW-13). */
export const SPRAY_RESET_PATH = '/boards/spray/reset';

/** `/boards/spray/holds?boardUuid=<uuid>`. */
export function sprayHoldEditorHref(boardUuid: string): string {
  return `${SPRAY_HOLD_EDITOR_PATH}?boardUuid=${encodeURIComponent(boardUuid)}`;
}

/** `/boards/spray/reset?boardUuid=<uuid>`. */
export function sprayResetHref(boardUuid: string): string {
  return `${SPRAY_RESET_PATH}?boardUuid=${encodeURIComponent(boardUuid)}`;
}
