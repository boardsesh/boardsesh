import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import {
  dragOutgoingWeight,
  easeIn,
  easeOut,
  nativeWallSwapFrame,
  playerRevealMode,
  stepWallSwap,
  swapClockMs,
  swapTiming,
  swapWeightsAt,
  WALL_SWAP,
  WALL_SWAP_SHARED_NATIVE_API,
  wallSwapPagePosition,
  wallSwapRest,
  wallSwapSharedWeight,
  type WallSwapFrame,
  type WallSwapInput,
  type WallSwapState,
} from '../wall-swap';

/**
 * Five overlapping climbs by page, as hold ids. Page 1 shares 3 and 4 with page
 * 0 and 4 and 6 with page 2, so changing which climb page 1 is paired with
 * changes which of its holds count as outgoing-only.
 */
const CLIMBS = new Map<number, ReadonlySet<number>>([
  [-1, new Set([1, 9, 10])],
  [0, new Set([1, 2, 3, 4])],
  [1, new Set([3, 4, 5, 6])],
  [2, new Set([4, 6, 7, 8])],
  [3, new Set([8, 11])],
]);

/**
 * What the board shows for a state, hold by hold, as the native compositor
 * draws it: a pair lights shared holds at the shared weight and each side's own
 * holds at its weight; no pair is the climb's still.
 */
function holdWeights(state: WallSwapState, reduceMotion: boolean): Map<number, number> {
  const leaving = CLIMBS.get(state.from) ?? new Set<number>();
  const shown = new Map<number, number>();
  if (state.dir === 0) {
    for (const hold of leaving) shown.set(hold, 1);
    return shown;
  }
  const arriving = CLIMBS.get(state.from + state.dir) ?? new Set<number>();
  const shared = wallSwapSharedWeight(state, reduceMotion);
  for (const hold of leaving) shown.set(hold, arriving.has(hold) ? shared : state.outgoing);
  for (const hold of arriving) if (!leaving.has(hold)) shown.set(hold, state.incoming);
  return shown;
}

/** One frame: the weights, the pair's page position, and every hold as drawn. */
type Frame = { outgoing: number; incoming: number; shared: number; position: number; holds: Map<number, number> };

/**
 * Drives the UI-thread step the way use-wall-swap does: the pager's values in,
 * the two clocks restarted on request and advanced by the frames that follow.
 */
function harness(reduceMotion = false) {
  let input: WallSwapInput = {
    anchor: 0,
    offset: 0,
    fling: 0,
    steps: 0,
    reset: 0,
    swapMs: 0,
    settleMs: 0,
    reduceMotion,
    commitDistance: SWIPE_THRESHOLD,
  };
  let state: WallSwapState = wallSwapRest(0, input);
  const frames: Frame[] = [];
  const apply = (changes: Partial<WallSwapInput>) => {
    input = { ...input, ...changes };
    const step = stepWallSwap(state, input);
    state = step.state;
    if (step.startSwap) input = { ...input, swapMs: 0 };
    if (step.startSettle) input = { ...input, settleMs: 0 };
    frames.push({
      outgoing: state.outgoing,
      incoming: state.incoming,
      shared: wallSwapSharedWeight(state, input.reduceMotion),
      position: wallSwapPagePosition(state),
      holds: holdWeights(state, input.reduceMotion),
    });
    return state;
  };
  return {
    drag: (offset: number) => apply({ offset }),
    /** The pager's startFling: a committed step and a fling toward `direction`. */
    commit: (direction: 1 | -1) => apply({ steps: input.steps + 1, fling: direction }),
    /** landFling: the arriving page becomes the anchor; `carry` keeps a caught board's offset. */
    land: (carry = 0) => apply({ anchor: input.anchor + input.fling, fling: 0, offset: carry }),
    /** One frame on both clocks; they stop exactly at their ends, as withTiming does. */
    tick: (ms = 16) =>
      apply({
        swapMs: Math.min(input.swapMs + ms, swapClockMs(state)),
        settleMs: Math.min(input.settleMs + ms, WALL_SWAP.settleMs),
      }),
    reset: (anchor: number) => apply({ anchor, offset: 0, fling: 0, reset: input.reset + 1 }),
    state: () => state,
    frames,
  };
}

