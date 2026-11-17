import { useEffect } from 'react';
import {
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import type { SwipePager } from './use-swipe-pager';
import {
  stepWallSwap,
  swapClockMs,
  WALL_SWAP,
  wallSwapPagePosition,
  wallSwapRest,
  type WallSwapState,
} from './wall-swap';

/**
 * One frame of the swap: the pair on show (the nearest page is the climb being
 * left; see `wall-swap`), then the outgoing-only and incoming-only weights. One
 * value, so the native view never applies a new pair with old weights.
 */
export type WallSwapFrame = readonly [pagePosition: number, outgoingWeight: number, incomingWeight: number];

/** A clock, not motion: the dissolve still runs under Reduce Motion. */
function startClock(clock: SharedValue<number>, durationMs: number) {
  'worklet';
  clock.value = 0;
  clock.value = withTiming(durationMs, {
    duration: durationMs,
    easing: Easing.linear,
    reduceMotion: ReduceMotion.Never,
  });
}

/**
 * The wall swap's two weights and its pair, driven from the pager on the UI
 * thread. Nothing crosses to the JS thread per frame, and nothing runs at rest.
 * `enabled` is false for the wipe; the values then stay at rest.
 */
export function useWallSwap(pager: SwipePager, centerPage: number, enabled: boolean): SharedValue<WallSwapFrame> {
  const { anchorPage, translateX, flingDirection, uiSteps, resetGeneration } = pager;
  const reduceMotion = useReduceMotion();
  const reduceMotionValue = useSharedValue(reduceMotion);
  useEffect(() => {
    reduceMotionValue.value = reduceMotion;
  }, [reduceMotion, reduceMotionValue]);
  const frame = useSharedValue<WallSwapFrame>([centerPage, 1, 0]);
  const swapClock = useSharedValue(0);
  const settleClock = useSharedValue(0);
  const state = useSharedValue<WallSwapState | null>(null);
  useAnimatedReaction(
    () =>
      enabled
        ? {
            anchor: anchorPage.value,
            offset: translateX.value,
            fling: flingDirection.value,
            steps: uiSteps.value,
            reset: resetGeneration.value,
            swapMs: swapClock.value,
            settleMs: settleClock.value,
            reduceMotion: reduceMotionValue.value,
            commitDistance: SWIPE_THRESHOLD,
          }
        : null,
    (input) => {
      if (input === null) return;
      const step = stepWallSwap(state.value ?? wallSwapRest(input.anchor, input), input);
      state.value = step.state;
      if (step.startSwap) startClock(swapClock, swapClockMs(step.state));
      if (step.startSettle) startClock(settleClock, WALL_SWAP.settleMs);
      frame.value = [wallSwapPagePosition(step.state), step.state.outgoing, step.state.incoming];
    },
    [enabled],
  );
  return frame;
}
