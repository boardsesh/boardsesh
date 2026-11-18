import { useDifferentiateWithoutColor } from '../../hooks/use-differentiate-without-color';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import {
  climbOverlayGpuApiVersion,
  climbOverlaySwapCommandApi,
  climbOverlaySwapLookVersion,
} from '../../lib/board-render/gpu-native-capability';
import { usePlayerSwapLookEnabled } from '../../providers/feature-flags-provider';
import type { BoardTransition } from './board-transition';
import { playerBoardTransition } from './player-swap-look';

/**
 * The player's board transition (`player-swap-look.ts`): the swap look on a
 * binary that draws it, unless `player-swap-look-kill`, Reduce Motion or
 * Differentiate Without Color is on; undefined, the shipped wall swap,
 * otherwise. The returned value only changes when one of those does, never per
 * frame.
 */
export function usePlayerBoardTransition(): BoardTransition | undefined {
  const enabled = usePlayerSwapLookEnabled();
  const reduceMotion = useReduceMotion();
  const differentiateWithoutColor = useDifferentiateWithoutColor() === 'on';
  return playerBoardTransition({
    apiVersion: climbOverlayGpuApiVersion,
    swapCommandApi: climbOverlaySwapCommandApi,
    swapLookVersion: climbOverlaySwapLookVersion,
    killed: !enabled,
    reduceMotion,
    differentiateWithoutColor,
  });
}