/**
 * The largest change of any hold from one frame to the next. At 8 ms frames the
 * steepest curve here moves a hold by under 0.14; a jump moves it further.
 */
function largestStep(frames: Frame[]) {
  let largest = 0;
  for (let index = 1; index < frames.length; index++) {
    const before = frames[index - 1].holds;
    const after = frames[index].holds;
    for (const hold of new Set([...before.keys(), ...after.keys()])) {
      largest = Math.max(largest, Math.abs((after.get(hold) ?? 0) - (before.get(hold) ?? 0)));
    }
  }
  return largest;
}

/** The step in which a jump is reported, at 8 ms frames. */
const JUMP = 0.15;

describe('wall swap drag', () => {
  it('dims outgoing-only holds linearly to 40% at the commit point and holds them there', () => {
    expect(dragOutgoingWeight(0, SWIPE_THRESHOLD, false)).toBe(1);
    expect(dragOutgoingWeight(-SWIPE_THRESHOLD / 2, SWIPE_THRESHOLD, false)).toBeCloseTo(0.7, 10);
    expect(dragOutgoingWeight(SWIPE_THRESHOLD, SWIPE_THRESHOLD, false)).toBeCloseTo(0.4, 10);
    expect(dragOutgoingWeight(-SWIPE_THRESHOLD * 3, SWIPE_THRESHOLD, false)).toBeCloseTo(0.4, 10);
  });

  it('shows nothing incoming and leans the pair toward the finger', () => {
    const swap = harness();
    swap.drag(-40);
    expect(swap.state()).toMatchObject({ from: 0, dir: 1, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.7, 10);
    expect(wallSwapPagePosition(swap.state())).toBe(WALL_SWAP.pairLean);
    for (const offset of [-20, -4, 0, 10, 30, 60, SWIPE_THRESHOLD]) swap.drag(offset);
    expect(swap.state()).toMatchObject({ dir: -1, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
    expect(wallSwapPagePosition(swap.state())).toBe(-WALL_SWAP.pairLean);
  });

  it('eases a jump across the middle instead of snapping the other side’s dim', () => {
    const swap = harness();
    swap.drag(-40);
    swap.drag(SWIPE_THRESHOLD);
    expect(swap.state()).toMatchObject({ dir: -1, settling: true, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.7, 10);
    for (let frame = 0; frame < 8; frame++) swap.tick();
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
  });

  it('cancelled, it follows the pager back to whole and stops naming a pair', () => {
    const swap = harness();
    for (const offset of [-30, -60, -90, -60, -20, -4, 0]) swap.drag(offset);
    expect(swap.frames.map((frame) => frame.outgoing)).toEqual(
      [-30, -60, -90, -60, -20, -4, 0].map((offset) => dragOutgoingWeight(offset, SWIPE_THRESHOLD, false)),
    );
    expect(swap.state()).toMatchObject({ dir: 0, outgoing: 1, incoming: 0 });
    expect(wallSwapPagePosition(swap.state())).toBe(0);
  });
});

describe('wall swap commit', () => {
  it('fades outgoing-only out over 0-120 ms and incoming-only in over 60-200 ms', () => {
    const timing = swapTiming(0.4, false);
    expect(timing).toEqual({ durationMs: 200, outgoingEndMs: 120, incomingStartMs: 60 });
    expect(swapWeightsAt(0, 0.4, 0, timing)).toEqual({ outgoing: 0.4, incoming: 0 });
    expect(swapWeightsAt(60, 0.4, 0, timing).incoming).toBe(0);
    expect(swapWeightsAt(60, 0.4, 0, timing).outgoing).toBeCloseTo(0.4 * (1 - easeIn(0.5)), 10);
    expect(swapWeightsAt(120, 0.4, 0, timing).outgoing).toBe(0);
    expect(swapWeightsAt(130, 0.4, 0, timing).incoming).toBeCloseTo(easeOut(70 / 140), 10);
    expect(swapWeightsAt(200, 0.4, 0, timing)).toEqual({ outgoing: 0, incoming: 1 });
  });

  it('starts at commit on its own clock, whatever the pager does next', () => {
    const swap = harness();
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    expect(swap.state()).toMatchObject({ swapping: true, from: 0, dir: 1, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
    for (let frame = 0; frame < 6; frame++) swap.tick();
    swap.land();
    for (let frame = 0; frame < 7; frame++) swap.tick();
    expect(swap.state()).toMatchObject({ from: 1, dir: 0, outgoing: 1, incoming: 0, swapping: false });
    // The pair never changed until the arriving climb stood alone.
    expect(new Set(swap.frames.slice(1, -1).map((frame) => frame.position))).toEqual(new Set([WALL_SWAP.pairLean]));
  });

  it.each([0.4, 0.55, 0.88, 1])(
    'never shows incoming-only holds while outgoing-only holds are above 40%% (starting at %s)',
    (startOutgoing) => {
      const timing = swapTiming(startOutgoing, false);
      expect(timing.durationMs).toBe(200);
      for (let elapsed = 0; elapsed <= 200; elapsed += 0.5) {
        const { outgoing, incoming } = swapWeightsAt(elapsed, startOutgoing, 0, timing);
        if (incoming > 0) expect(outgoing).toBeLessThanOrEqual(WALL_SWAP.dimFloor);
        // The board is never empty of outgoing and incoming holds at once.
        expect(Math.max(outgoing, incoming)).toBeGreaterThan(0);
      }
    },
  );

  it('waits for a weakly dimmed flick to reach 40% before bringing anything in', () => {
    const timing = swapTiming(dragOutgoingWeight(-20, SWIPE_THRESHOLD, false), false);
    expect(timing.incomingStartMs).toBeGreaterThan(60);
    expect(timing.incomingStartMs).toBeLessThan(120);
    expect(swapTiming(1, false).incomingStartMs).toBeCloseTo(88, 0);
  });
});

describe('wall swap interruptions', () => {
  /** A forward swap from page 0, `ms` in, its board caught with `carry` points still to travel. */
  function caughtSwap(ms: number, carry: number) {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let elapsed = 0; elapsed < ms; elapsed += 8) swap.tick(8);
    swap.land(carry);
    return swap;
  }

  it('a catch mid-swap does not stop the swap; only pulling back reverses it', () => {
    const swap = caughtSwap(40, 140);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 0, swapDir: 1, arrived: true });
    // Held, or moved onward, the swap keeps its clock.
    for (const offset of [140, 142, 120, 100, 103]) {
      swap.drag(offset);
      swap.tick(8);
      expect(swap.state().swapping).toBe(true);
    }
    // Back past where it was most onward (100) by more than 4 points: reversed.
    const before = swap.state();
    swap.drag(106);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: false, settling: true });
    expect(swap.state().outgoing).toBe(before.incoming);
    expect(swap.state().incoming).toBe(before.outgoing);
    expect(wallSwapPagePosition(swap.state())).toBe(1 - WALL_SWAP.pairLean);
    for (const offset of [120, 140, 160, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170]) {
      swap.drag(offset);
      swap.tick(8);
    }
    expect(swap.state()).toMatchObject({ settling: false, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('a caught board flicked onward snaps the running swap to its end before starting the next', () => {
    const swap = caughtSwap(40, 140);
    swap.drag(120);
    swap.tick(8);
    expect(swap.state()).toMatchObject({ swapping: true, from: 0, dir: 1 });
    expect(swap.state().incoming).toBeLessThan(1);
    swap.commit(1);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: true, leadMs: 0, outgoing: 1, incoming: 0 });
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0 });
  });

  it('a new fling after a natural landing snaps the running swap too', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let frame = 0; frame < 3; frame++) swap.tick();
    swap.land(0);
    swap.commit(1);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: true, outgoing: 1, incoming: 0 });
  });

  it('a caught board held still lets the swap finish, then eases the arrived climb into its dim', () => {
    const swap = caughtSwap(40, 140);
    for (let frame = 0; frame < 20; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: false, settling: true, outgoing: 1 });
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(140, SWIPE_THRESHOLD, false), 10);
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('catching a slow fling after its swap has finished eases into the dim instead of snapping', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    // The swap's 200 ms run out while the board is still landing.
    for (let frame = 0; frame < 27; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ swapping: false, from: 1, dir: 0, outgoing: 1 });
    swap.land(120);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, settling: true, outgoing: 1, incoming: 0 });
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(120, SWIPE_THRESHOLD, false), 10);
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('a commit after a reversal, back the way it was pulled, starts from the weights on screen', () => {
    const swap = caughtSwap(40, 140);
    swap.drag(150);
    swap.tick(8);
    const shown = swap.state();
    swap.commit(-1);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: true, leadMs: 0 });
    expect(swap.state().outgoing).toBe(shown.outgoing);
    expect(swap.state().incoming).toBe(shown.incoming);
  });

  it('a commit toward the other side out of a pulled-back fade leads in instead of dropping the old climb', () => {
    const swap = caughtSwap(40, 140);
    swap.drag(150);
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, settling: true });
    expect(swap.state().incoming).toBeGreaterThan(0.1);
    // Flicked toward page 2 while page 0 is still lit and page 1 dimmed.
    swap.commit(1);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 1, swapDir: 1, leadMs: 120, from: 1, dir: -1 });
    for (let frame = 0; frame < 15; frame++) swap.tick(8);
    // The old pair reached its leaving climb, whole, before the pair changed.
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, incoming: 0 });
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0 });
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('an onward drag during a swap lets it finish, then dims the arrived climb from whole', () => {
    const swap = caughtSwap(8, 0);
    swap.drag(-30);
    expect(swap.state().swapping).toBe(true);
    for (let frame = 0; frame < 24; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: false, settling: true, outgoing: 1 });
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(-30, SWIPE_THRESHOLD, false), 10);
    expect(largestStep(swap.frames.slice(-20))).toBeLessThan(JUMP);
  });

  it('crossing to the other side keeps a lit pair until its arriving climb is dark', () => {
    const swap = caughtSwap(96, 120);
    swap.drag(130);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, settling: true });
    swap.drag(-40);
    // The old climb is still lit, so the pair stays and the leaving side heads for whole.
    expect(swap.state().dir).toBe(-1);
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    swap.drag(-41);
    expect(swap.state().dir).toBe(1);
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(-41, SWIPE_THRESHOLD, false), 10);
    expect(largestStep(swap.frames.slice(1))).toBeLessThan(JUMP);
  });

  it('a JS-driven move shows the new climb at once, as before', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    swap.tick();
    swap.reset(5);
    expect(swap.state()).toMatchObject({ from: 5, dir: 0, outgoing: 1, incoming: 0, swapping: false });
  });

  it('never names a pair more than one page from the climb being left', () => {
    const swap = harness();
    for (const direction of [1, 1, -1, 1, -1, -1] as const) {
      swap.drag(direction * -90);
      swap.commit(direction);
      swap.tick();
      swap.land(direction * 30);
      swap.drag(0);
      for (let frame = 0; frame < 14; frame++) swap.tick();
      const { from } = swap.state();
      for (const frame of swap.frames) expect(Math.abs(frame.position - Math.round(frame.position))).toBeLessThan(0.5);
      expect(Math.abs(wallSwapPagePosition(swap.state()) - from)).toBeLessThanOrEqual(WALL_SWAP.pairLean);
    }
  });
});

