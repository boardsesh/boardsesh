// The wall-maintenance routes, named once.
//
// Opened from the live board sheet. Keep their names and wall parameter
// together so the action helpers and route readers cannot drift.
//
// The wall is addressed by its `user_boards` uuid, not its layout id: that is the
// handle every other board route already carries (`/boards/edit?boardUuid=…`), it
// is what the spray API's `sprayWall(boardUuid:)` takes, and it survives a reset
// unchanged.

/** The hold editor for one wall: add, move, resize and delete its holds (SW-08). */
export const SPRAY_HOLD_EDITOR_PATH = '/boards/spray/holds';

/** The add-a-wall wizard. With `resetOf`, it builds the reset clone of that wall. */
export const SPRAY_NEW_WALL_PATH = '/boards/spray/new';

/** `/boards/spray/holds?wallUuid=<uuid>`. */
export function sprayHoldEditorHref(wallUuid: string): string {
  return `${SPRAY_HOLD_EDITOR_PATH}?wallUuid=${encodeURIComponent(wallUuid)}`;
}

/** Where the owner confirmed a reset. Telemetry only; mirrors `SprayResetSurface`. */
export type SprayResetSource = 'board_sheet' | 'holds_locked';

/**
 * `/boards/spray/new?resetOf=<uuid>`: reset a wall by building its replacement in
 * the wizard. `source` rides along for the one `Spray Wall Reset Started` event
 * the wizard fires when the reset really starts.
 */
export function sprayResetWizardHref(wallUuid: string, source?: SprayResetSource): string {
  const base = `${SPRAY_NEW_WALL_PATH}?resetOf=${encodeURIComponent(wallUuid)}`;
  return source ? `${base}&resetSource=${source}` : base;
}

/** The reset source a route param names, or undefined for anything else. */
export function readSprayResetSource(param: string | string[] | undefined): SprayResetSource | undefined {
  return param === 'board_sheet' || param === 'holds_locked' ? param : undefined;
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
 * The boards-stack screens that make up the spray flows: adding (or resetting)
 * a wall and editing its holds. Each is a full-screen pan-and-pinch surface for
 * part of its life, which is why iPad presents them full screen.
 */
const SPRAY_FLOW_SCREENS: ReadonlySet<string> = new Set(['spray/new', 'spray/holds']);

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
