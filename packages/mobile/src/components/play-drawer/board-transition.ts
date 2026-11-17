/**
 * How the player's stationary GPU board hands its lit holds from one climb to
 * the next, as a value the carousel can be given. Absent, the carousel runs the
 * player's own: its swap look where the binary draws it (`player-swap-look.ts`),
 * else the shipped wall swap (`wall-swap.ts`), at real speed. The board motion
 * lab (`src/components/board-motion-lab/`) passes its own to compare
 * alternatives.
 */
import type { ClimbOverlayGPUReady } from '../../../modules/climb-overlay-gpu/src';
import type { BoardSwapFrame, SwapLook, SwapLookStatus } from './swap-look';
import type { RevealMode, WallSwapInput } from './wall-swap';

/** What a transition sees each UI frame: the pager plus its own two clocks. */
export type BoardTransitionInput = WallSwapInput;

/** A transition's private state, kept on the UI thread between frames. */
export type BoardTransitionState = Readonly<Record<string, number | boolean>>;

export type BoardTransitionStep = {
  state: BoardTransitionState;
  /** What the native view draws this frame: six numbers only for a transition with a `look`. */
  frame: BoardSwapFrame;
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
  /**
   * Swap mode only: the native swap look its driver's six-number frames are
   * drawn with (`swap-look.ts`). Never sent to a binary below
   * `SWAP_LOOK_NATIVE_VERSION`, and drawn off natively under Reduce Motion;
   * absent, API 7's swap.
   */
  look?: SwapLook;
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
  /** The native swap look's state, when it changes (look variants on a binary with the look). */
  onSwapLook?: (status: SwapLookStatus) => void;
};
