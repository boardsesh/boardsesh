import { useMemo } from 'react';
import {
  getBoardLaunchFlags,
  isBoardConfigVisible,
  isBoardTypeVisible,
  type BoardVisibilityConfig,
  type BoardVisibilityFlags,
} from '@boardsesh/board-config/visibility';
import { useFeatureFlag } from '../providers/feature-flags-provider';

const BOARD_LAUNCH_FLAGS = getBoardLaunchFlags();

/**
 * One bit per board launch flag that reads an explicit `true`. A number rather
 * than an object, so the callbacks below keep their identity until a launch flag
 * flips and nothing is built per render. `BOARD_LAUNCH_FLAGS` is fixed at module
 * load, so the hook is called the same number of times on every render (and the
 * 32 bits outnumber the launch flags any release will hold at once).
 */
function useEnabledLaunchFlagBits(): number {
  let enabledBits = 0;
  for (let flagIndex = 0; flagIndex < BOARD_LAUNCH_FLAGS.length; flagIndex += 1) {
    if (useFeatureFlag(BOARD_LAUNCH_FLAGS[flagIndex]) === true) enabledBits |= 1 << flagIndex;
  }
  return enabledBits;
}

function launchFlagsFromBits(enabledBits: number): BoardVisibilityFlags {
  const launchFlags: Record<string, boolean> = {};
  BOARD_LAUNCH_FLAGS.forEach((launchFlag, flagIndex) => {
    launchFlags[launchFlag] = (enabledBits & (1 << flagIndex)) !== 0;
  });
  return launchFlags;
}

/** Rollout policy belongs at the catalogue boundary, never in board rows or renderers. */
export function useIsBoardTypeVisible() {
  const enabledBits = useEnabledLaunchFlagBits();
  return useMemo(() => {
    const launchFlags = launchFlagsFromBits(enabledBits);
    return (boardType: string) => isBoardTypeVisible(boardType, launchFlags);
  }, [enabledBits]);
}

export function useIsBoardConfigVisible() {
  const enabledBits = useEnabledLaunchFlagBits();
  return useMemo(() => {
    const launchFlags = launchFlagsFromBits(enabledBits);
    return (config: BoardVisibilityConfig) => isBoardConfigVisible(config, launchFlags);
  }, [enabledBits]);
}
