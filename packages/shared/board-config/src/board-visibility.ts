import { isReleasedQuantumConfig, QUANTUM_SET_ID } from '@boardsesh/board-constants/quantum';
import type { BoardName } from '@boardsesh/shared-schema';

export const QUANTUM_BOARD_FLAG = 'quantum-board';
export type BoardVisibilityFlags = Readonly<Record<string, unknown>>;
const BOARD_LAUNCH_FLAGS: Partial<Record<BoardName, string>> = { quantum: QUANTUM_BOARD_FLAG };

/** Technical board support is independent of whether its rollout is visible. */
export function isBoardTypeVisible(boardType: unknown, flags: BoardVisibilityFlags = {}): boolean {
  if (typeof boardType !== 'string') return false;
  const normalized = boardType.trim().toLowerCase();
  if (!normalized) return false;
  const launchFlag = BOARD_LAUNCH_FLAGS[normalized as BoardName];
  return launchFlag === undefined || flags[launchFlag] === true;
}

export type BoardVisibilityConfig = ({ boardType: string } | { boardName: string }) & {
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: string | readonly number[] | null;
};

/** Use the full configuration at entry points that can open, select, or create a board. */
export function isBoardConfigVisible(config: BoardVisibilityConfig, flags?: BoardVisibilityFlags): boolean {
  const boardType = 'boardType' in config ? config.boardType : config.boardName;
  if (!isBoardTypeVisible(boardType, flags)) return false;
  if (boardType.trim().toLowerCase() !== 'quantum') return true;
  const { layoutId, sizeId, setIds } = config;
  if (layoutId == null || sizeId == null || !isReleasedQuantumConfig(layoutId, sizeId)) return false;
  if (setIds === undefined) return true;
  return typeof setIds === 'string'
    ? setIds === String(QUANTUM_SET_ID)
    : setIds?.length === 1 && setIds[0] === QUANTUM_SET_ID;
}

/** Launch gates require actual booleans; stale multivariate values never open them. */
export function isBoardLaunchFlag(key: string): boolean {
  return Object.values(BOARD_LAUNCH_FLAGS).includes(key);
}
