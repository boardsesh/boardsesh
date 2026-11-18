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
import type { BoardTransition, BoardTransitionState } from './board-transition';
import { wallSwapDriver, type WallSwapFrame } from './wall-swap';

/** The player's own transition: the shipped wall swap. */
const SHIPPED_DRIVER = wallSwapDriver();

/**
 * A clock, not motion: the dissolve still runs under Reduce Motion. It counts
 * `durationMs` clock milliseconds over `durationMs × slowdown` real ones.
 */
function startClock(clock: SharedValue<number>, durationMs: number, slowdown: number) {
  'worklet';
  clock.value = 0;
  clock.value = withTiming(durationMs, {
    duration: durationMs * slowdown,
    easing: Easing.linear,
    reduceMotion: ReduceMotion.Never,
  });
}

/**
 * The wall swap's three weights and its pair, driven from the pager on the UI
 * thread. Nothing crosses to the JS thread per frame, and nothing runs at rest.
 * `enabled` is false for the wipe; the values then stay at rest.
 *
 * `transition` swaps the step for another (the board motion lab); absent, it is
 * the shipped wall swap at real speed under the system's Reduce Motion. It is
 * read when the reaction is set up: a change of transition should remount.
 */
export function useWallSwap(
  pager: SwipePager,
  centerPage: number,
  enabled: boolean,
  transition?: BoardTransition,
): SharedValue<WallSwapFrame> {
  const { anchorPage, translateX, flingDirection, uiSteps, resetGeneration } = pager;
  const systemReduceMotion = useReduceMotion();
  const reduceMotion = transition?.reduceMotion ?? systemReduceMotion;
  const driver = transition?.driver ?? SHIPPED_DRIVER;
  const requestedSlowdown = transition?.slowdown;
  const slowdown =
    requestedSlowdown !== undefined && Number.isFinite(requestedSlowdown) && requestedSlowdown > 0
      ? requestedSlowdown
      : 1;
  const reduceMotionValue = useSharedValue(reduceMotion);
  useEffect(() => {
    reduceMotionValue.value = reduceMotion;
  }, [reduceMotion, reduceMotionValue]);
  const frame = useSharedValue<WallSwapFrame>([centerPage, 1, 0, 1]);
  const swapClock = useSharedValue(0);
  const settleClock = useSharedValue(0);
  const state = useSharedValue<BoardTransitionState | null>(null);
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
      const step = driver.step(state.value ?? driver.rest(input), input);
      state.value = step.state;
      if (step.startSwapMs !== null) startClock(swapClock, step.startSwapMs, slowdown);
      if (step.startSettleMs !== null) startClock(settleClock, step.startSettleMs, slowdown);
      frame.value = step.frame;
    },
    [enabled, driver, slowdown],
  );
  return frame;
}
