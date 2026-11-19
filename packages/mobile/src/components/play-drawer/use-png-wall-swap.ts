import { useEffect } from 'react';
import { useAnimatedReaction, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import type { BoardTransition } from './board-transition';
import { pngBareWallUsable, pngSwapLayers, type PngSwapLayers } from './png-swap-layers';
import type { SwipePager } from './use-swipe-pager';
import { useStationaryMotionFlag } from './use-stationary-motion-flag';
import { useWallSwap } from './use-wall-swap';

/**
 * The PNG board's still-wall swap (`png-swap-layers.ts`): the GPU board's swap
 * weights (`useWallSwap`, the shipped driver unless the board motion lab passes
 * its own) turned into the opacities of the boards and the bare wall, on the
 * UI thread. Nothing crosses to the JS thread per frame.
 *
 * `bareWallReady` is true while the bare wall has painted its veil. The boards
 * only go see-through once it has, and only from rest, so a bare wall that
 * paints mid-drag never makes the board jump: until then the swap dissolves,
 * as under Reduce Motion. One that stops being ready (the app went to the
 * background, the board changed) is dropped at once.
 *
 * `enabled` is false on the slide; the pager's still-wall flag is then left alone.
 */
export function usePngWallSwap(
  pager: SwipePager,
  centerPage: number,
  enabled: boolean,
  transition: BoardTransition | undefined,
  bareWallReady: SharedValue<boolean>,
): SharedValue<PngSwapLayers> {
  useStationaryMotionFlag(pager, enabled);
  const frame = useWallSwap(pager, centerPage, enabled, transition);
  const systemReduceMotion = useReduceMotion();
  const reduceMotion = transition?.reduceMotion ?? systemReduceMotion;
  const reduceMotionValue = useSharedValue(reduceMotion);
  useEffect(() => {
    reduceMotionValue.value = reduceMotion;
  }, [reduceMotion, reduceMotionValue]);
  const bareWallUsable = useSharedValue(false);
  useAnimatedReaction(
    () => pngBareWallUsable(bareWallReady.value, bareWallUsable.value, frame.value),
    (usable) => {
      if (bareWallUsable.value !== usable) bareWallUsable.value = usable;
    },
  );
  const { anchorPage } = pager;
  return useDerivedValue(() =>
    pngSwapLayers(frame.value, reduceMotionValue.value || !bareWallUsable.value, anchorPage.value),
  );
}