describe('wall swap under Reduce Motion', () => {
  it('does not dim while dragging', () => {
    const swap = harness(true);
    swap.drag(-SWIPE_THRESHOLD * 2);
    expect(swap.state()).toMatchObject({ outgoing: 1, incoming: 0 });
  });

  it('compresses the same swap into a 120 ms dissolve', () => {
    const timing = swapTiming(1, true);
    expect(timing.durationMs).toBe(120);
    expect(timing.outgoingEndMs).toBe(72);
    expect(timing.incomingStartMs).toBeGreaterThanOrEqual(36);
    expect(swapWeightsAt(72, 1, 0, timing).outgoing).toBe(0);
    expect(swapWeightsAt(120, 1, 0, timing).incoming).toBe(1);
    const swap = harness(true);
    swap.drag(-20);
    // The fling's spring ends at once under Reduce Motion: it can land first.
    swap.commit(1);
    swap.land();
    expect(swap.state()).toMatchObject({ swapping: true, from: 0, dir: 1, outgoing: 1 });
    for (let frame = 0; frame < 8; frame++) swap.tick();
    expect(swap.state()).toMatchObject({ swapping: false, from: 1, dir: 0, outgoing: 1, incoming: 0 });
  });

  it('works out a landed fling’s direction from the anchor it left', () => {
    const swap = harness(true);
    const before = swap.state();
    const step = stepWallSwap(before, {
      anchor: -1,
      offset: 0,
      fling: 0,
      steps: 1,
      reset: 0,
      swapMs: 0,
      settleMs: 0,
      reduceMotion: true,
      commitDistance: SWIPE_THRESHOLD,
    });
    expect(step).toMatchObject({ startSwap: true, state: { from: 0, dir: -1, durationMs: 120 } });
  });
});

