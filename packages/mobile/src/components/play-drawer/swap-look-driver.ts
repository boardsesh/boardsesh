/**
 * The wall swap with a native swap look (`swap-look.ts`): the shipped state
 * machine still decides every weight, so cancels, re-flicks, reversals and
 * pull-backs behave as they do with the shipped swap. This driver adds what the
 * look needs on top, each frame, on the UI thread. The player runs it with
 * `PLAYER_SWAP_LOOK` (`player-swap-look.ts`); the board motion lab runs it with
 * every look variant's numbers.
 *
 * - How each climb on screen moves, as a code (`ARRIVES_*`): leaving, or
 *   arriving from the right or the left edge, and calm (a flick run's arrival,
 *   no swell). A climb takes the arriving rules when it shows up as the
 *   incoming climb (from off screen, or from weight 0), with the edge it comes
 *   in from, and drops them at weight 1, or at 0 as the climb being left.
 *   Codes follow the climb (its page), not its role or slot, and a climb
 *   already on screen changes code only at 0 or 1: a relabelled pair keeps its
 *   pixels, and a climb skipped mid-front keeps its front's side.
 * - The shared floor. Shared holds take the brighter of the two fronts at
 *   their spot and never go below it. A commit within `runWindowMs` of the
 *   previous one (a flick run) eases it to 1 over the settle, so a fast run
 *   never blinks the holds that stay.
 * - Ghosts (`ghostFloor`). While dragging, the arriving climb's weight follows
 *   the dim up to the look's arrival floor, which the look draws as glow without
 *   marks. A commit carries that weight into the swap as its starting point, so
 *   nothing jumps.
 * - An onward flick mid-swap. The machine restarts the climb it skips at the
 *   drag floor or its weight, whichever is higher. When the look's arrival floor
 *   sits below the drag floor that climb is not uniform at the drag floor, so
 *   it would jump; it keeps its weight on screen instead.
 * - A flick-run swap length (`runSwapMs`), using the machine's own per-swap
 *   timing.
 * - Calm runs (`calmRuns`). A drag whose offset leaves 0 within `runWindowMs`
 *   of the last commit shows no ghost and no drag dim until the offset returns
 *   to 0 or it commits, and a flick run's arrival has no swell, so a fast run
 *   never shows the next climb's ghosts or pulses halos.
 *
 * Under Reduce Motion it is the machine's dissolve with this tuning: four-number
 * frames, no look (native turns the look off too). The player never gets here
 * under Reduce Motion: it runs the shipped swap instead (`player-swap-look.ts`).
 */
import type {
  BoardTransition,
  BoardTransitionDriver,
  BoardTransitionState,
  BoardTransitionStep,
} from './board-transition';
import type { SwapLook, SwapLookFrame } from './swap-look';
import {
  easeOut,
  stepWallSwap,
  swapClockMs,
  wallSwapPagePosition,
  wallSwapRest,
  wallSwapSharedWeight,
  type WallSwapInput,
  type WallSwapState,
  type WallSwapTuning,
} from './wall-swap';

/**
 * Everything a swap look runs on: the wall swap's timing, the native look's
 * numbers and the driver's rules. The look's floor is always the tuning's
 * `dimFloor`; its arrival floor is `arrivalFloorShare` of it.
 */
export type SwapLookSpec = {
  readonly tuning: WallSwapTuning;
  readonly look: Omit<SwapLook, 'floor' | 'arrivalFloor'>;
  /** The arriving climb's floor as a share of the drag floor: 1 moves like a leaving climb, 0 one front. */
  readonly arrivalFloorShare: number;
  /** Shared holds never go below this; 1 keeps them whole. */
  readonly sharedFloor: number;
  /** A commit this soon after the previous one is a flick run; 0 turns runs off. */
  readonly runWindowMs: number;
  /** A flick run's swap length; 0 keeps the normal one. */
  readonly runSwapMs: number;
  /** The arriving climb rises with the drag's dim, up to its arrival floor (ghosts). */
  readonly ghostDrag: boolean;
  /** Inside a flick run: no ghosts, no drag dim, no swell. */
  readonly calmRuns: boolean;
};

