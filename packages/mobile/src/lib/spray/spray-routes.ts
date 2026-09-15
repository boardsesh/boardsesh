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

/**
 * Whether the board-detail sheet renders the two wall rows at all.
 *
 * **False until both screens exist.** Neither path below resolves on this stack:
 * SW-08's editor and SW-13's reset flow are built on a different branch, and
 * `app/boards/spray/holds.tsx` has not been created by anybody yet. Expo Router
 * sends a miss to `+not-found`, which redirects a prefix-less path to Home — so
 * an owner tapping "Edit holds" today would be dumped on the Home tab with no
 * explanation. A row that lands somewhere wrong is worse than no row.
 *
 * The gate itself (`sprayDetailRows`) ships now and is tested now, because it is
 * the part with a rule in it. Flipping this constant is one line of the
 * follow-up, #5491, which adds the routes and a test that they resolve.
 */
export const SPRAY_DETAIL_ROWS_ENABLED = false;

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
