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
import type { BoardTransition, BoardTransitionDriver, BoardTransitionState } from './board-transition';
import type { BoardSwapFrame } from './swap-look';
import { wallSwapDriver } from './wall-swap';

/** The shipped wall swap: the driver a transition without one runs. */
const SHIPPED_DRIVER = wallSwapDriver();

/** A number per driver, so a reaction can tell its own state from another driver's. */
const DRIVER_SERIALS = new WeakMap<BoardTransitionDriver, number>();
let lastDriverSerial = 0;

function driverSerialOf(driver: BoardTransitionDriver): number {
  const known = DRIVER_SERIALS.get(driver);
  if (known !== undefined) return known;
  lastDriverSerial += 1;
  DRIVER_SERIALS.set(driver, lastDriverSerial);
  return lastDriverSerial;
}

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
 * `enabled` is false for the wipe; the frame then rests on the pager's page,
 * and switched back on the swap starts from rest there.
 *
 * `transition` swaps the step for another (the player's swap look, or the board
 * motion lab's); absent, it is the shipped wall swap at real speed under the
 * system's Reduce Motion. A new driver (the player's look switched on or off by
 * its kill switch or Reduce Motion) starts from rest on the climb the pager is
 * on: one driver's state means nothing to another.
 */
export function useWallSwap(
  pager: SwipePager,
  centerPage: number,
  enabled: boolean,
  transition?: BoardTransition,
): SharedValue<BoardSwapFrame> {
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
  const frame = useSharedValue<BoardSwapFrame>([centerPage, 1, 0, 1]);
  const swapClock = useSharedValue(0);
  const settleClock = useSharedValue(0);
  const state = useSharedValue<BoardTransitionState | null>(null);
  // The serial of the driver that wrote `state`, written only when it changes.
  const stateDriver = useSharedValue(0);
  const driverSerial = driverSerialOf(driver);
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
        : anchorPage.value,
    (input) => {
      // Switched off, the pager goes on without it: steps it never saw would
      // read as a commit once it is back on (the PNG board's still wall goes
      // off and on while mounted: playback, a GPU hand-over, its kill switch).
      // Forget the state so it starts from rest wherever the pager then is, and
      // keep the frame at rest on the pager's page, so a board that reads it
      // before this runs again never shows a page the pager has left. The GPU
      // board reads no frame outside the swap (`GpuClimbOverlay`).
      if (typeof input === 'number') {
        if (state.value !== null) state.value = null;
        const shown = frame.value;
        if (shown.length !== 4 || shown[0] !== input || shown[1] !== 1 || shown[2] !== 0 || shown[3] !== 1) {
          frame.value = [input, 1, 0, 1];
        }
        return;
      }
      const previous = state.value !== null && stateDriver.value === driverSerial ? state.value : driver.rest(input);
      const step = driver.step(previous, input);
      state.value = step.state;
      if (stateDriver.value !== driverSerial) stateDriver.value = driverSerial;
      if (step.startSwapMs !== null) startClock(swapClock, step.startSwapMs, slowdown);
      if (step.startSettleMs !== null) startClock(settleClock, step.startSettleMs, slowdown);
      frame.value = step.frame;
    },
    [enabled, driver, driverSerial, slowdown],
  );
  return frame;
}