export type SwapLookDriverOptions = {
  tuning: WallSwapTuning;
  /** Shared holds never go below this; 1 keeps them whole. */
  sharedFloor: number;
  /** While dragging, the arriving climb rises with the dim, up to this weight (the look's arrival floor); 0 off. */
  ghostFloor: number;
  /** The look's arrival floor: below the drag floor, a skipped climb keeps its weight on screen. */
  arrivalFloor: number;
  /** A commit this soon after the previous one is a flick run (shared holds whole); 0 turns runs off. */
  runWindowMs: number;
  /** A flick run's swap length; 0 keeps the normal one. */
  runSwapMs: number;
  /** Inside a flick run: no ghosts, no drag dim, no swell. */
  calmRuns: boolean;
};

/** Arrival codes, as the native look reads them (`ClimbOverlaySwapLook.Side`). */
export const LEAVING = 0;
export const ARRIVES_FROM_RIGHT = 1;
export const ARRIVES_FROM_LEFT = 2;
/** Added to an arriving code: a flick run's arrival, with no swell. */
export const ARRIVES_CALM = 4;

/** The machine's state plus the look's bookkeeping. Numbers, so the state stays plain. */
export type SwapLookState = WallSwapState & {
  /** The pair the last frame showed, and each of its climbs' arrival code. */
  lookFrom: number;
  lookDir: number;
  outgoingArrives: number;
  incomingArrives: number;
  /** The pager's offset last frame, to see a drag start. */
  lastOffset: number;
  /** This drag started inside a flick run: no ghost, no dim. */
  calmDrag: boolean;
  /** The running swap is a flick run's (until the next commit): its arrival is calm. */
  calmSwap: boolean;
  /** The incoming weight the last frame showed, ghost included. */
  shownIncoming: number;
  /** The shared floor eases from `sharedFrom` to `sharedTo` over the settle after each commit. */
  sharedFrom: number;
  sharedTo: number;
  /** The shared floor the last frame showed. */
  sharedShown: number;
  /** A commit has happened since the last reset, so the next one can be a flick run. */
  committed: boolean;
};

