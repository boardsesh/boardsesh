// The builder's "already has" sheet (#8151, PR 3): which shelf each wall goes
// on and what its near-miss line says. The refusal names the walls that block
// the save (same setup, or the same layout and size with other sets); the
// candidates query adds the walls on another layout or size, which never block
// but are often the same wall entered wrong (a seeded 2016 record for a gym's
// Masters 2019). Pure, so the order and the lines are a table in the tests.

import type { UserBoard, WallMatchKind } from '@boardsesh/shared-schema';
import {
  boardSetupLabelParts,
  classifyWallMatch,
  diffWallSetIds,
  getBoardSetsForLayoutAndSize,
  toBoardName,
  type WallSetup,
} from '@boardsesh/board-config';

/**
 * The sheet's shelves, in the order they are drawn: the climber's exact wall
 * first, then walls that differ only in hold sets, then walls on another layout
 * or size ("Possible setup mismatch").
 */
export type ExistingWallShelfKey = 'same_setup' | 'set_up_differently' | 'setup_mismatch';

export const EXISTING_WALL_SHELF_ORDER: readonly ExistingWallShelfKey[] = [
  'same_setup',
  'set_up_differently',
  'setup_mismatch',
];

/** How a near-miss wall differs from the climber's setup, in catalogue words. */
export type WallDifference =
  | { kind: 'layout'; wall: string; yours: string }
  | { kind: 'size'; wall: string; yours: string }
  /** `missing`: sets the climber has that the wall lacks. `extra`: the reverse. */
  | { kind: 'sets'; missing: string[]; extra: string[] };

export type ExistingWall = {
  board: UserBoard;
  shelf: ExistingWallShelfKey;
  /** Null on the same-setup shelf, and when the catalogue can't name the difference. */
  difference: WallDifference | null;
};

export type ExistingWallShelf = { key: ExistingWallShelfKey; walls: ExistingWall[] };

function wallSetupOf(board: Pick<UserBoard, 'boardType' | 'layoutId' | 'sizeId' | 'setIds'>): WallSetup {
  return { boardType: board.boardType, layoutId: board.layoutId, sizeId: board.sizeId, setIds: board.setIds };
}

function shelfForMatch(matchKind: WallMatchKind | null): ExistingWallShelfKey | null {
  switch (matchKind) {
    case 'EXACT':
      return 'same_setup';
    case 'SETS_DIFFER':
      return 'set_up_differently';
    case 'LAYOUT_OR_SIZE_DIFFERS':
      return 'setup_mismatch';
    case null:
      return null;
  }
}

/** Set names for ids on one layout and size, in catalogue order; ids it doesn't list are left out. */
function setNames(boardType: string, layoutId: number, sizeId: number, setIds: readonly number[]): string[] {
  const boardName = toBoardName(boardType);
  if (boardName === null || setIds.length === 0) return [];
  const wanted = new Set(setIds);
  return getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId)
    .filter((set) => wanted.has(set.id))
    .map((set) => set.name.trim())
    .filter((name) => name.length > 0);
}

/**
 * What separates a wall from the climber's draft: its layout ("2016 layout.
 * Yours: Masters 2019"), its size, or its hold sets ("Missing Screw-on Feet").
 * Null when they are the same setup, of different board types, or the
 * catalogue can't name the part that differs.
 */
export function describeWallDifference(draft: WallSetup, wall: WallSetup): WallDifference | null {
  const matchKind = classifyWallMatch(draft, wall);
  if (matchKind === null || matchKind === 'EXACT') return null;
  if (matchKind === 'SETS_DIFFER') {
    const { missingSetIds, extraSetIds } = diffWallSetIds(draft, wall);
    const missing = setNames(draft.boardType, draft.layoutId, draft.sizeId, missingSetIds);
    const extra = setNames(wall.boardType, wall.layoutId, wall.sizeId, extraSetIds);
    return missing.length > 0 || extra.length > 0 ? { kind: 'sets', missing, extra } : null;
  }
  const draftParts = boardSetupLabelParts(draft.boardType, draft);
  const wallParts = boardSetupLabelParts(wall.boardType, wall);
  if (draft.layoutId !== wall.layoutId) {
    return draftParts.layout && wallParts.layout
      ? { kind: 'layout', wall: wallParts.layout, yours: draftParts.layout }
      : null;
  }
  return draftParts.size && wallParts.size ? { kind: 'size', wall: wallParts.size, yours: draftParts.size } : null;
}

/**
 * The sheet's walls on their shelves, empty shelves left out.
 *
 * - `named`: the walls the refusal named, as looked up, with the server's
 *   match kind. The climber's draft decides the shelf when it can (it is what
 *   the server compared), the server's kind when it can't. A named wall is
 *   never left out: one neither side can place goes on Set up differently, so
 *   the climber is asked about it rather than acknowledging it unseen.
 * - `mismatch`: walls on another layout or size from the candidates query.
 *   A wall already named is never drawn twice.
 *
 * Inside a shelf the order given is kept: the refusal's order, then the
 * query's rank (`compareWallCandidates`).
 */
export function arrangeExistingWalls(
  draft: WallSetup,
  named: readonly { board: UserBoard; matchKind: WallMatchKind | null }[],
  mismatch: readonly UserBoard[],
): ExistingWallShelf[] {
  const byShelf = new Map<ExistingWallShelfKey, ExistingWall[]>();
  const seen = new Set<string>();
  const place = (board: UserBoard, fallback: WallMatchKind | null, unplaced: ExistingWallShelfKey | null) => {
    if (seen.has(board.uuid)) return;
    const wallSetup = wallSetupOf(board);
    const shelf = shelfForMatch(classifyWallMatch(draft, wallSetup) ?? fallback) ?? unplaced;
    if (shelf === null) return;
    seen.add(board.uuid);
    const wall: ExistingWall = {
      board,
      shelf,
      difference: shelf === 'same_setup' ? null : describeWallDifference(draft, wallSetup),
    };
    const walls = byShelf.get(shelf);
    if (walls) walls.push(wall);
    else byShelf.set(shelf, [wall]);
  };
  for (const { board, matchKind } of named) place(board, matchKind, 'set_up_differently');
  // Another board type is never the same wall, so the query's leave it out.
  for (const board of mismatch) place(board, null, null);
  return EXISTING_WALL_SHELF_ORDER.flatMap((key) => {
    const walls = byShelf.get(key);
    return walls ? [{ key, walls }] : [];
  });
}

/** The words a difference line needs, resolved by the screen (this module can't translate). */
export type WallDifferenceCopy = {
  layout: (wall: string, yours: string) => string;
  size: (wall: string, yours: string) => string;
  missing: (sets: string) => string;
  extra: (sets: string) => string;
};

/**
 * The near-miss line under a wall's name: "2016 layout. Yours: Masters 2019",
 * "Missing Screw-on Feet", "Missing Hold Set B. Also has Screw-on Feet".
 */
export function wallDifferenceLine(difference: WallDifference, copy: WallDifferenceCopy): string {
  switch (difference.kind) {
    case 'layout':
      return copy.layout(difference.wall, difference.yours);
    case 'size':
      return copy.size(difference.wall, difference.yours);
    case 'sets':
      return [
        difference.missing.length > 0 ? copy.missing(difference.missing.join(', ')) : null,
        difference.extra.length > 0 ? copy.extra(difference.extra.join(', ')) : null,
      ]
        .filter((line): line is string => line !== null)
        .join('. ');
  }
}
