/**
 * The wall swap: how the player's stationary GPU board hands its lit holds from
 * one climb to the next during a swipe.
 *
 * On a binary that draws the native swap look (`swapLookVersion` 2), the
 * player runs this state machine with its own numbers and a per-hold look on
 * top (`player-swap-look.ts`: a 220 ms swap, the next climb as halos while
 * dragging, standby rings on the old one). The base swap described below runs
 * on older binaries, when the look is disabled and under Reduce Motion.
 * The look keeps its rules for cancels, re-flicks, reversals and pull-backs.
 *
 * Between the climb being left and the one arriving, every hold is one of three
 * kinds. Shared holds are lit with the same role in both. Outgoing-only holds
 * are lit only in the old climb, or show a changed hold's old role.
 * Incoming-only holds are lit only in the new climb, or show its new role. The
 * native compositor sorts the holds; this module decides the weight of each
 * kind, every frame, on the UI thread, so the timing can change over the air.
 *
 * - Dragging dims outgoing-only holds from 100% to 40% as the board travels to
 *   the pager's commit distance (`SWIPE_THRESHOLD`), and keeps them at 40% past
 *   it. Nothing arrives yet, and position on the wall plays no part.
 * - Letting go short of that follows the pager's spring back to 100%.
 * - A commit starts a 200 ms swap on its own clock, whatever the pager does:
 *   outgoing-only holds fade to nothing over 0-120 ms (ease-in), incoming-only
 *   holds fade in over 60-200 ms (ease-out). Incoming-only holds never appear
 *   while outgoing-only ones are above 40%: a flick that commits before the
 *   board has dimmed waits for the fade to reach 40% before the new holds start.
 * - Catching the board mid-swap does not stop the swap. Pulling it back toward
 *   the climb being left (4 points or more past where it was caught) fades from
 *   the weights on screen to what the finger asks for, with no jump.
 * - A commit onward during a swap, a caught board flicked onward included, ends
 *   the running swap at once and swaps from the climb it skips: that climb starts
 *   at 40%, or at its weight on screen if that is higher, so it never flashes
 *   whole and is never brightened past 40%. Shared holds follow as always.
 *   The limit: the climb the first swap was leaving goes dark in that one frame,
 *   by its weight then (40% or less after a drag to the commit distance, up to
 *   about 80% after a short flick). The native view only has the climbs either
 *   side of the pager's centre prepared, and the centre moves on within 40-110
 *   ms of the commit; an older pair kept on screen would then show the skipped
 *   climb whole.
 * - A commit that reverses a running swap (it leaves the swap's arriving climb
 *   and heads back to its leaving one) starts from the weights on screen: the
 *   same pair named the other way round, so the first frame after it shows the
 *   same pixels as the frame before. Incoming-only holds that the reversal
 *   relabels as lit wait at their weight until the outgoing-only ones are down
 *   to 40%. If the swap is still in its lead-in, the climb it heads back to is
 *   the one the lead-in is easing to: the lead-in carries on from the screen
 *   and the swap's arriving climb, never shown, stays dark.
 * - A commit whose pair is not the one on screen (pulled back toward one climb,
 *   then flicked toward the other) first eases that pair to its leaving climb,
 *   whole, over 120 ms, and only then swaps: changing pairs any earlier would
 *   change which holds count as outgoing-only in one frame.
 * - Shared holds dip with the rest and never go dark: they follow whichever of
 *   the other two kinds is brighter, never below 40% (`wallSwapSharedWeight`).
 *   Dragging takes them down with the outgoing-only holds; a swap holds them at
 *   40% until the incoming-only holds pass it, then brings them back with them.
 * - Reduce Motion: no dim while dragging, shared holds stay fully lit, and
 *   both sides fade together over a 240 ms linear dissolve. Lead-ins and
 *   pull-back settles use the same linear timing.
 *
 * The native view is told which pair it is showing through its page position:
 * the nearest page is the climb being left, and the side the position leans to
 * holds the arriving one. Pure and worklet-safe; `use-wall-swap` drives it.
 */

