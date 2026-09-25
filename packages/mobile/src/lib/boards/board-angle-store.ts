// The angle each board is set to, keyed by board uuid, persisted in unsecure
// AsyncStorage (via preference-store) alongside the active board itself.
//
// Why this exists separately from `UserBoard.angle`: the angle on a board record
// is the value someone typed into a form, or the default the Aurora crawl
// imported. The angle a climber actually tilted the wall to is a property of
// *that wall*, and it has to survive switching away and back. Before this map,
// hopping from the Kilter to the Tension and back re-adopted the Kilter's
// *record* angle and silently dropped the 25° the climber had set on it.
//
// This is also the seam for making the angle authoritative and shared. Today it
// is a local map; when `setBoardAngle` lands server-side and broadcasts over the
// board-presence socket, the mutation and the subscription both write HERE and
// every existing reader updates with no further change. Keep it the only place
// an angle is recorded.

import { getPreference, setPreference } from '../preference-store';

const BOARD_ANGLES_KEY = 'boardsesh_board_angles_v1';

/**
 * Bound on the map so a climber who has visited a lot of gyms doesn't carry an
 * unbounded blob. Oldest entries are dropped first; losing one only means that
 * board re-adopts its record angle, which is what happened before this existed.
 */
const MAX_TRACKED_BOARDS = 50;

/** `boardUuid -> { angle, updatedAt }`. `updatedAt` drives the eviction order. */
type StoredBoardAngles = Record<string, { angle: number; updatedAt: number }>;

async function readAll(): Promise<StoredBoardAngles> {
  return (await getPreference<StoredBoardAngles>(BOARD_ANGLES_KEY)) ?? {};
}

/** The angle this board was last set to on this device, or null if untracked. */
export async function getStoredBoardAngle(boardUuid: string): Promise<number | null> {
  const entry = (await readAll())[boardUuid];
  return entry?.angle ?? null;
}

/**
 * Record the angle a board is now set to. `now` is injected so tests don't
 * depend on the clock; callers pass nothing.
 */
export async function setStoredBoardAngle(boardUuid: string, angle: number, now: number = Date.now()): Promise<void> {
  const angles = await readAll();
  angles[boardUuid] = { angle, updatedAt: now };

  const trackedUuids = Object.keys(angles);
  if (trackedUuids.length > MAX_TRACKED_BOARDS) {
    const oldestFirst = trackedUuids.sort((left, right) => angles[left].updatedAt - angles[right].updatedAt);
    for (const staleUuid of oldestFirst.slice(0, trackedUuids.length - MAX_TRACKED_BOARDS)) {
      delete angles[staleUuid];
    }
  }

  await setPreference(BOARD_ANGLES_KEY, angles);
}

/**
 * The angle to adopt when binding this board: what the climber last set it to,
 * falling back to the board record. A fixed-angle wall always takes the record —
 * there is nothing to remember, and a stale local value would misreport a wall
 * that physically cannot move.
 */
export async function resolveBoardAngle(board: {
  uuid: string;
  angle: number;
  isAngleAdjustable?: boolean | null;
}): Promise<number> {
  if (board.isAngleAdjustable === false) return board.angle;
  return (await getStoredBoardAngle(board.uuid)) ?? board.angle;
}