describe('wall swap shared holds', () => {
  /** Hold 3: shared between pages 0 and 1, outgoing-only from page 0 toward page -1. */
  const holdThree = (frame: Frame) => frame.holds.get(3);

  it('are whole at rest, follow the outgoing dim while dragging and never go below 40%', () => {
    expect(wallSwapSharedWeight(wallSwapRest(0, { anchor: 0, steps: 0, reset: 0 }), false)).toBe(1);
    const swap = harness();
    for (const offset of [-8, -20, -40, -60, -SWIPE_THRESHOLD, -SWIPE_THRESHOLD * 2, -40, 0]) swap.drag(offset);
    expect(swap.frames.map((frame) => frame.shared)).toEqual(swap.frames.map((frame) => frame.outgoing));
    expect(swap.frames[5].shared).toBeCloseTo(WALL_SWAP.dimFloor, 10);
    expect(swap.frames.map(holdThree)).toEqual(swap.frames.map((frame) => frame.shared));
    expect(swap.state()).toMatchObject({ dir: 0, outgoing: 1 });
    expect(swap.frames.at(-1)?.shared).toBe(1);
  });

  it('hold 40% through a swap until the incoming holds pass it, then come back with them', () => {
    const swap = harness();
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    let reachedFloor = false;
    let previous = 1;
    for (const frame of swap.frames.slice(1)) {
      expect(frame.shared).toBeGreaterThanOrEqual(WALL_SWAP.dimFloor);
      // Once at the floor, only up: never a second dip.
      if (reachedFloor) expect(frame.shared).toBeGreaterThanOrEqual(previous);
      if (frame.incoming <= WALL_SWAP.dimFloor && frame.outgoing <= WALL_SWAP.dimFloor) {
        expect(frame.shared).toBe(WALL_SWAP.dimFloor);
        reachedFloor = true;
      }
      if (frame.incoming > WALL_SWAP.dimFloor) expect(frame.shared).toBe(frame.incoming);
      previous = frame.shared;
    }
    expect(reachedFloor).toBe(true);
    expect(swap.state()).toMatchObject({ from: 1, dir: 0 });
    expect(swap.frames.at(-1)?.shared).toBe(1);
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('keep their weight when a pulled-back pair swaps outgoing and incoming', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let elapsed = 0; elapsed < 96; elapsed += 8) swap.tick(8);
    swap.land(140);
    for (const offset of [120, 100]) {
      swap.drag(offset);
      swap.tick(8);
    }
    const before = swap.frames.at(-1)!;
    swap.drag(110);
    const after = swap.frames.at(-1)!;
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, settling: true });
    expect([after.outgoing, after.incoming]).toEqual([before.incoming, before.outgoing]);
    expect(after.shared).toBe(before.shared);
    expect(after.shared).toBeGreaterThan(WALL_SWAP.dimFloor);
    // Pages 0 and 1 share hold 3 whichever way round the pair is named.
    expect(holdThree(after)).toBe(holdThree(before));
    for (let frame = 0; frame < 16; frame++) {
      swap.drag(170);
      swap.tick(8);
    }
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('switch pairs without a jump: a hold that changes kind keeps its weight', () => {
    const swap = harness();
    // Toward page -1 hold 3 is outgoing-only; toward page 1 it is shared.
    swap.drag(40);
    swap.drag(-40);
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 0, dir: 1, settling: false });
    expect(swap.frames.map(holdThree)).toEqual(swap.frames.map(() => dragOutgoingWeight(-40, SWIPE_THRESHOLD, false)));
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('stay whole under Reduce Motion, through the drag and the dissolve', () => {
    const swap = harness(true);
    swap.drag(-SWIPE_THRESHOLD * 2);
    swap.commit(1);
    for (let frame = 0; frame < 8; frame++) swap.tick(8);
    expect(swap.state().outgoing).toBeLessThan(1);
    expect(swap.state().incoming).toBeGreaterThan(0);
    for (let frame = 0; frame < 8; frame++) swap.tick(8);
    expect(swap.frames.every((frame) => frame.shared === 1 && holdThree(frame) === 1)).toBe(true);
    expect(wallSwapSharedWeight({ outgoing: 0.1, incoming: 0.2 }, true)).toBe(1);
  });

  it('stay within 40-100% and ignore which side is which', () => {
    for (const [outgoing, incoming, expected] of [
      [1, 0, 1],
      [0.7, 0, 0.7],
      [0.4, 0, 0.4],
      [0.1, 0.3, 0.4],
      [0, 0.6, 0.6],
      [0, 1, 1],
      [0.6, 0.2, 0.6],
      [Number.NaN, Number.NaN, 0.4],
      [2, 0, 1],
    ] as const) {
      expect(wallSwapSharedWeight({ outgoing, incoming }, false)).toBe(expected);
      expect(wallSwapSharedWeight({ outgoing: incoming, incoming: outgoing }, false)).toBe(expected);
    }
  });

  it('reach API 7 binaries as a fourth number and stay off API 6 ones', () => {
    const frame: WallSwapFrame = [4.25, 0.4, 0, 0.4];
    expect(WALL_SWAP_SHARED_NATIVE_API).toBe(7);
    expect(nativeWallSwapFrame(frame, 7)).toBe(frame);
    expect(nativeWallSwapFrame(frame, 8)).toEqual([4.25, 0.4, 0, 0.4]);
    // API 6 rejects anything but exactly three numbers, which would freeze the swap.
    expect(nativeWallSwapFrame(frame, 6)).toEqual([4.25, 0.4, 0]);
  });
});

describe('player reveal', () => {
  it('swaps on API 6 binaries and keeps the wipe on older ones', () => {
    expect(playerRevealMode(6)).toBe('swap');
    expect(playerRevealMode(7)).toBe('swap');
    expect(playerRevealMode(5)).toBe('wipe');
    expect(playerRevealMode(0)).toBe('wipe');
  });
});