import type { BoardTransitionDriver, BoardTransitionState, BoardTransitionStep } from './board-transition';

/** How the stationary board changes climbs. The wipe follows the page position. */
export type RevealMode = 'wipe' | 'swap';

/** The native overlay API that understands the swap's weights. */
export const WALL_SWAP_NATIVE_API = 6;

/**
 * The native overlay API that weights shared holds from the swap frame's fourth
 * number. API 6 draws them fully lit, and rejects any frame that is not exactly
 * three numbers.
 */
export const WALL_SWAP_SHARED_NATIVE_API = 7;

/** The player's reveal. A "reveal style" setting can choose another over the air. */
export const PLAYER_REVEAL_MODE: RevealMode = 'swap';

/**
 * The player's reveal on this binary: older native builds only know the wipe.
 * `preferred` is the reveal asked for (the board motion lab asks for either);
 * the wipe is always there, the swap only from `WALL_SWAP_NATIVE_API`.
 */
export function playerRevealMode(apiVersion: number, preferred: RevealMode = PLAYER_REVEAL_MODE): RevealMode {
  return apiVersion >= WALL_SWAP_NATIVE_API ? preferred : 'wipe';
}

/** A cubic-bezier's control points as CSS writes them: x1, y1, x2, y2. The ends are fixed at 0,0 and 1,1. */
export type BezierControls = readonly [x1: number, y1: number, x2: number, y2: number];

/**
 * Every number the wall swap runs on. Production runs `WALL_SWAP`; the board
 * motion lab (`src/components/board-motion-lab/`) hands `wallSwapDriver` its own.
 *
 * Every worklet here takes it as a required argument, never `= WALL_SWAP`: the
 * worklets plugin evaluates a default parameter before it binds the closure, so
 * a defaulted `WALL_SWAP` would throw on the UI thread.
 */
export type WallSwapTuning = {
  readonly dimFloor: number;
  readonly durationMs: number;
  readonly outgoingEndMs: number;
  readonly incomingStartMs: number;
  readonly reduceMotionDurationMs: number;
  readonly settleMs: number;
  readonly leadInMs: number;
  readonly pullBackPoints: number;
  readonly pairLean: number;
  /** The outgoing fade's curve. */
  readonly easeIn: BezierControls;
  /** The incoming fade's, the lead-in's and the settle's curve. */
  readonly easeOut: BezierControls;
};

export const WALL_SWAP = {
  /** Outgoing-only weight at the pager's commit distance, and past it; shared holds never go below it. */
  dimFloor: 0.4,
  /** The whole swap after a commit. */
  durationMs: 200,
  /** Outgoing-only holds are gone by here (ease-in). */
  outgoingEndMs: 120,
  /** Incoming-only holds start no earlier than this, and finish at `durationMs` (ease-out). */
  incomingStartMs: 60,
  /** A linear dissolve changes either weight by at most 0.07 per frame at 60 Hz. */
  reduceMotionDurationMs: 240,
  /** Interrupted weights ease to what the finger asks for over this long. */
  settleMs: 120,
  /** A commit from another pair first eases that pair to its leaving climb, whole, over this long. */
  leadInMs: 120,
  /** A board caught mid-swap is pulled back once it travels this many points back toward the climb being left. */
  pullBackPoints: 4,
  /** How far the page position leans from the outgoing page toward the arriving one. */
  pairLean: 0.25,
  /** CSS `ease-in`. */
  easeIn: [0.42, 0, 1, 1],
  /** CSS `ease-out`. */
  easeOut: [0, 0, 0.58, 1],
} as const satisfies WallSwapTuning;

/** Weights this close to a target count as there. */
const EPSILON = 1e-3;

/** A side's leftover weight below this is dark enough to switch pairs on. */
const DARK = 1e-3;

