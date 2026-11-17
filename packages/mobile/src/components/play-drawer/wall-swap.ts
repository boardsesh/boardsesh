/**
 * The wall swap: how the player's stationary GPU board hands its lit holds from
 * one climb to the next during a swipe.
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
 *   the weights on screen to what the finger asks for, with no jump. A new commit
 *   during a swap, a caught board flicked onward included, ends the running swap
 *   first: its old holds go and its new climb is whole.
 * - A commit whose pair is not the one on screen (pulled back toward one climb,
 *   then flicked toward the other) first eases that pair to its leaving climb,
 *   whole, over 120 ms, and only then swaps: changing pairs any earlier would
 *   change which holds count as outgoing-only in one frame.
 * - Shared holds dip with the rest and never go dark: they follow whichever of
 *   the other two kinds is brighter, never below 40% (`wallSwapSharedWeight`).
 *   Dragging takes them down with the outgoing-only holds; a swap holds them at
 *   40% until the incoming-only holds pass it, then brings them back with them.
 * - Reduce Motion: no dim while dragging, the swap is one 120 ms dissolve, and
 *   shared holds stay fully lit.
 *
 * The native view is told which pair it is showing through its page position:
 * the nearest page is the climb being left, and the side the position leans to
 * holds the arriving one. Pure and worklet-safe; `use-wall-swap` drives it.
 */

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

/** The player's reveal on this binary: older native builds only know the wipe. */
export function playerRevealMode(apiVersion: number): RevealMode {
  return apiVersion >= WALL_SWAP_NATIVE_API ? PLAYER_REVEAL_MODE : 'wipe';
}

export const WALL_SWAP = {
  /** Outgoing-only weight at the pager's commit distance, and past it; shared holds never go below it. */
  dimFloor: 0.4,
  /** The whole swap after a commit. */
  durationMs: 200,
  /** Outgoing-only holds are gone by here (ease-in). */
  outgoingEndMs: 120,
  /** Incoming-only holds start no earlier than this, and finish at `durationMs` (ease-out). */
  incomingStartMs: 60,
  /** Reduce Motion compresses the same swap into one dissolve this long. */
  reduceMotionDurationMs: 120,
  /** Interrupted weights ease to what the finger asks for over this long. */
  settleMs: 120,
  /** A commit from another pair first eases that pair to its leaving climb, whole, over this long. */
  leadInMs: 120,
  /** A board caught mid-swap is pulled back once it travels this many points back toward the climb being left. */
  pullBackPoints: 4,
  /** How far the page position leans from the outgoing page toward the arriving one. */
  pairLean: 0.25,
} as const;

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

/** CSS `ease-in`, the outgoing fade. */
export function easeIn(progress: number): number {
  'worklet';
  return cubicBezier(0.42, 0, 1, 1, progress);
}

/** CSS `ease-out`, the incoming fade and the settle. */
export function easeOut(progress: number): number {
  'worklet';
  return cubicBezier(0, 0, 0.58, 1, progress);
}

