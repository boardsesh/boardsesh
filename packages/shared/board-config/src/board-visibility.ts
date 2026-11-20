import type { BoardName } from '@boardsesh/shared-schema';

export const QUANTUM_BOARD_FLAG = 'quantum-board';
export type BoardVisibilityFlags = Readonly<Record<string, unknown>>;
const BOARD_LAUNCH_FLAGS: Partial<Record<BoardName, string>> = { quantum: QUANTUM_BOARD_FLAG };

/** Technical board support is independent of whether its rollout is visible. */
export function isBoardTypeVisible(boardType: string, flags: BoardVisibilityFlags = {}): boolean {
  const launchFlag = BOARD_LAUNCH_FLAGS[boardType as BoardName];
  return launchFlag === undefined || flags[launchFlag] === true;
}

/** Launch gates require actual booleans; stale multivariate values never open them. */
export function isBoardLaunchFlag(key: string): boolean {
  return Object.values(BOARD_LAUNCH_FLAGS).includes(key);
}