/** CSS cubic-bezier with fixed ends, solved by bisection: closer than an 8-bit weight. */
function bezierPoint(control1: number, control2: number, parameter: number): number {
  'worklet';
  const inverse = 1 - parameter;
  return 3 * inverse * inverse * parameter * control1 + 3 * inverse * parameter * parameter * control2 + parameter ** 3;
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number, progress: number): number {
  'worklet';
  if (!(progress > 0)) return 0;
  if (progress >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2;
    if (bezierPoint(x1, x2, middle) < progress) low = middle;
    else high = middle;
  }
  return bezierPoint(y1, y2, (low + high) / 2);
}

/** The outgoing fade's curve: CSS `ease-in` in `WALL_SWAP`. */
export function easeIn(progress: number, tuning: WallSwapTuning): number {
  'worklet';
  const curve = tuning.easeIn;
  return cubicBezier(curve[0], curve[1], curve[2], curve[3], progress);
}

/** The incoming fade's and the settle's curve: CSS `ease-out` in `WALL_SWAP`. */
export function easeOut(progress: number, tuning: WallSwapTuning): number {
  'worklet';
  const curve = tuning.easeOut;
  return cubicBezier(curve[0], curve[1], curve[2], curve[3], progress);
}

/** The first progress at which `easeIn` reaches `value`; never early. */
function easeInProgressFor(value: number, tuning: WallSwapTuning): number {
  'worklet';
  if (!(value > 0)) return 0;
  if (value >= 1) return 1;
  const curve = tuning.easeIn;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2;
    if (bezierPoint(curve[1], curve[3], middle) < value) low = middle;
    else high = middle;
  }
  return bezierPoint(curve[0], curve[2], high);
}

