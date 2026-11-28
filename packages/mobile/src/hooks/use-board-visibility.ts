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
 * The bit a launch flag holds in the enabled mask, by its position in the list.
 * At most 31 flags fit; board-visibility.test.ts in @boardsesh/board-config fails
 * when a 32nd is added.
 */
function launchFlagBit(flagIndex: number): number {
  return 1 << flagIndex;
}

/**
 * One bit per board launch flag that reads an explicit `true`. A number rather
 * than an object, so the callbacks below keep their identity until a launch flag
 * flips and nothing is built per render.
 */
function useEnabledLaunchFlagBits(): number {
  let enabledBits = 0;
  // A hook in a loop is safe here: BOARD_LAUNCH_FLAGS is a frozen module-level
  // array, so the number and order of calls never change between renders, and
  // useFeatureFlag is only a context read.
  for (let flagIndex = 0; flagIndex < BOARD_LAUNCH_FLAGS.length; flagIndex += 1) {
    if (useFeatureFlag(BOARD_LAUNCH_FLAGS[flagIndex]) === true) enabledBits |= launchFlagBit(flagIndex);
  }
  return enabledBits;
}

/** The flag bag the enabled mask stands for. Takes the list so a test can pass several flags. */
export function launchFlagsFromBits(launchFlags: readonly string[], enabledBits: number): BoardVisibilityFlags {
  const visibilityFlags: Record<string, boolean> = {};
  launchFlags.forEach((launchFlag, flagIndex) => {
    visibilityFlags[launchFlag] = (enabledBits & launchFlagBit(flagIndex)) !== 0;
  });
  return visibilityFlags;
}

/** Rollout policy belongs at the catalogue boundary, never in board rows or renderers. */
export function useIsBoardTypeVisible() {
  const enabledBits = useEnabledLaunchFlagBits();
  return useMemo(() => {
    const launchFlags = launchFlagsFromBits(BOARD_LAUNCH_FLAGS, enabledBits);
    return (boardType: string) => isBoardTypeVisible(boardType, launchFlags);
  }, [enabledBits]);
}

export function useIsBoardConfigVisible() {
  const enabledBits = useEnabledLaunchFlagBits();
  return useMemo(() => {
    const launchFlags = launchFlagsFromBits(BOARD_LAUNCH_FLAGS, enabledBits);
    return (config: BoardVisibilityConfig) => isBoardConfigVisible(config, launchFlags);
  }, [enabledBits]);
}
