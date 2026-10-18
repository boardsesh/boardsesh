import { accumulateFramesToMaps, parseFramesSegments } from '@boardsesh/board-constants/hold-states';
import { MOONBOARD_GRID, convertLitUpHoldsMapToMoonBoardHolds, holdIdToCoordinate } from '@boardsesh/board-config';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';

/** The roles a climber uses, in the order the board's screen-reader summary reads them. */
export const ACTIVE_HOLD_ROLES = ['STARTING', 'HAND', 'FINISH', 'FOOT'] as const;
export type ActiveHoldRole = (typeof ACTIVE_HOLD_ROLES)[number];

export type ActiveHoldsGroup = {
  role: ActiveHoldRole;
  count: number;
  /** Wall coordinates in climbing order (bottom to top, left to right), or null on a board without them. */
  labels: readonly string[] | null;
};

export type ActiveHoldsSummary = {
  /** One group per role that has holds, in `ACTIVE_HOLD_ROLES` order. */
  groups: readonly ActiveHoldsGroup[];
  /** True when the board has coordinates printed on the wall, so every group carries labels. */
  hasLabels: boolean;
};

function isActiveHoldRole(state: HoldState): state is ActiveHoldRole {
  return (ACTIVE_HOLD_ROLES as readonly HoldState[]).includes(state);
}

/**
 * The holds lit in the first snapshot of a frames string: what the board paints
 * for a static climb, and all of a playback frame (those come comma-free).
 * Later frames of a route are left out, so delta ghosts are never counted.
 */
function firstSnapshotHolds(boardName: BoardName, frames: string): LitUpHoldsMap {
  const firstSnapshot = parseFramesSegments(frames)[0]?.body ?? '';
  return accumulateFramesToMaps(firstSnapshot, boardName)[0] ?? {};
}

/** The holds on MoonBoard's 11 × 18 grid; an id past it has no coordinate a climber could find. */
function onMoonBoardGrid(holds: LitUpHoldsMap): LitUpHoldsMap {
  const lastHoldId = MOONBOARD_GRID.numColumns * MOONBOARD_GRID.numRows;
  return Object.fromEntries(
    Object.entries(holds).filter(([holdIdKey]) => {
      const holdId = Number(holdIdKey);
      return Number.isInteger(holdId) && holdId >= 1 && holdId <= lastHoldId;
    }),
  );
}

/**
 * MoonBoard coordinates per role. Saved MoonBoard climbs carry start, hand and
 * finish only; a foot hold comes from our ESP32 firmware's live preview (code
 * 45), and is labelled the same way so the line still matches the board.
 */
function moonBoardLabelsByRole(holds: LitUpHoldsMap): Record<ActiveHoldRole, readonly string[]> {
  const { start, hand, finish } = convertLitUpHoldsMapToMoonBoardHolds(holds);
  const foot = Object.entries(holds)
    .filter(([, hold]) => hold.state === 'FOOT')
    .map(([holdIdKey]) => Number(holdIdKey))
    .sort((leftId, rightId) => leftId - rightId)
    .map(holdIdToCoordinate);
  return { STARTING: start, HAND: hand, FINISH: finish, FOOT: foot };
}

/**
 * The climb's holds by role, for the player's Active holds section. MoonBoard
 * has coordinates printed on the wall, so its groups list them (`B5`). Every
 * other board (Kilter, Tension and the other Aurora boards, Woods, spray walls)
 * has no coordinates a climber can find on the wall, so its groups carry only
 * a count. MoonBoard never mirrors (`boardSupportsMirroring`), and counts are
 * the same either way round, so the summary needs no orientation.
 *
 * Grouping is by role, not by code: Kilter's Tycho colour codes (36–41) and
 * MoonBoard's live-preview hand colours (47, 48) all decode as HAND and count
 * as one Hand group on purpose, the same way the board's screen-reader summary
 * counts them. Unknown role codes (the `{holdId}={code}` sentinel), AUX and
 * OFF are left out, and so is a MoonBoard hold off the 11 × 18 grid.
 *
 * Counts come from the frames, not from the wall: a spray climb whose wall has
 * since lost a hold still counts it, while the board draws one hold fewer.
 */
export function summarizeActiveHolds(boardName: BoardName, frames: string): ActiveHoldsSummary {
  const hasLabels = boardName === 'moonboard';
  const snapshot = firstSnapshotHolds(boardName, frames);
  const holds = hasLabels ? onMoonBoardGrid(snapshot) : snapshot;
  const countsByRole: Record<ActiveHoldRole, number> = { STARTING: 0, HAND: 0, FINISH: 0, FOOT: 0 };
  for (const hold of Object.values(holds)) {
    if (isActiveHoldRole(hold.state)) countsByRole[hold.state] += 1;
  }
  const labelsByRole = hasLabels ? moonBoardLabelsByRole(holds) : null;
  const groups = ACTIVE_HOLD_ROLES.filter((role) => countsByRole[role] > 0).map((role) => ({
    role,
    count: countsByRole[role],
    labels: labelsByRole ? labelsByRole[role] : null,
  }));
  return { groups, hasLabels };
}