function clampUnit(value: number): number {
  'worklet';
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

function mix(from: number, to: number, amount: number): number {
  'worklet';
  return from + (to - from) * amount;
}

/**
 * Outgoing-only weight while dragging: 100% at rest, 40% at the pager's commit
 * distance and beyond. `offset` and `commitDistance` are both board points, so
 * this is the same as page progress over the commit point's page progress.
 */
export function dragOutgoingWeight(
  offset: number,
  commitDistance: number,
  reduceMotion: boolean,
  tuning: WallSwapTuning,
): number {
  'worklet';
  if (reduceMotion || !(commitDistance > 0) || !Number.isFinite(offset)) return 1;
  return 1 - (1 - tuning.dimFloor) * Math.min(1, Math.abs(offset) / commitDistance);
}

export type SwapTiming = { durationMs: number; outgoingEndMs: number; incomingStartMs: number; dissolve: boolean };

/**
 * Reduce Motion fades both sides together. In the eased swap, incoming-only
 * holds start at 60 ms, or later if the outgoing ones are still above 40% then.
 */
export function swapTiming(startOutgoing: number, reduceMotion: boolean, tuning: WallSwapTuning): SwapTiming {
  'worklet';
  if (reduceMotion) {
    const durationMs = tuning.reduceMotionDurationMs;
    return { durationMs, outgoingEndMs: durationMs, incomingStartMs: 0, dissolve: true };
  }
  const outgoingEndMs = tuning.outgoingEndMs;
  const toFloor =
    startOutgoing > tuning.dimFloor
      ? outgoingEndMs * easeInProgressFor(1 - tuning.dimFloor / startOutgoing, tuning)
      : 0;
  return {
    durationMs: tuning.durationMs,
    outgoingEndMs,
    incomingStartMs: Math.max(tuning.incomingStartMs, toFloor),
    dissolve: false,
  };
}

/** Both weights `elapsedMs` into a swap that began at these weights. */
export function swapWeightsAt(
  elapsedMs: number,
  startOutgoing: number,
  startIncoming: number,
  timing: SwapTiming,
  tuning: WallSwapTuning,
): { outgoing: number; incoming: number } {
  'worklet';
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (timing.dissolve) {
    const progress = clampUnit(elapsed / timing.durationMs);
    return { outgoing: mix(startOutgoing, 0, progress), incoming: mix(startIncoming, 1, progress) };
  }
  const incomingSpan = timing.durationMs - timing.incomingStartMs;
  return {
    outgoing: startOutgoing * (1 - easeIn(elapsed / timing.outgoingEndMs, tuning)),
    incoming: mix(
      startIncoming,
      1,
      incomingSpan > 0 ? easeOut((elapsed - timing.incomingStartMs) / incomingSpan, tuning) : elapsed > 0 ? 1 : 0,
    ),
  };
}

export type WallSwapState = SwapTiming & {
  /** The page whose climb is being left on screen; at rest, the climb on show. */
  from: number;
  /** Toward the arriving page on screen: 1 next, -1 previous, 0 no pair. */
  dir: number;
  /** Weights on screen for outgoing-only and incoming-only holds. */
  outgoing: number;
  incoming: number;
  /** A committed swap is running on its own clock. */
  swapping: boolean;
  /** The running swap's leaving page and direction; during a lead-in the pair on screen is another. */
  swapFrom: number;
  swapDir: number;
  swapStartOutgoing: number;
  swapStartIncoming: number;
  /** Lead-in before the swap: the pair on screen at the commit easing to its leaving climb, whole. */
  leadMs: number;
  leadFrom: number;
  leadDir: number;
  leadOutgoing: number;
  leadIncoming: number;
  /**
   * The pager has made the swap's arriving climb its middle page (landed, or
   * caught by a finger), and how far back toward the leaving climb the board
   * has been at its most onward since, in points.
   */
  arrived: boolean;
  backReference: number;
  /** Interrupted weights easing to what the finger asks for, on their own clock. */
  settling: boolean;
  settleDurationMs: number;
  settleOutgoing: number;
  settleIncoming: number;
  /** The pager as last seen: its middle page, committed steps and resets. */
  anchor: number;
  steps: number;
  reset: number;
};

export type WallSwapInput = {
  /** The pager's middle page, offset (board points, left is negative) and fling. */
  anchor: number;
  offset: number;
  fling: number;
  /** Bumped once per committed step, and when the JS thread moves the pager. */
  steps: number;
  reset: number;
  /** Milliseconds on the swap and settle clocks since they last started. */
  swapMs: number;
  settleMs: number;
  reduceMotion: boolean;
  /** The pager's commit distance in board points. */
  commitDistance: number;
};

export type WallSwapStep = {
  state: WallSwapState;
  /** Restart the swap clock from 0 toward `swapClockMs(state)`. */
  startSwap: boolean;
  /** Restart the settle clock at 0 for this duration, or leave it running. */
  startSettleMs: number | null;
};

/** How long the swap clock runs: any lead-in, then the swap itself. */
export function swapClockMs(state: WallSwapState): number {
  'worklet';
  return state.leadMs + state.durationMs;
}

/** One climb on its own: nothing leaving, nothing arriving. */
export function wallSwapRest(
  page: number,
  seen: Pick<WallSwapState, 'anchor' | 'steps' | 'reset'>,
  tuning: WallSwapTuning,
): WallSwapState {
  'worklet';
  return {
    from: page,
    dir: 0,
    outgoing: 1,
    incoming: 0,
    swapping: false,
    swapFrom: page,
    swapDir: 0,
    swapStartOutgoing: 1,
    swapStartIncoming: 0,
    durationMs: tuning.durationMs,
    outgoingEndMs: tuning.outgoingEndMs,
    incomingStartMs: tuning.incomingStartMs,
    dissolve: false,
    leadMs: 0,
    leadFrom: page,
    leadDir: 0,
    leadOutgoing: 1,
    leadIncoming: 0,
    arrived: false,
    backReference: 0,
    settling: false,
    settleDurationMs: 0,
    settleOutgoing: 1,
    settleIncoming: 0,
    anchor: seen.anchor,
    steps: seen.steps,
    reset: seen.reset,
  };
}

/** The page position the native view reads the pair from. */
export function wallSwapPagePosition(state: WallSwapState, tuning: WallSwapTuning): number {
  'worklet';
  return state.from + state.dir * tuning.pairLean;
}

/**
 * The weight of shared holds, lit with the same role in both climbs: the
 * brighter of the outgoing-only and incoming-only weights on screen, never below
 * `dimFloor`. At rest that is 1; dragging, it is the outgoing weight; in a swap
 * it holds at the floor until the incoming weight passes it. Symmetric in the
 * two weights, so a pulled-back pair, which swaps them, shows the same shared
 * holds; and continuous wherever they are. Reduce Motion keeps shared holds
 * whole: its dissolve must not blink a hold that does not change.
 */
export function wallSwapSharedWeight(
  state: Pick<WallSwapState, 'outgoing' | 'incoming'>,
  reduceMotion: boolean,
  tuning: WallSwapTuning,
): number {
  'worklet';
  if (reduceMotion) return 1;
  const brighter = state.outgoing > state.incoming ? state.outgoing : state.incoming;
  // Written so a non-finite weight lands on the floor, never on NaN.
  return brighter > tuning.dimFloor ? (brighter < 1 ? brighter : 1) : tuning.dimFloor;
}

/**
 * One frame of the swap: the pair on show (the nearest page is the climb being
 * left), then the outgoing-only, incoming-only and shared weights. One value, so
 * the native view never applies a new pair with old weights.
 */
export type WallSwapFrame = readonly [
  pagePosition: number,
  outgoingWeight: number,
  incomingWeight: number,
  sharedWeight: number,
];

/** The swap frame as a binary of `apiVersion` takes it. */
export type NativeWallSwapFrame =
  | WallSwapFrame
  | readonly [pagePosition: number, outgoingWeight: number, incomingWeight: number];

/**
 * API 7 takes all four numbers. API 6 takes exactly three and freezes the swap
 * on anything else, so it gets the frame without the shared weight and keeps
 * shared holds fully lit.
 */
export function nativeWallSwapFrame(frame: WallSwapFrame, apiVersion: number): NativeWallSwapFrame {
  'worklet';
  return apiVersion >= WALL_SWAP_SHARED_NATIVE_API ? frame : [frame[0], frame[1], frame[2]];
}

/** The side the board has been pulled toward: 1 the next climb, -1 the previous, 0 centred. */
function sideOf(offset: number): number {
  'worklet';
  return offset < 0 ? 1 : offset > 0 ? -1 : 0;
}

function settled(state: WallSwapState): WallSwapStep {
  'worklet';
  return { state, startSwap: false, startSettleMs: null };
}

/** Start easing from the weights on screen, which therefore do not move this frame. */
function settleFromHere(state: WallSwapState, reduceMotion: boolean, tuning: WallSwapTuning): WallSwapStep {
  'worklet';
  const durationMs = reduceMotion ? tuning.reduceMotionDurationMs : tuning.settleMs;
  return {
    state: {
      ...state,
      swapping: false,
      settling: true,
      settleDurationMs: durationMs,
      dissolve: reduceMotion,
      settleOutgoing: state.outgoing,
      settleIncoming: state.incoming,
    },
    startSwap: false,
    startSettleMs: durationMs,
  };
}

/**
 * The weights on screen for the pair (`from`, `dir`), relabelled if `state`
 * shows it the other way round, or null when `state` shows another pair that
 * is not settled on its leaving climb: switching to (`from`, `dir`) now would
 * change which holds count as outgoing-only in a single frame.
 */
function weightsFor(state: WallSwapState, from: number, dir: number): [number, number] | null {
  'worklet';
  if (state.from === from && (state.dir === dir || state.dir === 0)) {
    return [state.outgoing, state.dir === dir ? state.incoming : 0];
  }
  if (state.dir === -dir && state.from === from + dir) return [state.incoming, state.outgoing];
  if (state.from !== from) return [1, 0];
  return state.outgoing >= 1 - EPSILON && state.incoming <= DARK ? [1, 0] : null;
}

/**
 * A commit reversing a swap that is still in its lead-in: the screen shows
 * another pair easing to its leaving climb, whole, and that climb is where
 * this commit heads. The swap's arriving climb has not been on screen, so the
 * lead-in carries on from the weights on screen and nothing is left to swap
 * after it; the clock ends on the arriving climb at rest.
 */
function backThroughLeadIn(
  previous: WallSwapState,
  seen: Pick<WallSwapState, 'anchor' | 'steps' | 'reset'>,
  from: number,
  dir: number,
  leadMs: number,
  dissolve: boolean,
): WallSwapStep {
  'worklet';
  return {
    state: {
      ...previous,
      ...seen,
      swapping: true,
      swapFrom: from,
      swapDir: dir,
      // The swap's own pair, were it ever drawn: its arriving climb whole.
      swapStartOutgoing: 0,
      swapStartIncoming: 1,
      durationMs: 0,
      outgoingEndMs: 0,
      incomingStartMs: 0,
      dissolve,
      leadMs,
      leadFrom: previous.from,
      leadDir: previous.dir,
      leadOutgoing: previous.outgoing,
      leadIncoming: previous.incoming,
      arrived: false,
      backReference: 0,
      settling: false,
    },
    startSwap: true,
    startSettleMs: null,
  };
}

/** The weight on screen of `page`'s own holds: its side of the pair on show, or 0 when it is not shown. */
function shownWeight(state: WallSwapState, page: number): number {
  'worklet';
  if (state.from === page) return state.outgoing;
  return state.dir !== 0 && state.from + state.dir === page ? state.incoming : 0;
}

/**
 * Where an onward commit during a swap starts: the running swap's arriving
 * climb, which this commit skips, alone at 40%, or at its weight on screen when
 * that is higher. Never brighter than that, so a skipped climb never flashes
 * whole. Its pair goes at once: the native view has only the climbs either side
 * of the pager's centre prepared, and keeping the older pair on screen would
 * leave it outside them as soon as the centre moves on.
 */
function skippedClimb(
  previous: WallSwapState,
  seen: Pick<WallSwapState, 'anchor' | 'steps' | 'reset'>,
  tuning: WallSwapTuning,
): WallSwapState {
  'worklet';
  const skipped = previous.swapFrom + previous.swapDir;
  const weight = shownWeight(previous, skipped);
  return {
    ...wallSwapRest(skipped, seen, tuning),
    outgoing: weight > tuning.dimFloor ? (weight < 1 ? weight : 1) : tuning.dimFloor,
  };
}

function commit(previous: WallSwapState, input: WallSwapInput, tuning: WallSwapTuning): WallSwapStep {
  'worklet';
  const seen = { anchor: input.anchor, steps: input.steps, reset: input.reset };
  // Under Reduce Motion the fling's spring can land before this runs.
  const dir = input.fling !== 0 ? Math.sign(input.fling) : Math.sign(input.anchor - previous.anchor);
  const from = input.fling !== 0 ? input.anchor : previous.anchor;
  if (dir === 0) return settled(wallSwapRest(input.anchor, seen, tuning));
  const leadMs = input.reduceMotion ? tuning.reduceMotionDurationMs : tuning.leadInMs;
  // Leaves the running swap's arriving climb, back toward its leaving one.
  const reverses = previous.swapping && dir === -previous.swapDir && from === previous.swapFrom + previous.swapDir;
  if (reverses && previous.from === from + dir && previous.dir !== -dir) {
    return backThroughLeadIn(previous, seen, from, dir, leadMs, input.reduceMotion);
  }
  // A reversing commit starts from the weights on screen, relabelled. An onward
  // one ends the running swap first, from the climb it skips at no more than 40%
  // or its weight on screen.
  const base = previous.swapping && !reverses ? skippedClimb(previous, seen, tuning) : previous;
  const start = weightsFor(base, from, dir);
  const [outgoing, incoming] = start ?? [1, 0];
  return {
    state: {
      ...base,
      ...seen,
      ...swapTiming(outgoing, input.reduceMotion, tuning),
      // Without a lead-in the swap's pair is on screen from the first frame.
      from: start ? from : base.from,
      dir: start ? dir : base.dir,
      outgoing: start ? outgoing : base.outgoing,
      incoming: start ? incoming : base.incoming,
      swapping: true,
      swapFrom: from,
      swapDir: dir,
      swapStartOutgoing: outgoing,
      swapStartIncoming: incoming,
      leadMs: start ? 0 : leadMs,
      leadFrom: base.from,
      leadDir: base.dir,
      leadOutgoing: base.outgoing,
      leadIncoming: base.incoming,
      arrived: false,
      backReference: 0,
      settling: false,
    },
    startSwap: true,
    startSettleMs: null,
  };
}

function runSwap(previous: WallSwapState, input: WallSwapInput, tuning: WallSwapTuning): WallSwapStep {
  'worklet';
  const seen = { anchor: input.anchor, steps: input.steps, reset: input.reset };
  const elapsed = input.swapMs;
  const leading = elapsed < previous.leadMs;
  const progress = leading ? elapsed / previous.leadMs : 1;
  const amount = previous.dissolve ? clampUnit(progress) : easeOut(progress, tuning);
  const swapped = swapWeightsAt(
    elapsed - previous.leadMs,
    previous.swapStartOutgoing,
    previous.swapStartIncoming,
    previous,
    tuning,
  );
  const shown = leading
    ? {
        from: previous.leadFrom,
        dir: previous.leadDir,
        outgoing: mix(previous.leadOutgoing, 1, amount),
        incoming: mix(previous.leadIncoming, 0, amount),
      }
    : { from: previous.swapFrom, dir: previous.swapDir, ...swapped };
  const to = previous.swapFrom + previous.swapDir;
  // The pager has made the arriving climb its middle page: landed (offset 0),
  // or caught by a finger with the offset it was still travelling.
  const onArrival = input.fling === 0 && input.anchor === to;
  // How far the board sits back toward the climb being left.
  const back = input.offset * previous.swapDir;
  let arrived = previous.arrived;
  let backReference = previous.backReference;
  if (onArrival && !arrived) {
    arrived = true;
    backReference = back;
  } else if (onArrival) {
    if (!leading && back > 0 && back > backReference + tuning.pullBackPoints) {
      // Pulled back: the arriving climb is now the one being left. Same pixels.
      return settleFromHere(
        {
          ...previous,
          ...seen,
          from: to,
          dir: -previous.swapDir,
          outgoing: shown.incoming,
          incoming: shown.outgoing,
        },
        input.reduceMotion,
        tuning,
      );
    }
    backReference = Math.min(backReference, back);
  }
  if (elapsed >= swapClockMs(previous)) {
    const arrivedRest = wallSwapRest(to, seen, tuning);
    // A finger still on the board dims the arrived climb from whole.
    return onArrival && input.offset !== 0 && !input.reduceMotion
      ? settleFromHere({ ...arrivedRest, dir: sideOf(input.offset) }, false, tuning)
      : settled(arrivedRest);
  }
  return settled({ ...previous, ...seen, ...shown, arrived, backReference });
}

function follow(
  previous: WallSwapState,
  input: WallSwapInput,
  tuning: WallSwapTuning,
  suppressDragDim: boolean,
): WallSwapStep {
  'worklet';
  const seen = { anchor: input.anchor, steps: input.steps, reset: input.reset };
  // A committed fling that its swap already covered is still landing.
  if (input.fling !== 0) return settled({ ...previous, ...seen });
  // The fling landed this frame, or a finger caught it short with the offset
  // it was still travelling.
  const caught = input.anchor !== previous.anchor && input.offset !== 0;
  let current = previous;
  if (current.from !== input.anchor) {
    if (current.dir === 0 || current.from + current.dir !== input.anchor) {
      return settled(wallSwapRest(input.anchor, seen, tuning));
    }
    current = {
      ...current,
      from: input.anchor,
      dir: -current.dir,
      outgoing: current.incoming,
      incoming: current.outgoing,
      settleOutgoing: current.settleIncoming,
      settleIncoming: current.settleOutgoing,
    };
  }
  const target = dragOutgoingWeight(input.offset, input.commitDistance, input.reduceMotion || suppressDragDim, tuning);
  const side = sideOf(input.offset);
  const progress = current.settling ? input.settleMs / current.settleDurationMs : 1;
  const amount = current.dissolve ? clampUnit(progress) : easeOut(progress, tuning);
  const settling = current.settling && amount < 1;
  /** This frame's weights for the pair on show, heading for `goal` and nothing arriving. */
  const toward = (goal: number): WallSwapState => ({
    ...current,
    ...seen,
    outgoing: settling ? mix(current.settleOutgoing, goal, amount) : goal,
    incoming: settling ? mix(current.settleIncoming, 0, amount) : 0,
    settling,
  });
  // The finger is on the pair's side, or the board was at rest: follow it. A
  // board caught away from the middle eases into its dim rather than snap.
  if (side === current.dir || current.dir === 0) {
    if (caught && !settling && Math.abs(current.outgoing - target) > EPSILON) {
      return settleFromHere({ ...current, ...seen, dir: side }, input.reduceMotion, tuning);
    }
    return settled({ ...toward(target), dir: side });
  }
  if (side === 0) {
    // Centred again: the pair goes once its leaving climb is whole and the other dark.
    const centred = toward(1);
    const rest = centred.outgoing >= 1 - EPSILON && centred.incoming <= DARK;
    return settled(rest ? { ...centred, dir: 0, outgoing: 1, incoming: 0, settling: false } : centred);
  }
  // The finger crossed to the other side. A pair switch changes which holds
  // are outgoing-only. While the old arriving climb is still lit, keep the
  // pair and fade it out (the leaving climb heading for whole); then ease from
  // the weight on screen into the new side's dim.
  if (current.incoming > DARK) {
    const held = toward(1);
    if (held.incoming > DARK) {
      return settling ? settled(held) : settleFromHere({ ...current, ...seen }, input.reduceMotion, tuning);
    }
    return settleFromHere({ ...held, dir: side, incoming: 0 }, input.reduceMotion, tuning);
  }
  if (Math.abs(current.outgoing - target) <= EPSILON) return settled({ ...toward(target), dir: side });
  return settleFromHere({ ...current, ...seen, dir: side, incoming: 0 }, input.reduceMotion, tuning);
}

/**
 * One UI-thread step. A reset (the JS thread moved the pager: a Next button,
 * a queue tap) shows the new climb at once, as the wipe did. A committed step
 * starts a swap; otherwise a running swap advances, or the weights follow the
 * finger.
 */
export function stepWallSwap(
  previous: WallSwapState,
  input: WallSwapInput,
  tuning: WallSwapTuning,
  suppressDragDim?: boolean,
): WallSwapStep {
  'worklet';
  if (input.reset !== previous.reset) {
    return settled(
      wallSwapRest(input.anchor, { anchor: input.anchor, steps: input.steps, reset: input.reset }, tuning),
    );
  }
  if (input.steps !== previous.steps) return commit(previous, input, tuning);
  const step = previous.swapping
    ? runSwap(previous, input, tuning)
    : follow(previous, input, tuning, suppressDragDim === true);
  return {
    ...step,
    state: { ...step.state, outgoing: clampUnit(step.state.outgoing), incoming: clampUnit(step.state.incoming) },
  };
}

/**
 * The wall swap as a board transition (`board-transition.ts`): `stepWallSwap`
 * with these numbers, and the frame and clock restarts `use-wall-swap` applies.
 * `wallSwapDriver()` is the player's own; the board motion lab retunes it.
 */
export function wallSwapDriver(tuning: WallSwapTuning = WALL_SWAP): BoardTransitionDriver {
  const rest = (input: WallSwapInput): WallSwapState => {
    'worklet';
    return wallSwapRest(input.anchor, input, tuning);
  };
  const step = (previous: BoardTransitionState, input: WallSwapInput): BoardTransitionStep => {
    'worklet';
    // Only ever handed the states `rest` and `step` made.
    const next = stepWallSwap(previous as unknown as WallSwapState, input, tuning);
    return {
      state: next.state,
      frame: [
        wallSwapPagePosition(next.state, tuning),
        next.state.outgoing,
        next.state.incoming,
        wallSwapSharedWeight(next.state, input.reduceMotion, tuning),
      ],
      startSwapMs: next.startSwap ? swapClockMs(next.state) : null,
      startSettleMs: next.startSettleMs,
    };
  };
  return { rest, step };
}