function clampUnit(value: number): number {
  'worklet';
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

/** The tuning a flick run's commit swaps with: the same swap scaled to `runSwapMs`. */
export function runTuning(tuning: WallSwapTuning, runSwapMs: number): WallSwapTuning {
  'worklet';
  if (!(runSwapMs > 0) || !(tuning.durationMs > 0)) return tuning;
  const scale = runSwapMs / tuning.durationMs;
  return {
    ...tuning,
    durationMs: tuning.durationMs * scale,
    outgoingEndMs: tuning.outgoingEndMs * scale,
    incomingStartMs: tuning.incomingStartMs * scale,
  };
}

/** `flagFor` for a climb the previous frame did not show. */
export const NOT_SHOWN = -1;

/**
 * A page's arrival code this frame. `previousCode` is what it was, looked up by
 * page so a relabel keeps it, or `NOT_SHOWN`. Whole: leaving. At 0, or just come
 * on screen (it was invisible, so nothing can jump): `entering` as the incoming
 * climb, leaving as the climb being left. Otherwise unchanged.
 */
export function arrivalCode(previousCode: number, weight: number, incoming: boolean, entering: number): number {
  'worklet';
  if (weight >= 1) return LEAVING;
  if (weight <= 0 || previousCode === NOT_SHOWN) return incoming ? entering : LEAVING;
  return previousCode;
}

function flagFor(state: SwapLookState, page: number): number {
  'worklet';
  if (page === state.lookFrom) return state.outgoingArrives;
  return state.lookDir !== 0 && page === state.lookFrom + state.lookDir ? state.incomingArrives : NOT_SHOWN;
}

/** The weight the last frame showed `page` at, or `NOT_SHOWN`. */
function shownWeight(state: SwapLookState, page: number): number {
  'worklet';
  if (page === state.lookFrom) return state.outgoing;
  return state.lookDir !== 0 && page === state.lookFrom + state.lookDir ? state.shownIncoming : NOT_SHOWN;
}

export function swapLookDriver(options: SwapLookDriverOptions): BoardTransitionDriver {
  const { tuning, sharedFloor, ghostFloor, arrivalFloor, runWindowMs, runSwapMs, calmRuns } = options;
  const ghostDrag = ghostFloor > 0;
  const keepSkipped = arrivalFloor < tuning.dimFloor;
  const floor = clampUnit(sharedFloor);
  const fastTuning = runTuning(tuning, runSwapMs);
  // The swap clock runs at least this long, so a flick run and the shared
  // floor's ease can be timed on it even after a short swap ends.
  const minimumClockMs = Math.max(runWindowMs, tuning.settleMs);

  const lookRest = (input: WallSwapInput): SwapLookState => {
    'worklet';
    return {
      ...wallSwapRest(input.anchor, input, tuning),
      lookFrom: input.anchor,
      lookDir: 0,
      outgoingArrives: LEAVING,
      incomingArrives: LEAVING,
      lastOffset: input.offset,
      calmDrag: false,
      calmSwap: false,
      shownIncoming: 0,
      sharedFrom: floor,
      sharedTo: floor,
      sharedShown: floor,
      committed: false,
    };
  };

  const step = (previousState: BoardTransitionState, input: WallSwapInput): BoardTransitionStep => {
    'worklet';
    // Only ever handed the states `rest` and `step` made.
    const previous = previousState as unknown as SwapLookState;
    const reset = input.reset !== previous.reset;
    const commits = !reset && input.steps !== previous.steps;
    // The swap clock runs from the last commit, at least `runWindowMs`.
    const inRunWindow = previous.committed && runWindowMs > 0 && input.swapMs < runWindowMs;
    const run = commits && inRunWindow;

    if (input.reduceMotion) {
      // The shipped Reduce Motion swap, with no look: native draws API 7.
      const shipped = stepWallSwap(previous, input, tuning);
      return {
        state: {
          ...previous,
          ...shipped.state,
          outgoingArrives: LEAVING,
          incomingArrives: LEAVING,
          shownIncoming: 0,
          lastOffset: input.offset,
          calmDrag: false,
          calmSwap: false,
        },
        frame: [
          wallSwapPagePosition(shipped.state, tuning),
          shipped.state.outgoing,
          shipped.state.incoming,
          wallSwapSharedWeight(shipped.state, true, tuning),
        ],
        startSwapMs: shipped.startSwap ? swapClockMs(shipped.state) : null,
        startSettleMs: shipped.startSettleMs,
      };
    }

    // A calm drag: one that left 0 inside a flick run, until it returns to 0 or commits.
    let calmDrag = previous.calmDrag;
    if (reset || commits || input.offset === 0) calmDrag = false;
    else if (previous.lastOffset === 0) calmDrag = calmRuns && inRunWindow;
    const machine = stepWallSwap(previous, input, run ? fastTuning : tuning, calmDrag);
    let state: WallSwapState = machine.state;

    // A commit straight from a drag (same pair, no lead-in) starts its swap
    // from the ghost on screen; a lead-in eases from it.
    if (ghostDrag && commits && !previous.swapping && state.swapping && previous.dir !== 0) {
      const shown = previous.shownIncoming;
      if (state.leadMs > 0 && state.leadFrom === previous.from && state.leadDir === previous.dir) {
        state = { ...state, leadIncoming: Math.max(state.leadIncoming, shown) };
      } else if (state.leadMs === 0 && state.swapFrom === previous.from && state.swapDir === previous.dir) {
        const start = Math.max(state.swapStartIncoming, shown);
        state = { ...state, swapStartIncoming: start, incoming: start };
      }
    }

    // An onward flick mid-swap: the climb it skips stays at its weight on screen.
    if (
      keepSkipped &&
      commits &&
      previous.swapping &&
      state.swapping &&
      state.leadMs === 0 &&
      state.swapDir === previous.swapDir &&
      state.from === previous.swapFrom + previous.swapDir
    ) {
      const shown = shownWeight(previous, state.from);
      if (shown !== NOT_SHOWN && shown < state.outgoing) {
        state = { ...state, outgoing: shown, swapStartOutgoing: shown };
      }
    }

    // The incoming weight on screen: a ghost while dragging toward a climb. While
    // the machine eases into the drag (a pair switch, a catch, a finger still down
    // on arrival), the ghost grows with that settle's own ease, from nothing on
    // the frame it starts, so it never appears whole in one frame.
    let incoming = state.incoming;
    if (ghostDrag && !calmDrag && !state.swapping && state.dir !== 0) {
      const dimmed = tuning.dimFloor < 1 ? (1 - state.outgoing) / (1 - tuning.dimFloor) : 0;
      let eased = 1;
      if (machine.startSettleMs !== null) eased = 0;
      else if (state.settling && tuning.settleMs > 0) eased = easeOut(input.settleMs / tuning.settleMs, tuning);
      const ghost = ghostFloor * clampUnit(dimmed) * eased;
      if (ghost > incoming) incoming = ghost;
    }

    // Arrival codes, by page. A climb arriving on the right of the one being
    // left comes in from the right edge; a calm one is a flick run's.
    const calmSwap = reset ? false : commits ? run : previous.calmSwap;
    const calm = calmRuns && (calmDrag || (calmSwap && state.swapping));
    const entering = (state.dir > 0 ? ARRIVES_FROM_RIGHT : ARRIVES_FROM_LEFT) + (calm ? ARRIVES_CALM : 0);
    const outgoingArrives = arrivalCode(flagFor(previous, state.from), state.outgoing, false, entering);
    const incomingArrives =
      state.dir !== 0 ? arrivalCode(flagFor(previous, state.from + state.dir), incoming, true, entering) : LEAVING;

    // The shared floor: decided at each commit, eased in over the settle.
    let sharedFrom = previous.sharedFrom;
    let sharedTo = previous.sharedTo;
    let shared: number;
    if (reset) {
      sharedFrom = floor;
      sharedTo = floor;
      shared = floor;
    } else if (machine.startSwap) {
      sharedFrom = previous.sharedShown;
      sharedTo = run ? 1 : floor;
      shared = sharedFrom;
    } else {
      const amount = tuning.settleMs > 0 ? easeOut(input.swapMs / tuning.settleMs, tuning) : 1;
      shared = sharedFrom + (sharedTo - sharedFrom) * amount;
    }

    const frame: SwapLookFrame = [
      wallSwapPagePosition(state, tuning),
      state.outgoing,
      incoming,
      shared,
      outgoingArrives,
      incomingArrives,
    ];
    const lookState: SwapLookState = {
      ...state,
      lookFrom: state.from,
      lookDir: state.dir,
      outgoingArrives,
      incomingArrives,
      lastOffset: input.offset,
      calmDrag,
      calmSwap,
      shownIncoming: incoming,
      sharedFrom,
      sharedTo,
      sharedShown: shared,
      committed: reset ? false : previous.committed || commits,
    };
    return {
      state: lookState,
      frame,
      startSwapMs: machine.startSwap ? Math.max(swapClockMs(state), minimumClockMs) : null,
      startSettleMs: machine.startSettleMs,
    };
  };

  return { rest: lookRest, step };
}

/** The board transition a swap look runs as: the wall swap's driver with the look on top, and the look itself. */
export function swapLookTransition(spec: SwapLookSpec): BoardTransition {
  const floor = spec.tuning.dimFloor;
  const look: SwapLook = { ...spec.look, floor, arrivalFloor: floor * spec.arrivalFloorShare };
  return {
    revealMode: 'swap',
    driver: swapLookDriver({
      tuning: spec.tuning,
      sharedFloor: spec.sharedFloor,
      ghostFloor: spec.ghostDrag ? look.arrivalFloor : 0,
      arrivalFloor: look.arrivalFloor,
      runWindowMs: spec.runWindowMs,
      runSwapMs: spec.runSwapMs,
      calmRuns: spec.calmRuns,
    }),
    look,
  };
}
