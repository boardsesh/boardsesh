import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import {
  ANGLES,
  formatBoardDisplayName,
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  normaliseSetIds,
  parseSetIds,
  toBoardName,
} from '@boardsesh/board-config';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';

/**
 * Boards the setup flow offers, in the order Boardz lists them: the three it was
 * built for, then the other brands Boardsesh carries. Spray walls are private
 * home walls, only reachable from the account that made them.
 */
export const SETUP_BOARD_NAMES = [
  'moonboard',
  'tension',
  'kilter',
  'decoy',
  'grasshopper',
  'soill',
  'touchstone',
  'woods',
] as const satisfies readonly BoardName[];

/** The board the climber is training on right now. */
export type ActiveBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Installed hold sets, sorted ascending. */
  setIds: number[];
  angle: number;
  /** What the climber calls it: their Boardsesh board's name, else the layout. */
  name: string;
  /** The Boardsesh board it came from, so ticks attach to that wall. */
  boardUuid?: string;
};

export function isActiveBoard(value: unknown): value is ActiveBoard {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.boardName === 'string' &&
    toBoardName(candidate.boardName) !== null &&
    typeof candidate.layoutId === 'number' &&
    typeof candidate.sizeId === 'number' &&
    Array.isArray(candidate.setIds) &&
    candidate.setIds.every((setId) => typeof setId === 'number') &&
    typeof candidate.angle === 'number' &&
    typeof candidate.name === 'string' &&
    (candidate.boardUuid === undefined || typeof candidate.boardUuid === 'string')
  );
}

export function layoutName(boardName: BoardName, layoutId: number): string | null {
  return getBoardLayouts(boardName).find((layout) => layout.id === layoutId)?.name ?? null;
}

export function sizeName(boardName: BoardName, layoutId: number, sizeId: number): string | null {
  return getBoardSizesForLayoutId(boardName, layoutId).find((size) => size.id === sizeId)?.name ?? null;
}

export function setNames(board: Pick<ActiveBoard, 'boardName' | 'layoutId' | 'sizeId' | 'setIds'>): string[] {
  return getBoardSetsForLayoutAndSize(board.boardName, board.layoutId, board.sizeId)
    .filter((set) => board.setIds.includes(set.id))
    .map((set) => set.name);
}

/**
 * A new board from the catalogue picks. The name defaults to the layout, which
 * already carries the brand for MoonBoard ("MoonBoard 2016") but not for Aurora
 * layouts ("Original"), so those get the brand in front.
 */
export function createBoard(picks: Omit<ActiveBoard, 'name' | 'boardUuid'>): ActiveBoard {
  const layout = layoutName(picks.boardName, picks.layoutId);
  const brand = formatBoardDisplayName(picks.boardName);
  const name = !layout ? brand : layout.startsWith(brand) ? layout : `${brand} ${layout}`;
  return { ...picks, setIds: [...picks.setIds].sort((first, second) => first - second), name };
}

/** One of the climber's Boardsesh boards, or null when Boardz can't use it. */
export function boardFromAccount(userBoard: UserBoard): ActiveBoard | null {
  const boardName = toBoardName(userBoard.boardType);
  if (!boardName || boardName === 'spray') return null;
  const setIds = parseSetIds(normaliseSetIds(userBoard.setIds));
  if (setIds.length === 0) return null;
  return {
    boardName,
    layoutId: userBoard.layoutId,
    sizeId: userBoard.sizeId,
    setIds,
    angle: userBoard.angle,
    name: userBoard.name,
    boardUuid: userBoard.uuid,
  };
}

/**
 * The board's layout, size and hold sets, for a line under its name. The
 * layout is left out when the name already says it.
 */
export function describeBoard(board: ActiveBoard): string {
  const layout = layoutName(board.boardName, board.layoutId) ?? formatBoardDisplayName(board.boardName);
  const parts: string[] = board.name.includes(layout) ? [] : [layout];
  if (getBoardSizesForLayoutId(board.boardName, board.layoutId).length > 1) {
    const size = sizeName(board.boardName, board.layoutId, board.sizeId);
    if (size) parts.push(size);
  }
  const sets = setNames(board);
  if (sets.length > 0) parts.push(sets.join(', '));
  return parts.join(' · ');
}

export function angleOptions(boardName: BoardName): number[] {
  return ANGLES[boardName];
}

/** The angle a freshly set-up board starts at: 40°, or the nearest angle the board offers. */
export function defaultAngle(boardName: BoardName): number {
  const options = angleOptions(boardName);
  return options.includes(40) ? 40 : (options[options.length - 1] ?? 40);
}

export function toSearchConfig(board: ActiveBoard): BoardSearchConfig {
  return {
    boardName: board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds.join(','),
    angle: board.angle,
  };
}
