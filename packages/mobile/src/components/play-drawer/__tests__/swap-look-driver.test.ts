import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardTransitionDriver } from '../board-transition';
import { PLAYER_SWAP_LOOK } from '../player-swap-look';
import { shippedSwapFrame } from '../swap-look';
import {
  ARRIVES_CALM,
  ARRIVES_FROM_LEFT,
  ARRIVES_FROM_RIGHT,
  arrivalCode,
  LEAVING,
  NOT_SHOWN,
  runTuning,
  swapLookDriver,
  swapLookTransition,
  type SwapLookSpec,
} from '../swap-look-driver';
import { WALL_SWAP, wallSwapDriver } from '../wall-swap';
import {
  ENDS_AT_REST,
  expectLookInvariants,
  pages,
  randomWalk,
  runDriver,
  SEQUENCES,
  ticks,
  type Operation,
} from './helpers/swap-look-driver-harness';

function driverOf(spec: SwapLookSpec): BoardTransitionDriver {
  const { driver } = swapLookTransition(spec);
  if (!driver) throw new Error('no driver');
  return driver;
}

const PLAYER = driverOf(PLAYER_SWAP_LOOK);

/**
 * The largest change of any climb's weight between two frames when only the
 * clocks moved (an 8 ms tick). A settle at 120 ms moves a weight by at most
 * about 0.035 a tick; a ghost that appears whole in one frame moves 0.2 or more.
 */
const MAX_TICK_STEP = 0.06;
function largestTickStep(operations: readonly Operation[], frames: ReturnType<typeof runDriver>): number {
  let largest = 0;
  for (let index = 1; index < frames.length; index++) {
    if (!('tick' in operations[index])) continue;
    const before = pages(frames[index - 1]);
    for (const [page, now] of pages(frames[index])) {
      const then = before.get(page);
      if (then) largest = Math.max(largest, Math.abs(now.weight - then.weight));
    }
  }
  return largest;
}

/** No ghosts, no runs, shared holds dipping: the side weights are the machine's alone. */
const PLAIN: SwapLookSpec = {
  ...PLAYER_SWAP_LOOK,
  sharedFloor: 0.8,
  runWindowMs: 0,
  runSwapMs: 0,
  ghostDrag: false,
  calmRuns: false,
};

