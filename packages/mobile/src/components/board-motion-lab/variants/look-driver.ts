/**
 * The wall swap with a native swap look (`play-drawer/swap-look.ts`): the
 * shipped state machine still decides every weight, so cancels, re-flicks,
 * reversals and pull-backs behave as they do in the player. This driver adds
 * what the look needs on top, each frame, on the UI thread:
 *
 * - Which climbs on screen arrive. A climb takes the look's arriving rules
 *   when it shows up as the incoming climb (from off screen, or from weight 0),
 *   and drops them at weight 1, or at 0 as the climb being left. Flags follow
 *   the climb (its page), not its role, and a climb already on screen flips
 *   only at 0 or 1, so a relabelled pair keeps its pixels.
 * - The shared floor. Shared holds take the brighter of the two fronts at
 *   their spot and never go below it. A commit within `runWindowMs` of the
 *   previous one (a flick run) eases it to 1 over the settle, so a fast run
 *   never blinks the holds that stay.
 * - Ghosts (E). While dragging, the arriving climb's weight follows the dim up
 *   to the floor, which the look draws as glow without marks. A commit carries
 *   that weight into the swap as its starting point, so nothing jumps.
 * - A flick-run swap length (`runSwapMs`), using the machine's own per-swap
 *   timing.
 *
 * Under Reduce Motion it is the shipped swap: one dissolve, four-number
 * frames, no look (native turns the look off too).
 */
import type {
  BoardTransitionDriver,
  BoardTransitionState,
  BoardTransitionStep,
} from '../../play-drawer/board-transition';
import type { SwapLookFrame } from '../../play-drawer/swap-look';
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
} from '../../play-drawer/wall-swap';

export type SwapLookDriverOptions = {
  tuning: WallSwapTuning;
  /** Shared holds never go below this; 1 keeps them whole. */
  sharedFloor: number;
  /** E: while dragging, the arriving climb rises with the dim, up to the floor. */
  ghostDrag: boolean;
  /** A commit this soon after the previous one is a flick run (shared holds whole); 0 turns runs off. */
  runWindowMs: number;
  /** A flick run's swap length; 0 keeps the normal one. */
  runSwapMs: number;
};

/** The machine's state plus the look's bookkeeping. Numbers, so the state stays plain. */
export type SwapLookState = WallSwapState & {
  /** The pair the last frame showed, and whether each of its climbs arrives (1) or not (0). */
  lookFrom: number;
  lookDir: number;
  outgoingArrives: number;
  incomingArrives: number;
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
 * A page's arrival flag this frame. `previousFlag` is what it was, looked up
 * by page so a relabel keeps it, or `NOT_SHOWN`. Whole: off. At 0, or just
 * come on screen (it was invisible, so nothing can jump): on as the incoming
 * climb, off as the climb being left. Otherwise unchanged.
 */
export function arrivalFlag(previousFlag: number, weight: number, incoming: boolean): number {
  'worklet';
  if (weight >= 1) return 0;
  if (weight <= 0 || previousFlag === NOT_SHOWN) return incoming ? 1 : 0;
  return previousFlag;
}

function flagFor(state: SwapLookState, page: number): number {
  'worklet';
  if (page === state.lookFrom) return state.outgoingArrives;
  return state.lookDir !== 0 && page === state.lookFrom + state.lookDir ? state.incomingArrives : NOT_SHOWN;
}

export function swapLookDriver(options: SwapLookDriverOptions): BoardTransitionDriver {
  const { tuning, sharedFloor, ghostDrag, runWindowMs, runSwapMs } = options;
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
      outgoingArrives: 0,
      incomingArrives: 0,
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
    const run = commits && previous.committed && runWindowMs > 0 && input.swapMs < runWindowMs;

    if (input.reduceMotion) {
      // The shipped Reduce Motion swap, with no look: native draws API 7.
      const shipped = stepWallSwap(previous, input, tuning);
      return {
        state: { ...previous, ...shipped.state, outgoingArrives: 0, incomingArrives: 0, shownIncoming: 0 },
        frame: [
          wallSwapPagePosition(shipped.state, tuning),
          shipped.state.outgoing,
          shipped.state.incoming,
          wallSwapSharedWeight(shipped.state, true, tuning),
        ],
        startSwapMs: shipped.startSwap ? swapClockMs(shipped.state) : null,
        startSettleMs: shipped.startSettle ? tuning.settleMs : null,
      };
    }

    const machine = stepWallSwap(previous, input, run ? fastTuning : tuning);
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

    // The incoming weight on screen: a ghost while dragging toward a climb.
    let incoming = state.incoming;
    if (ghostDrag && !state.swapping && state.dir !== 0) {
      const dimmed = tuning.dimFloor < 1 ? (1 - state.outgoing) / (1 - tuning.dimFloor) : 0;
      const ghost = tuning.dimFloor * clampUnit(dimmed);
      if (ghost > incoming) incoming = ghost;
    }

    // Arrival flags, by page.
    const outgoingArrives = arrivalFlag(flagFor(previous, state.from), state.outgoing, false);
    const incomingArrives =
      state.dir !== 0 ? arrivalFlag(flagFor(previous, state.from + state.dir), incoming, true) : 0;

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
      startSettleMs: machine.startSettle ? tuning.settleMs : null,
    };
  };

  return { rest: lookRest, step };
}