/** The first progress at which `easeIn` reaches `value`; never early. */
function easeInProgressFor(value: number): number {
  'worklet';
  if (!(value > 0)) return 0;
  if (value >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2;
    if (bezierPoint(0, 1, middle) < value) low = middle;
    else high = middle;
  }
  return bezierPoint(0.42, 1, high);
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
export function dragOutgoingWeight(offset: number, commitDistance: number, reduceMotion: boolean): number {
  'worklet';
  if (reduceMotion || !(commitDistance > 0) || !Number.isFinite(offset)) return 1;
  return 1 - (1 - WALL_SWAP.dimFloor) * Math.min(1, Math.abs(offset) / commitDistance);
}

export type SwapTiming = { durationMs: number; outgoingEndMs: number; incomingStartMs: number };

/**
 * The windows of one swap. Incoming-only holds start at 60 ms (36 ms under
 * Reduce Motion), or later if the outgoing ones are still above 40% then.
 */
export function swapTiming(startOutgoing: number, reduceMotion: boolean): SwapTiming {
  'worklet';
  const scale = reduceMotion ? WALL_SWAP.reduceMotionDurationMs / WALL_SWAP.durationMs : 1;
  const outgoingEndMs = WALL_SWAP.outgoingEndMs * scale;
  const toFloor =
    startOutgoing > WALL_SWAP.dimFloor ? outgoingEndMs * easeInProgressFor(1 - WALL_SWAP.dimFloor / startOutgoing) : 0;
  return {
    durationMs: WALL_SWAP.durationMs * scale,
    outgoingEndMs,
    incomingStartMs: Math.max(WALL_SWAP.incomingStartMs * scale, toFloor),
  };
}

/** Both weights `elapsedMs` into a swap that began at these weights. */
export function swapWeightsAt(
  elapsedMs: number,
  startOutgoing: number,
  startIncoming: number,
  timing: SwapTiming,
): { outgoing: number; incoming: number } {
  'worklet';
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const incomingSpan = timing.durationMs - timing.incomingStartMs;
  return {
    outgoing: startOutgoing * (1 - easeIn(elapsed / timing.outgoingEndMs)),
    incoming: mix(
      startIncoming,
      1,
      incomingSpan > 0 ? easeOut((elapsed - timing.incomingStartMs) / incomingSpan) : elapsed > 0 ? 1 : 0,
    ),
  };
}

export type WallSwapState = {
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
  durationMs: number;
  outgoingEndMs: number;
  incomingStartMs: number;
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
  /** Restart the settle clock from 0 toward `WALL_SWAP.settleMs`. */
  startSettle: boolean;
};

/** How long the swap clock runs: any lead-in, then the swap itself. */
export function swapClockMs(state: WallSwapState): number {
  'worklet';
  return state.leadMs + state.durationMs;
}

/** One climb on its own: nothing leaving, nothing arriving. */
export function wallSwapRest(page: number, seen: Pick<WallSwapState, 'anchor' | 'steps' | 'reset'>): WallSwapState {
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
    durationMs: WALL_SWAP.durationMs,
    outgoingEndMs: WALL_SWAP.outgoingEndMs,
    incomingStartMs: WALL_SWAP.incomingStartMs,
    leadMs: 0,
    leadFrom: page,
    leadDir: 0,
    leadOutgoing: 1,
    leadIncoming: 0,
    arrived: false,
    backReference: 0,
    settling: false,
    settleOutgoing: 1,
    settleIncoming: 0,
    anchor: seen.anchor,
    steps: seen.steps,
    reset: seen.reset,
  };
}

/** The page position the native view reads the pair from. */
export function wallSwapPagePosition(state: WallSwapState): number {
  'worklet';
  return state.from + state.dir * WALL_SWAP.pairLean;
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
): number {
  'worklet';
  if (reduceMotion) return 1;
  const brighter = state.outgoing > state.incoming ? state.outgoing : state.incoming;
  // Written so a non-finite weight lands on the floor, never on NaN.
  return brighter > WALL_SWAP.dimFloor ? (brighter < 1 ? brighter : 1) : WALL_SWAP.dimFloor;
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
  return { state, startSwap: false, startSettle: false };
}

