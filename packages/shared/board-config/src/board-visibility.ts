// Which boards and setups a climber is offered. Everything here reads the
// capability table (`launchFlag`, `isConfigReleased` in board-capabilities.ts):
// a board behind a rollout flag is one row there, never a name in this file.
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema/types';
import { getBoardCapabilities, type BoardReleaseConfig } from './board-capabilities';

export type BoardVisibilityFlags = Readonly<Record<string, unknown>>;

const NO_FLAGS: BoardVisibilityFlags = Object.freeze({});
const NO_SET_IDS: readonly number[] = Object.freeze([]);

// Looked up by the normalised board type, as a plain object: a name off
// `Object.prototype` (`constructor`, `__proto__`) finds a non-flag value there
// and stays hidden, as it always has.
const LAUNCH_FLAG_BY_BOARD: Partial<Record<string, string>> = {};
const launchFlagKeys = new Set<string>();
for (const boardName of SUPPORTED_BOARDS) {
  const { launchFlag } = getBoardCapabilities(boardName);
  if (launchFlag === undefined) continue;
  LAUNCH_FLAG_BY_BOARD[boardName] = launchFlag;
  launchFlagKeys.add(launchFlag);
}
const BOARD_LAUNCH_FLAGS: readonly string[] = Object.freeze([...launchFlagKeys]);

function normalizeBoardType(boardType: unknown): string {
  return typeof boardType === 'string' ? boardType.trim().toLowerCase() : '';
}

function isNormalizedBoardTypeVisible(normalizedBoardType: string, flags: BoardVisibilityFlags): boolean {
  if (!normalizedBoardType) return false;
  const launchFlag = LAUNCH_FLAG_BY_BOARD[normalizedBoardType];
  return launchFlag === undefined || flags[launchFlag] === true;
}

/** Technical board support is independent of whether its rollout is visible. */
export function isBoardTypeVisible(boardType: unknown, flags: BoardVisibilityFlags = NO_FLAGS): boolean {
  return isNormalizedBoardTypeVisible(normalizeBoardType(boardType), flags);
}

export type BoardVisibilityConfig = ({ boardType: string } | { boardName: string }) & {
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: string | readonly number[] | null;
};

/**
 * A segment must be the canonical spelling of an integer ("1", not " 1" or
 * "01"); anything else is NaN and matches no set.
 */
function parseSetIdSegment(segment: string): number {
  const setId = Number(segment);
  return String(setId) === segment ? setId : Number.NaN;
}

/** `undefined` names no sets; `null` names an empty set list; a string is the comma-separated wire form. */
function toReleaseSetIds(setIds: BoardVisibilityConfig['setIds']): readonly number[] | undefined {
  if (setIds === undefined) return undefined;
  if (setIds === null) return NO_SET_IDS;
  return typeof setIds === 'string' ? setIds.split(',').map(parseSetIdSegment) : setIds;
}

/**
 * Whether a board's layout / size / sets have shipped, with no rollout flag
 * involved: for the backend, the database and sync, which never see a viewer's
 * flags. A board whose row has no `isConfigReleased` has released every setup.
 */
export function isBoardConfigReleased(boardName: string, config: BoardReleaseConfig): boolean {
  const { isConfigReleased } = getBoardCapabilities(boardName);
  return isConfigReleased === undefined || isConfigReleased(config);
}

/** Use the full configuration at entry points that can open, select, or create a board. */
export function isBoardConfigVisible(config: BoardVisibilityConfig, flags: BoardVisibilityFlags = NO_FLAGS): boolean {
  const normalizedBoardType = normalizeBoardType('boardType' in config ? config.boardType : config.boardName);
  if (!isNormalizedBoardTypeVisible(normalizedBoardType, flags)) return false;
  const { isConfigReleased } = getBoardCapabilities(normalizedBoardType);
  if (isConfigReleased === undefined) return true;
  const { layoutId, sizeId, setIds } = config;
  if (layoutId == null || sizeId == null) return false;
  return isConfigReleased({ layoutId, sizeId, setIds: toReleaseSetIds(setIds) });
}

/** Every board launch flag in the capability table, once each. The same frozen array on every call. */
export function getBoardLaunchFlags(): readonly string[] {
  return BOARD_LAUNCH_FLAGS;
}

/** Launch gates require actual booleans; stale multivariate values never open them. */
export function isBoardLaunchFlag(key: string): boolean {
  return BOARD_LAUNCH_FLAGS.includes(key);
}
