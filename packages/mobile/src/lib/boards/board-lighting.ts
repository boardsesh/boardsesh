/**
 * How a board's climbs reach the wall, from the three fields that decide it.
 *
 * Optional-field contract: a missing `hasLeds` reads as "has LEDs" and a
 * missing `litByWallDevice` reads as "no wall device", so a stale snapshot or a
 * query that omitted a field never takes Bluetooth away from an LED wall.
 *
 * Two questions, kept apart on purpose:
 *
 * - {@link drivesWithoutBluetooth}: does this phone put climbs up by taking the
 *   wall (`takeVirtualWall`) instead of connecting? True for a wall with no
 *   light kit and for one lit by an internet-connected wall device (a laser
 *   projector, or an LED controller that follows the board feed). The take
 *   reports every climb through `reportBoardClimb`, which is the feed the
 *   device reads.
 * - {@link boardHasLights}: does anything on the wall light up? False only for
 *   a wall with no light kit and no wall device. Copy that says "this wall has
 *   no lights" and the player's wall button ask this one.
 *
 * A live Bluetooth link still wins over both: `derivePlayDrawerLightbulbPressAction`
 * returns `disconnect` while connected, and `commitWallFrames` writes the radio
 * first.
 */
export type BoardLightingSource = {
  boardType?: string | null;
  hasLeds?: boolean | null;
  litByWallDevice?: boolean | null;
};

/** The board says it has no LED light kit. Spray walls are always created this way. */
function flaggedNoLightKit(board: BoardLightingSource): boolean {
  return board.hasLeds === false;
}

/** Climbs reach the wall over the internet: the owner turned on "Lit by a wall device". */
export function litByWallDevice(board: BoardLightingSource | null | undefined): boolean {
  return board?.litByWallDevice === true;
}

/** This phone takes the wall instead of connecting over Bluetooth. */
export function drivesWithoutBluetooth(board: BoardLightingSource | null | undefined): boolean {
  if (!board) return false;
  return flaggedNoLightKit(board) || litByWallDevice(board);
}

/**
 * Something on the wall lights up: an LED kit (Bluetooth or a wall device) or a
 * projector. Spray walls light up only with a wall device.
 */
export function boardHasLights(board: BoardLightingSource | null | undefined): boolean {
  if (!board) return true;
  if (litByWallDevice(board)) return true;
  return board.boardType !== 'spray' && !flaggedNoLightKit(board);
}
