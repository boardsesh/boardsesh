/**
 * The board motion lab's contracts. A variant is one way to change climbs on
 * the player's GPU board; the lab renders it with the real carousel, lets the
 * sliders retune it live, and plays the same scripted swipes for every variant
 * so recordings compare like with like. See docs/board-motion-lab.md.
 */
import type { BoardTransition } from '../play-drawer/board-transition';

/** One slider. Values are plain numbers; the variant decides what they mean. */
export type ParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown after the value, e.g. "ms" or "%". */
  unit?: string;
};

export type ParamValues = Readonly<Record<string, number>>;

export type BoardMotionVariant = {
  /** Stable, kebab-case; used in deep links and clip file names. */
  id: string;
  /** A, B, C… as the variant is named in recordings and when Marco picks. */
  letter: string;
  name: string;
  /** One sentence: what the climber sees. */
  summary: string;
  params: readonly ParamSpec[];
  /** Called on the JS thread whenever a slider settles; the carousel remounts with the result. */
  createTransition(params: ParamValues): BoardTransition;
  /** The native overlay API this variant needs; greyed out with the reason on older binaries. */
  requiresNativeApi?: number;
  /** A native lab shader mode (spike builds only); greyed out when the binary lacks it. */
  requiresNativeLab?: string;
};

/** One beat of a scripted swipe, in clock milliseconds at 1x speed. */
export type FingerBeat =
  /** Finger down at rest. */
  | { kind: 'down'; atMs: number }
  /** Finger moves linearly to `translationX` (board points, left is negative) by `atMs`. */
  | { kind: 'move'; atMs: number; translationX: number }
  /** Finger lifts at `atMs` with this horizontal velocity (points per second). */
  | { kind: 'up'; atMs: number; velocityX: number }
  /** Nothing happens until `atMs`. */
  | { kind: 'wait'; atMs: number };

export type FingerScript = {
  id: string;
  label: string;
  beats: readonly FingerBeat[];
};

/** A board the lab can draw. Same shape as the story fixtures' board config. */
export type LabBoard = {
  /** Stable id used in deep links, e.g. `kilter-homewall`. */
  id: string;
  label: string;
  boardName: import('@boardsesh/shared-schema').BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type LabClimb = { id: string; name: string; frames: string };

/** A named list of climbs on one board, e.g. "Real climbs" or "90% shared holds". */
export type LabClimbSet = { id: string; label: string; climbs: readonly LabClimb[] };

/** What the stage reports about how the board is being drawn. */
export type LabRenderStatus =
  | { path: 'loading' }
  | { path: 'gpu'; apiVersion: number; prepareMs: number | null; uploadMs: number | null }
  | { path: 'png'; apiVersion: number; reason: string };

export type ReduceMotionChoice = 'system' | 'on' | 'off';

/** The board, its swipe and its transition. Owns no controls. */
export type LabStageProps = {
  board: LabBoard;
  climbs: readonly LabClimb[];
  variant: BoardMotionVariant;
  params: ParamValues;
  /** Real milliseconds per clock millisecond: 1, 2 or 4. Scales the transition clocks and the scripted finger. */
  slowdown: number;
  reduceMotion: ReduceMotionChoice;
  /**
   * A scripted swipe to play. A new `runId` starts it, once: the same run is
   * never played again. Null stops any in flight. The board takes no touches
   * while it is set, so clear it when `onScriptDone` reports the run.
   */
  script: { script: FingerScript; runId: number } | null;
  onScriptDone?: (runId: number) => void;
  onStatus: (status: LabRenderStatus) => void;
  /** Index of the climb in the middle, reported whenever it changes. */
  onClimbChange?: (index: number) => void;
  /**
   * A new value puts the board back on the set's first climb (as does a new
   * board or climb set), so every Play-all segment swipes the same climbs.
   */
  resetKey?: number;
};