/** Start easing from the weights on screen, which therefore do not move this frame. */
function settleFromHere(state: WallSwapState): WallSwapStep {
  'worklet';
  return {
    state: {
      ...state,
      swapping: false,
      settling: true,
      settleOutgoing: state.outgoing,
      settleIncoming: state.incoming,
    },
    startSwap: false,
    startSettle: true,
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

function commit(previous: WallSwapState, input: WallSwapInput): WallSwapStep {
  'worklet';
  const seen = { anchor: input.anchor, steps: input.steps, reset: input.reset };
  // Under Reduce Motion the fling's spring can land before this runs.
  const dir = input.fling !== 0 ? Math.sign(input.fling) : Math.sign(input.anchor - previous.anchor);
  const from = input.fling !== 0 ? input.anchor : previous.anchor;
  if (dir === 0) return settled(wallSwapRest(input.anchor, seen));
  // A commit during a swap ends that swap first: its arriving climb is whole.
  const base = previous.swapping ? wallSwapRest(previous.swapFrom + previous.swapDir, seen) : previous;
  const start = weightsFor(base, from, dir);
  const scale = input.reduceMotion ? WALL_SWAP.reduceMotionDurationMs / WALL_SWAP.durationMs : 1;
  const [outgoing, incoming] = start ?? [1, 0];
  return {
    state: {
      ...base,
      ...seen,
      ...swapTiming(outgoing, input.reduceMotion),
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
      leadMs: start ? 0 : WALL_SWAP.leadInMs * scale,
      leadFrom: base.from,
      leadDir: base.dir,
      leadOutgoing: base.outgoing,
      leadIncoming: base.incoming,
      arrived: false,
      backReference: 0,
      settling: false,
    },
    startSwap: true,
    startSettle: false,
  };
}

function runSwap(previous: WallSwapState, input: WallSwapInput): WallSwapStep {
  'worklet';
  const seen = { anchor: input.anchor, steps: input.steps, reset: input.reset };
  const elapsed = input.swapMs;
  const leading = elapsed < previous.leadMs;
  const amount = leading ? easeOut(elapsed / previous.leadMs) : 1;
  const swapped = swapWeightsAt(
    elapsed - previous.leadMs,
    previous.swapStartOutgoing,
    previous.swapStartIncoming,
    previous,
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
    if (!leading && back > 0 && back > backReference + WALL_SWAP.pullBackPoints) {
      // Pulled back: the arriving climb is now the one being left. Same pixels.
      return settleFromHere({
        ...previous,
        ...seen,
        from: to,
        dir: -previous.swapDir,
        outgoing: shown.incoming,
        incoming: shown.outgoing,
      });
    }
    backReference = Math.min(backReference, back);
  }
  if (elapsed >= swapClockMs(previous)) {
    const arrivedRest = wallSwapRest(to, seen);
    // A finger still on the board dims the arrived climb from whole.
    return onArrival && input.offset !== 0
      ? settleFromHere({ ...arrivedRest, dir: sideOf(input.offset) })
      : settled(arrivedRest);
  }
  return settled({ ...previous, ...seen, ...shown, arrived, backReference });
}

function follow(previous: WallSwapState, input: WallSwapInput): WallSwapStep {
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
      return settled(wallSwapRest(input.anchor, seen));
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
  const target = dragOutgoingWeight(input.offset, input.commitDistance, input.reduceMotion);
  const side = sideOf(input.offset);
  const amount = current.settling ? easeOut(input.settleMs / WALL_SWAP.settleMs) : 1;
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
      return settleFromHere({ ...current, ...seen, dir: side });
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
    if (held.incoming > DARK) return settling ? settled(held) : settleFromHere({ ...current, ...seen });
    return settleFromHere({ ...held, dir: side, incoming: 0 });
  }
  if (Math.abs(current.outgoing - target) <= EPSILON) return settled({ ...toward(target), dir: side });
  return settleFromHere({ ...current, ...seen, dir: side, incoming: 0 });
}

/**
 * One UI-thread step. A reset (the JS thread moved the pager: a Next button,
 * a queue tap) shows the new climb at once, as the wipe did. A committed step
 * starts a swap; otherwise a running swap advances, or the weights follow the
 * finger.
 */
export function stepWallSwap(previous: WallSwapState, input: WallSwapInput): WallSwapStep {
  'worklet';
  if (input.reset !== previous.reset) {
    return settled(wallSwapRest(input.anchor, { anchor: input.anchor, steps: input.steps, reset: input.reset }));
  }
  if (input.steps !== previous.steps) return commit(previous, input);
  const step = previous.swapping ? runSwap(previous, input) : follow(previous, input);
  return {
    ...step,
    state: { ...step.state, outgoing: clampUnit(step.state.outgoing), incoming: clampUnit(step.state.incoming) },
  };
}
