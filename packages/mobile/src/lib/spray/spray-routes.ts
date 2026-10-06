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
export function sprayHoldEditorHref(wallUuid: string): string {
  return `${SPRAY_HOLD_EDITOR_PATH}?wallUuid=${encodeURIComponent(wallUuid)}`;
}

/** `/boards/spray/reset?wallUuid=<uuid>`. */
export function sprayResetHref(wallUuid: string): string {
  return `${SPRAY_RESET_PATH}?wallUuid=${encodeURIComponent(wallUuid)}`;
}

/** Accept the old boardUuid spelling for restored navigation and saved links. */
export function readSprayWallUuid(params: {
  wallUuid?: string | string[];
  boardUuid?: string | string[];
}): string | null {
  const wallUuid = params.wallUuid ?? params.boardUuid;
  return typeof wallUuid === 'string' && wallUuid.trim().length > 0 ? wallUuid : null;
}

/**
 * The boards-stack screens that make up the spray flows: adding a wall, editing
 * its holds and resetting it. Each is a full-screen pan-and-pinch surface for
 * part of its life, which is why iPad presents them full screen.
 */
const SPRAY_FLOW_SCREENS: ReadonlySet<string> = new Set(['spray/new', 'spray/holds', 'spray/reset']);

/**
 * The root `boards` route as its options function sees it. `params.screen` is
 * the nested-navigate form a `router.push('/boards/spray/holds?…')` builds;
 * `state` is what a cold deep link or a restored session arrives with instead.
 */
type BoardsRouteLike = {
  params?: object;
  state?: { routes: readonly { name: string }[] };
};

/**
 * Whether the root `boards` modal was opened straight into a spray flow rather
 * than onto the picker.
 *
 * The first screen of a native stack ignores its own `presentation`, so when
 * the live board sheet opens `/boards/spray/holds` the holds screen IS the
 * boards stack's root, and only the root `boards` screen can make it full
 * screen. This reads the ENTRY screen — `params.screen` first, the stack's
 * first route as the fallback — so the answer never changes while the modal is
 * up: a later push inside the stack moves neither. With neither present it
 * answers false and the flow opens as the ordinary card, which still works.
 */
export function opensIntoSprayFlow(route: BoardsRouteLike): boolean {
  const { screen } = (route.params ?? {}) as { screen?: unknown };
  if (typeof screen === 'string') return SPRAY_FLOW_SCREENS.has(screen);
  const entryName = route.state?.routes[0]?.name;
  return entryName != null && SPRAY_FLOW_SCREENS.has(entryName);
}