describe('swap look driver', () => {
  it('builds the look from the spec: its floor is the drag floor, its arrival floor a share of it', () => {
    const transition = swapLookTransition({ ...PLAYER_SWAP_LOOK, arrivalFloorShare: 0.5 });
    expect(transition.revealMode).toBe('swap');
    expect(transition.look).toEqual({ ...PLAYER_SWAP_LOOK.look, floor: 0.4, arrivalFloor: 0.2 });
  });

  it('keeps the look invariants through every scripted sequence and a long random walk', () => {
    for (const spec of [PLAYER_SWAP_LOOK, PLAIN, { ...PLAYER_SWAP_LOOK, arrivalFloorShare: 0 }]) {
      for (const operations of [...Object.values(SEQUENCES), randomWalk(11, 2500)]) {
        expectLookInvariants(runDriver(operations, driverOf(spec)), spec.sharedFloor);
      }
    }
  });

  it('ends every sequence at rest: one climb whole, shared floor settled, nothing arriving', () => {
    for (const name of ENDS_AT_REST) {
      const last = runDriver(SEQUENCES[name], PLAYER).at(-1);
      expect(last?.slice(0, 4)).toEqual([expect.any(Number), 1, 0, 1]);
      expect(Number.isInteger(last?.[0])).toBe(true);
      expect(last?.slice(4)).toEqual([LEAVING, LEAVING]);
    }
    expect(runDriver(SEQUENCES['a JS-driven move mid-swap'], PLAYER).at(-1)?.slice(0, 3)).toEqual([5, 1, 0]);
  });

  it('without ghosts or runs, the side weights are exactly the shipped machine with the same tuning', () => {
    for (const operations of [...Object.values(SEQUENCES), randomWalk(5, 1500)]) {
      const look = runDriver(operations, driverOf(PLAIN));
      const shipped = runDriver(operations, wallSwapDriver(PLAIN.tuning));
      expect(look.map((frame) => frame.slice(0, 3))).toEqual(shipped.map((frame) => frame.slice(0, 3)));
    }
    const plain = swapLookDriver({
      tuning: WALL_SWAP,
      sharedFloor: 1,
      ghostFloor: 0,
      arrivalFloor: WALL_SWAP.dimFloor,
      runWindowMs: 0,
      runSwapMs: 0,
      calmRuns: false,
    });
    expect(runDriver(SEQUENCES['commit and land'], plain).map((frame) => frame.slice(0, 3))).toEqual(
      runDriver(SEQUENCES['commit and land'], wallSwapDriver()).map((frame) => frame.slice(0, 3)),
    );
  });

  it('marks the arriving climb from the first drag frame and drops the mark once it is whole', () => {
    const frames = runDriver(
      [{ drag: -40 }, { drag: -90 }, { commit: 1 }, ...ticks(40), { land: 0 }, ...ticks(40)],
      PLAYER,
    );
    expect(frames[0].slice(4)).toEqual([LEAVING, ARRIVES_FROM_RIGHT]);
    // Previous: the climb on the left comes in from the left edge.
    expect(runDriver([{ drag: 40 }], PLAYER)[0].slice(4)).toEqual([LEAVING, ARRIVES_FROM_LEFT]);
    const arrived = frames.at(-1);
    expect(arrived?.slice(0, 3)).toEqual([1, 1, 0]);
    expect(arrived?.slice(4)).toEqual([0, 0]);
  });

  it('shows the next climb as a ghost while dragging, carries it into the swap and takes it back on a cancel', () => {
    const floor = PLAYER_SWAP_LOOK.tuning.dimFloor;
    const dragged = runDriver([{ drag: -40 }, { drag: -SWIPE_THRESHOLD }], PLAYER);
    expect(dragged[0][2]).toBeCloseTo(floor / 2, 6);
    expect(dragged[1][2]).toBeCloseTo(floor, 6);
    expect(dragged[1].slice(4)).toEqual([LEAVING, ARRIVES_FROM_RIGHT]);
    const committed = runDriver([{ drag: -SWIPE_THRESHOLD }, { commit: 1 }, ...ticks(20)], PLAYER);
    expect(committed[1][2]).toBeCloseTo(floor, 6);
    for (let index = 2; index < committed.length; index++) {
      expect(committed[index][2]).toBeGreaterThanOrEqual(committed[index - 1][2] - 1e-9);
    }
    const cancelled = runDriver(
      [-40, -80, -40, -10, 0].map((drag) => ({ drag })),
      PLAYER,
    );
    expect(cancelled.at(-1)?.slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('grows the ghost with a settle instead of showing it whole when the settle ends', () => {
    // Drag to −60, cross to +40 and hold: the pair switches and eases into the new side's dim.
    const crossed: Operation[] = [{ drag: -60 }, { drag: 40 }, ...ticks(24)];
    const crossedFrames = runDriver(crossed, PLAYER);
    expect(crossedFrames[1][2]).toBe(0);
    expect(crossedFrames[2][2]).toBeGreaterThan(0);
    // At 40 pt the dim is halfway to the floor, so the ghost is half the arrival floor.
    expect(crossedFrames.at(-1)?.[2]).toBeCloseTo(0.2, 6);
    expect(largestTickStep(crossed, crossedFrames)).toBeLessThan(MAX_TICK_STEP);

    const across = SEQUENCES['drag across the middle'];
    const acrossFrames = runDriver(across, PLAYER);
    // The finger crosses, then holds for eight ticks: the new side's ghost comes in during the settle.
    expect(acrossFrames[9][2]).toBeGreaterThan(0.1);
    expect(largestTickStep(across, acrossFrames)).toBeLessThan(MAX_TICK_STEP);

    // A fling caught short and held past the commit distance: the climb it left
    // comes back as a ghost over the settle, ending at the drag floor.
    const caught = SEQUENCES['caught and pulled back'];
    const caughtFrames = runDriver(caught, PLAYER);
    expect(largestTickStep(caught, caughtFrames)).toBeLessThan(MAX_TICK_STEP);
    const pulledBack = caughtFrames.at(-1);
    expect(pulledBack?.[1]).toBeCloseTo(PLAYER_SWAP_LOOK.tuning.dimFloor, 6);
    expect(pulledBack?.[2]).toBeCloseTo(PLAYER_SWAP_LOOK.tuning.dimFloor, 6);
  });

  it('a reversal mid-swap keeps every climb’s weight and flag: the same pixels, played back', () => {
    for (const ms of [0, 40, 96, 160]) {
      const operations: Operation[] = [{ drag: -90 }, { commit: 1 }, ...ticks(ms / 8), { land: 140 }, { commit: -1 }];
      const frames = runDriver(operations, PLAYER);
      const before = pages(frames[frames.length - 2]);
      const after = pages(frames[frames.length - 1]);
      for (const [page, shown] of after) {
        const previous = before.get(page);
        if (!previous) {
          expect(shown.weight).toBe(0);
          continue;
        }
        expect(shown.weight).toBeCloseTo(previous.weight, 12);
        if (shown.weight > 0 && shown.weight < 1) expect(shown.arrives).toBe(previous.arrives);
      }
      expect(frames.at(-1)?.[3]).toBeCloseTo(frames[frames.length - 2][3], 12);
    }
  });

  it('a quick re-flick keeps the skipped climb’s entry edge, so its front never flips side', () => {
    let checked = 0;
    for (const ms of [16, 48, 80, 104, 160]) {
      const frames = runDriver(
        [{ drag: -90 }, { commit: 1 }, ...ticks(ms / 8), { land: 140 }, { drag: 120 }, { commit: 1 }, ...ticks(2)],
        PLAYER,
      );
      const before = pages(frames[frames.length - 4]).get(1);
      const after = pages(frames[frames.length - 3]).get(1);
      if (before && after && before.weight > 0 && before.weight < 1 && after.weight > 0 && after.weight < 1) {
        expect(after.arrives & 3).toBe(ARRIVES_FROM_RIGHT);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('keeps a flick run calm: no ghosts, no drag dim, no swell', () => {
    const operations: Operation[] = [
      { drag: -40 },
      { drag: -90 },
      { commit: 1 },
      ...ticks(3),
      { land: 0 },
      // The swap finishes (240 ms), still inside the 400 ms run window.
      ...ticks(27),
      // A second drag inside the run window: calm until it commits.
      { drag: -20 },
      { drag: -60 },
      { commit: 1 },
      ...ticks(3),
    ];
    const frames = runDriver(operations, PLAYER);
    for (const frame of frames.slice(34, 36)) {
      expect(frame[1]).toBe(1);
      expect(frame[2]).toBe(0);
      expect(frame[5]).toBe(ARRIVES_FROM_RIGHT + ARRIVES_CALM);
    }
    // The run's arrival keeps its calm code: no swell.
    expect(frames.at(-1)?.[5]).toBe(ARRIVES_FROM_RIGHT + ARRIVES_CALM);
    // The same drag outside a run: ghosts and dim.
    const fresh = runDriver([{ drag: -60 }], PLAYER)[0];
    expect(fresh[1]).toBeLessThan(1);
    expect(fresh[2]).toBeGreaterThan(0);
    expect(fresh[5]).toBe(ARRIVES_FROM_RIGHT);
    // Without calm runs the second drag dims as usual.
    const restless = runDriver(
      [{ drag: -90 }, { commit: 1 }, ...ticks(3), { land: 0 }, { drag: -20 }, { drag: -60 }],
      driverOf({ ...PLAYER_SWAP_LOOK, calmRuns: false }),
    );
    expect(restless.at(-1)?.[1]).toBeLessThan(1);
  });

  it('a flick run keeps shared holds whole, easing the floor up rather than jumping', () => {
    const dipping = driverOf({ ...PLAYER_SWAP_LOOK, sharedFloor: PLAIN.sharedFloor });
    const frames = runDriver(SEQUENCES['three quick flicks'], dipping);
    expect(frames.at(-1)?.[3]).toBe(1);
    for (let index = 1; index < frames.length; index++) {
      expect(Math.abs(frames[index][3] - frames[index - 1][3])).toBeLessThan(0.1);
    }
    const slow = runDriver(
      [
        { drag: -90 },
        { commit: 1 },
        ...ticks(60),
        { land: 0 },
        ...ticks(10),
        { drag: -90 },
        { commit: 1 },
        ...ticks(5),
      ],
      dipping,
    );
    expect(slow.at(-1)?.[3]).toBe(PLAIN.sharedFloor);
  });

  it('with an arrival floor below the drag floor, a flick onward keeps the skipped climb at its weight on screen', () => {
    // One front for the arriving climb is not uniform at the drag floor, so the
    // machine's "at least the floor" restart would jump; the driver keeps the screen.
    const frames = runDriver(
      [{ drag: -90 }, { commit: 1 }, ...ticks(10), { land: 140 }, { drag: 120 }, { commit: 1 }, ...ticks(4)],
      // The shipped timing: 80 ms in, the arriving climb is still below the drag floor.
      driverOf({ ...PLAYER_SWAP_LOOK, tuning: WALL_SWAP, arrivalFloorShare: 0, ghostDrag: false }),
    );
    const commitIndex = frames.length - 5;
    const skipped = pages(frames[commitIndex - 1]).get(1);
    const restarted = pages(frames[commitIndex]).get(1);
    expect(skipped?.weight).toBeLessThan(PLAYER_SWAP_LOOK.tuning.dimFloor);
    expect(restarted?.weight).toBeCloseTo(skipped?.weight ?? -1, 12);
    expect(restarted?.arrives).toBe(skipped?.arrives);
  });

  it('a flick run can shorten the swap', () => {
    expect(runTuning(WALL_SWAP, 100)).toMatchObject({ durationMs: 100, outgoingEndMs: 60, incomingStartMs: 30 });
    expect(runTuning(WALL_SWAP, 0)).toBe(WALL_SWAP);
  });

  it('under Reduce Motion is the machine’s dissolve with the same tuning: four numbers, no look', () => {
    for (const operations of Object.values(SEQUENCES)) {
      const frames = runDriver(operations, PLAYER, true);
      for (const frame of frames) expect(frame).toHaveLength(4);
      expect(frames).toEqual(runDriver(operations, wallSwapDriver(PLAYER_SWAP_LOOK.tuning), true));
    }
  });

  it('codes a climb only while it is dark or new to the screen, and clears it when whole', () => {
    expect(arrivalCode(NOT_SHOWN, 0.3, true, ARRIVES_FROM_LEFT)).toBe(ARRIVES_FROM_LEFT);
    expect(arrivalCode(NOT_SHOWN, 0.3, false, ARRIVES_FROM_LEFT)).toBe(LEAVING);
    expect(arrivalCode(LEAVING, 0, true, ARRIVES_FROM_RIGHT)).toBe(ARRIVES_FROM_RIGHT);
    expect(arrivalCode(ARRIVES_FROM_RIGHT, 0, false, ARRIVES_FROM_LEFT)).toBe(LEAVING);
    // Mid-weight a climb keeps its code, entry edge included, whichever slot it moves to.
    expect(arrivalCode(ARRIVES_FROM_RIGHT, 0.5, false, ARRIVES_FROM_LEFT)).toBe(ARRIVES_FROM_RIGHT);
    expect(arrivalCode(LEAVING, 0.5, true, ARRIVES_FROM_RIGHT)).toBe(LEAVING);
    expect(arrivalCode(ARRIVES_FROM_RIGHT, 1, true, ARRIVES_FROM_RIGHT)).toBe(LEAVING);
  });

  it('look frames reach a binary without the look as the shipped four numbers', () => {
    expect(shippedSwapFrame([0.25, 0.6, 0.2, 1, 0, 1])).toEqual([0.25, 0.6, 0.2, 1]);
    expect(shippedSwapFrame([0.25, 0.6, 0.2, 0.4, 0, 1])).toEqual([0.25, 0.6, 0.2, 0.6]);
    expect(shippedSwapFrame([0.25, 0.1, 0.2, 0.4, 0, 1])).toEqual([0.25, 0.1, 0.2, 0.4]);
    const shipped = [0.25, 0.6, 0.2, 0.6] as const;
    expect(shippedSwapFrame(shipped)).toBe(shipped);
  });
});
