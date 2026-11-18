/**
 * The swap look: a way to give each hold its own timing and glow during the
 * wall swap. Native code (`swapLookVersion` 2, iOS and Android) turns the swap's per-side weights
 * into per-hold weights with a front, a glow-only ghost, a mark that trails its
 * glow and a glow reach that swells, focuses or tightens
 * (`ClimbOverlaySwapLook.swift`, `OverlaySwapLook.kt`). The player draws `PLAYER_SWAP_LOOK`
 * (`player-swap-look.ts`) where the binary has it; the board motion lab draws
 * any look. Older binaries advertise version 0, ignore the look and draw the
 * shipped swap.
 *
 * Pure and worklet-safe.
 */
import type { SharedValue } from 'react-native-reanimated';
import type { WallSwapFrame } from './wall-swap';

/** The native swap look this app speaks. A binary below it gets no look and four-number frames. */
export const SWAP_LOOK_NATIVE_VERSION = 2;

/** First number of the encoded look, so a binary can reject a layout it does not know. */
const SWAP_LOOK_FORMAT = 2;

/**
 * Every number of a look. "Progress" is a side's weight scaled to its stage:
 * above the floor (floor to 1) or below it (0 to floor).
 */
export type SwapLook = {
  /** Above the floor, each hold changes over this share of the progress; 1 moves every hold together. */
  readonly holdWindow: number;
  /** The same below the floor. */
  readonly lowWindow: number;
  /** A leaving climb's stages meet here (the drag's dim): every hold is at it when its side is. */
  readonly floor: number;
  /**
   * The same for an arriving climb. Equal to `floor` it moves like a leaving one; 0 lights it in
   * one front from dark to whole; with ghosts, where the ghosts end and the marks begin.
   */
  readonly arrivalFloor: number;
  /** An arriving climb lights bottom to top within its own holds instead of from the swipe edge. */
  readonly climbUp: boolean;
  /** 0 to 0.5: mixes each hold's order toward a hash of its id, for a ragged run. */
  readonly jitter: number;
  /** An arriving climb below the floor shows glow only, up to this glow; 0 turns ghosts off. */
  readonly ghost: number;
  /** 0 to 1: a hold's mark trails its glow (mark × mix(1, weight, markLag)). */
  readonly markLag: number;
  /** An arriving hold's glow reach swells by up to this much as it lights (0 to 0.35). */
  readonly swell: number;
  /** How long the swell settles, as a share of the arriving climb's progress above the floor. */
  readonly swellTail: number;
  /** An arriving hold's reach is 1 + focus × (1 − weight)^focusShape: wide and soft while faint. */
  readonly focus: number;
  /** 2 pulls the halo in early; 0.5 keeps it wide until the hold is nearly whole. */
  readonly focusShape: number;
  /** A leaving hold's reach is 1 − tighten × (1 − weight): it pulls in as it fades. */
  readonly tighten: number;
  /** The swell grows with a hold's order: with climb-up order, the top of the climb swells most. */
  readonly topBoost: number;
};

/** No front, no ghost, no reach change: the per-side weights as API 7 draws them. */
export const PLAIN_SWAP_LOOK: SwapLook = {
  holdWindow: 1,
  lowWindow: 1,
  floor: 0.4,
  arrivalFloor: 0.4,
  climbUp: false,
  jitter: 0,
  ghost: 0,
  markLag: 0,
  swell: 0,
  swellTail: 0,
  focus: 0,
  focusShape: 2,
  tighten: 0,
  topBoost: 0,
};

/** The `swapLook` prop, in `ClimbOverlaySwapLook.Look`'s order. */
export function encodeSwapLook(look: SwapLook): readonly number[] {
  return [
    SWAP_LOOK_FORMAT,
    look.holdWindow,
    look.lowWindow,
    look.floor,
    look.arrivalFloor,
    look.climbUp ? 1 : 0,
    look.jitter,
    look.ghost,
    look.markLag,
    look.swell,
    look.swellTail,
    look.focus,
    look.focusShape,
    look.tighten,
    look.topBoost,
  ];
}

/**
 * What the native view says about the look (`onSwapLookState`), only when it
 * changes: off and why, ready (valid, not drawn yet), or drawn with its hold
 * count. `reachOff` says why glow reach is pinned at 1 while it draws.
 */
export type SwapLookStatus =
  | { state: 'off'; reason: string }
  | { state: 'ready'; reachOff?: string }
  | { state: 'on'; holds: number; reachOff?: string };

/**
 * A swap frame under a look: the pair and the two side weights as in
 * `WallSwapFrame`, then the floor below which shared holds never go (the
 * native look gives each shared hold the brighter of the two fronts at its
 * spot), then the arrival code of the climb being left and of the arriving
 * one: 0 leaving, 1 arriving from the right edge, 2 from the left, plus 4 for a
 * flick run's calm arrival (no swell). A climb's code only changes while its
 * weight is 0 or 1 (`swap-look-driver.ts`).
 */
export type SwapLookFrame = readonly [
  pagePosition: number,
  outgoingWeight: number,
  incomingWeight: number,
  sharedFloor: number,
  outgoingArrives: number,
  incomingArrives: number,
];

/** What a board transition hands the native view each frame. */
export type BoardSwapFrame = WallSwapFrame | SwapLookFrame;

/** A frame source: the player's own (always four numbers) or a board transition's. */
export type SwapFrameSource = SharedValue<WallSwapFrame> | SharedValue<BoardSwapFrame>;

/**
 * The frame for a binary without the look: the shipped four numbers, with the
 * shared weight the shipped swap would give (the brighter side, never below
 * the look's shared floor).
 */
export function shippedSwapFrame(frame: BoardSwapFrame): WallSwapFrame {
  'worklet';
  if (frame.length === 4) return frame;
  const brighter = frame[1] > frame[2] ? frame[1] : frame[2];
  const shared = brighter > frame[3] ? brighter : frame[3];
  return [frame[0], frame[1], frame[2], shared < 1 ? shared : 1];
}
