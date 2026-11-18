/**
 * How the player's stationary GPU board hands its lit holds from one climb to
 * the next, as a value the carousel can be given. Absent, the carousel runs the
 * shipped wall swap (`wall-swap.ts`) at real speed. The board motion lab
 * (`src/components/board-motion-lab/`) passes its own to compare alternatives.
 */
import type { ClimbOverlayGPUReady } from '../../../modules/climb-overlay-gpu/src';
import type { RevealMode, WallSwapFrame, WallSwapInput } from './wall-swap';

/** What a transition sees each UI frame: the pager plus its own two clocks. */
export type BoardTransitionInput = WallSwapInput;

/** A transition's private state, kept on the UI thread between frames. */
export type BoardTransitionState = Readonly<Record<string, number | boolean>>;

export type BoardTransitionStep = {
  state: BoardTransitionState;
  /** What the native view draws this frame. */
  frame: WallSwapFrame;
  /** Restart the swap clock from 0, to run this many milliseconds; null leaves it alone. */
  startSwapMs: number | null;
  /** Restart the settle clock from 0, to run this many milliseconds; null leaves it alone. */
  startSettleMs: number | null;
};

export type BoardTransitionDriver = {
  /** Worklet. One climb on its own, as first seen. */
  rest(input: BoardTransitionInput): BoardTransitionState;
  /** Worklet. One UI frame. */
  step(previous: BoardTransitionState, input: BoardTransitionInput): BoardTransitionStep;
};

export type BoardTransition = {
  revealMode: RevealMode;
  /** Swap mode only. Absent: the shipped wall swap. */
  driver?: BoardTransitionDriver;
  /** Real milliseconds per clock millisecond (4 = quarter speed). 1 when absent. */
  slowdown?: number;
  /**
   * Reduce Motion as the transition sees it (the swap's `input.reduceMotion`,
   * and the wipe's freeze); absent, the system setting. iOS still freezes the
   * native wipe while the system setting is on, whatever this says.
   */
  reduceMotion?: boolean;
};

/**
 * What the board tells the board motion lab's status line. Nothing in
 * production passes one. Called on the JS thread, a few times per climb, never
 * per frame.
 */
export type BoardRenderDiagnostics = {
  /** The stationary GPU board (`gpu`) or the PNG strip (`png`) is drawing the climbs. */
  onRenderPath: (path: 'gpu' | 'png') => void;
  /** The GPU board presented the climbs it was given, with the native timings. */
  onGpuReady: (ready: ClimbOverlayGPUReady) => void;
  /** The GPU board gave up on the climbs it was given; the native reason. */
  onGpuError: (reason: string) => void;
};
