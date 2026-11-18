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
  const shared = wallSwapSharedWeight(state, reduceMotion, WALL_SWAP);
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
  let state: WallSwapState = wallSwapRest(0, input, WALL_SWAP);
  const frames: Frame[] = [];
  const apply = (changes: Partial<WallSwapInput>) => {
    input = { ...input, ...changes };
    const step = stepWallSwap(state, input, WALL_SWAP);
    state = step.state;
    if (step.startSwap) input = { ...input, swapMs: 0 };
    if (step.startSettleMs !== null) input = { ...input, settleMs: 0 };
    frames.push({
      outgoing: state.outgoing,
      incoming: state.incoming,
      shared: wallSwapSharedWeight(state, input.reduceMotion, WALL_SWAP),
      position: wallSwapPagePosition(state, WALL_SWAP),
      holds: holdWeights(state, input.reduceMotion),
    });
    return state;
  };
  return {
    drag: (offset: number) => apply({ offset }),
    /** The pager's startFling: a committed step and a fling toward `direction`. */
    commit: (direction: 1 | -1) => apply({ steps: input.steps + 1, fling: direction }),
    /** Reduce Motion: the fling's spring landed before the step reached the UI thread. */
    commitLanded: (direction: 1 | -1) =>
      apply({ steps: input.steps + 1, fling: 0, anchor: input.anchor + direction, offset: 0 }),
    /** landFling: the arriving page becomes the anchor; `carry` keeps a caught board's offset. */
    land: (carry = 0) => apply({ anchor: input.anchor + input.fling, fling: 0, offset: carry }),
    /** One frame on both clocks; they stop exactly at their ends, as withTiming does. */
    tick: (ms = 16) =>
      apply({
        swapMs: Math.min(input.swapMs + ms, swapClockMs(state)),
        settleMs: Math.min(input.settleMs + ms, state.settleDurationMs),
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

/** A board caught this far off the middle still shows mostly the climb it was leaving. */
const CAUGHT_CARRY = 300;

describe('wall swap drag', () => {
  it('dims outgoing-only holds linearly to 40% at the commit point and holds them there', () => {
    expect(dragOutgoingWeight(0, SWIPE_THRESHOLD, false, WALL_SWAP)).toBe(1);
    expect(dragOutgoingWeight(-SWIPE_THRESHOLD / 2, SWIPE_THRESHOLD, false, WALL_SWAP)).toBeCloseTo(0.7, 10);
    expect(dragOutgoingWeight(SWIPE_THRESHOLD, SWIPE_THRESHOLD, false, WALL_SWAP)).toBeCloseTo(0.4, 10);
    expect(dragOutgoingWeight(-SWIPE_THRESHOLD * 3, SWIPE_THRESHOLD, false, WALL_SWAP)).toBeCloseTo(0.4, 10);
  });

  it('shows nothing incoming and leans the pair toward the finger', () => {
    const swap = harness();
    swap.drag(-40);
    expect(swap.state()).toMatchObject({ from: 0, dir: 1, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.7, 10);
    expect(wallSwapPagePosition(swap.state(), WALL_SWAP)).toBe(WALL_SWAP.pairLean);
    for (const offset of [-20, -4, 0, 10, 30, 60, SWIPE_THRESHOLD]) swap.drag(offset);
    expect(swap.state()).toMatchObject({ dir: -1, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
    expect(wallSwapPagePosition(swap.state(), WALL_SWAP)).toBe(-WALL_SWAP.pairLean);
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
      [-30, -60, -90, -60, -20, -4, 0].map((offset) => dragOutgoingWeight(offset, SWIPE_THRESHOLD, false, WALL_SWAP)),
    );
    expect(swap.state()).toMatchObject({ dir: 0, outgoing: 1, incoming: 0 });
    expect(wallSwapPagePosition(swap.state(), WALL_SWAP)).toBe(0);
  });
});

describe('wall swap commit', () => {
  it('fades outgoing-only out over 0-120 ms and incoming-only in over 60-200 ms', () => {
    const timing = swapTiming(0.4, false, WALL_SWAP);
    expect(timing).toMatchObject({ durationMs: 200, outgoingEndMs: 120, incomingStartMs: 60 });
    expect(swapWeightsAt(0, 0.4, 0, timing, WALL_SWAP)).toEqual({ outgoing: 0.4, incoming: 0 });
    expect(swapWeightsAt(60, 0.4, 0, timing, WALL_SWAP).incoming).toBe(0);
    expect(swapWeightsAt(60, 0.4, 0, timing, WALL_SWAP).outgoing).toBeCloseTo(0.4 * (1 - easeIn(0.5, WALL_SWAP)), 10);
    expect(swapWeightsAt(120, 0.4, 0, timing, WALL_SWAP).outgoing).toBe(0);
    expect(swapWeightsAt(130, 0.4, 0, timing, WALL_SWAP).incoming).toBeCloseTo(easeOut(70 / 140, WALL_SWAP), 10);
    expect(swapWeightsAt(200, 0.4, 0, timing, WALL_SWAP)).toEqual({ outgoing: 0, incoming: 1 });
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
      const timing = swapTiming(startOutgoing, false, WALL_SWAP);
      expect(timing.durationMs).toBe(200);
      for (let elapsed = 0; elapsed <= 200; elapsed += 0.5) {
        const { outgoing, incoming } = swapWeightsAt(elapsed, startOutgoing, 0, timing, WALL_SWAP);
        if (incoming > 0) expect(outgoing).toBeLessThanOrEqual(WALL_SWAP.dimFloor);
        // The board is never empty of outgoing and incoming holds at once.
        expect(Math.max(outgoing, incoming)).toBeGreaterThan(0);
      }
    },
  );

  it('waits for a weakly dimmed flick to reach 40% before bringing anything in', () => {
    const timing = swapTiming(dragOutgoingWeight(-20, SWIPE_THRESHOLD, false, WALL_SWAP), false, WALL_SWAP);
    expect(timing.incomingStartMs).toBeGreaterThan(60);
    expect(timing.incomingStartMs).toBeLessThan(120);
    expect(swapTiming(1, false, WALL_SWAP).incomingStartMs).toBeCloseTo(88, 0);
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
    expect(wallSwapPagePosition(swap.state(), WALL_SWAP)).toBe(1 - WALL_SWAP.pairLean);
    for (const offset of [120, 140, 160, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170]) {
      swap.drag(offset);
      swap.tick(8);
    }
    expect(swap.state()).toMatchObject({ settling: false, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('a caught board flicked onward ends the running swap and starts the next from the skipped climb at 40%', () => {
    const swap = caughtSwap(40, 140);
    swap.drag(120);
    swap.tick(8);
    expect(swap.state()).toMatchObject({ swapping: true, from: 0, dir: 1 });
    expect(swap.state().incoming).toBeLessThan(1);
    swap.commit(1);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: true, leadMs: 0, incoming: 0 });
    expect(swap.state().outgoing).toBe(WALL_SWAP.dimFloor);
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0 });
  });

  it('a new fling after a natural landing ends the running swap the same way', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let frame = 0; frame < 3; frame++) swap.tick();
    swap.land(0);
    swap.commit(1);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: true, outgoing: WALL_SWAP.dimFloor, incoming: 0 });
  });

  it('a caught board held still lets the swap finish, then eases the arrived climb into its dim', () => {
    const swap = caughtSwap(40, 140);
    for (let frame = 0; frame < 20; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: false, settling: true, outgoing: 1 });
    for (let frame = 0; frame < 16; frame++) swap.tick(8);
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(140, SWIPE_THRESHOLD, false, WALL_SWAP), 10);
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
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(120, SWIPE_THRESHOLD, false, WALL_SWAP), 10);
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
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(-30, SWIPE_THRESHOLD, false, WALL_SWAP), 10);
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
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(-41, SWIPE_THRESHOLD, false, WALL_SWAP), 10);
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
      expect(Math.abs(wallSwapPagePosition(swap.state(), WALL_SWAP) - from)).toBeLessThanOrEqual(WALL_SWAP.pairLean);
    }
  });
});

describe('wall swap reversed by a commit mid-swap', () => {
  /** The holds and shared weight of the frame before the latest one, and of the latest. */
  function lastTwo(frames: Frame[]) {
    return { before: frames[frames.length - 2], after: frames[frames.length - 1] };
  }

  /**
   * After the frame at `fromIndex`, incoming-only holds never brighten while
   * outgoing-only ones are above 40%. A reversed pair may start with a residue
   * of incoming light, but it waits there.
   */
  function expectNoEarlyBrightening(frames: Frame[], fromIndex: number) {
    for (let index = fromIndex + 1; index < frames.length; index++) {
      if (frames[index].position !== frames[index - 1].position) continue;
      if (frames[index].outgoing > WALL_SWAP.dimFloor) {
        expect(frames[index].incoming).toBeLessThanOrEqual(frames[index - 1].incoming);
      }
    }
  }

  it('reproduces the logged fling back: no cut to the climb the swap had not shown', () => {
    // Logged as pages 10 and 11: [10.25, 0.4, 0] then [10.75, 1, 0].
    const swap = harness();
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    swap.land(CAUGHT_CARRY);
    expect(swap.frames.at(-1)).toMatchObject({ position: WALL_SWAP.pairLean, outgoing: 0.4, incoming: 0 });
    swap.commit(-1);
    const { before, after } = lastTwo(swap.frames);
    expect(after.position).toBe(1 - WALL_SWAP.pairLean);
    // Was [0.75, 1, 0]: page 1 whole in one frame, page 0's own holds gone.
    expect([after.outgoing, after.incoming]).toEqual([0, 0.4]);
    expect(after.holds).toEqual(before.holds);
    expect(after.shared).toBe(before.shared);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 1, swapDir: -1, leadMs: 0 });
    for (let frame = 0; frame < 10; frame++) swap.tick(8);
    swap.land();
    for (let frame = 0; frame < 20; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 0, dir: 0, outgoing: 1, incoming: 0, swapping: false });
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it.each([
    ['early, nothing arriving yet', 0],
    ['mid, both climbs partly lit', 96],
    ['late, the old climb gone and the new nearly whole', 184],
  ])('starts from the weights on screen, relabelled (%s)', (_label, ms) => {
    const swap = harness();
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    for (let elapsed = 0; elapsed < ms; elapsed += 8) swap.tick(8);
    swap.land(CAUGHT_CARRY);
    const shown = swap.state();
    if (ms === 96) {
      expect(shown.outgoing).toBeGreaterThan(0);
      expect(shown.incoming).toBeGreaterThan(0);
    }
    if (ms === 184) {
      expect(shown.outgoing).toBe(0);
      expect(shown.incoming).toBeGreaterThan(0.9);
    }
    swap.commit(-1);
    const commitIndex = swap.frames.length - 1;
    const { before, after } = lastTwo(swap.frames);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: true, swapFrom: 1, swapDir: -1, leadMs: 0 });
    expect([after.outgoing, after.incoming]).toEqual([shown.incoming, shown.outgoing]);
    expect(after.holds).toEqual(before.holds);
    expect(after.shared).toBe(before.shared);
    for (let frame = 0; frame < 10; frame++) swap.tick(8);
    swap.land();
    for (let frame = 0; frame < 20; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 0, dir: 0, outgoing: 1, incoming: 0, swapping: false });
    expectNoEarlyBrightening(swap.frames, commitIndex);
    for (const frame of swap.frames) expect(frame.shared).toBeGreaterThanOrEqual(WALL_SWAP.dimFloor);
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('during a lead-in, eases the pair on screen to the climb it heads back to and never shows the other', () => {
    const swap = caughtPulledBack();
    // Flicked toward page 2: a lead-in eases the pulled-back pair to page 1, whole.
    swap.commit(1);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 1, swapDir: 1, from: 1, dir: -1 });
    swap.tick(8);
    swap.tick(8);
    // Caught on page 2 and flicked straight back to page 1.
    swap.land(CAUGHT_CARRY);
    swap.commit(-1);
    const { before, after } = lastTwo(swap.frames);
    expect(after.holds).toEqual(before.holds);
    expect(after.shared).toBe(before.shared);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 2, swapDir: -1, from: 1, dir: -1 });
    for (let frame = 0; frame < 8; frame++) swap.tick(8);
    swap.land();
    for (let frame = 0; frame < 10; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: 0, outgoing: 1, incoming: 0, swapping: false });
    // Holds 7 and 8 are page 2's own: page 2 was never on screen.
    for (const frame of swap.frames) {
      expect(frame.holds.get(7) ?? 0).toBe(0);
      expect(frame.holds.get(8) ?? 0).toBe(0);
    }
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('a second flick onward out of that lead-in leads in to page 1, whole, then swaps', () => {
    const swap = caughtPulledBack();
    swap.commit(1);
    swap.tick(8);
    swap.land(CAUGHT_CARRY);
    swap.commit(-1);
    swap.tick(8);
    swap.land(-CAUGHT_CARRY);
    swap.commit(1);
    const { before, after } = lastTwo(swap.frames);
    expect(after.holds).toEqual(before.holds);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 1, swapDir: 1, from: 1, dir: -1 });
    for (let frame = 0; frame < 15; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, incoming: 0 });
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0 });
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
  });

  it('under Reduce Motion relabels the dissolve and keeps shared holds whole', () => {
    const swap = harness(true);
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    swap.tick(8);
    swap.tick(8);
    swap.land(CAUGHT_CARRY);
    const shown = swap.state();
    swap.commit(-1);
    const { before, after } = lastTwo(swap.frames);
    expect([after.outgoing, after.incoming]).toEqual([shown.incoming, shown.outgoing]);
    expect(after.holds).toEqual(before.holds);
    expect(swap.state()).toMatchObject({ swapping: true, from: 1, dir: -1, durationMs: 240 });
    swap.land();
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 0, dir: 0, outgoing: 1, incoming: 0, swapping: false });
    expect(swap.frames.every((frame) => frame.shared === 1)).toBe(true);
  });

  it('under Reduce Motion, a fling back that landed before its step still starts from the screen', () => {
    const swap = harness(true);
    swap.drag(-20);
    swap.commitLanded(1);
    swap.tick(8);
    swap.tick(8);
    const shown = swap.state();
    expect(shown.outgoing).toBeLessThan(1);
    swap.commitLanded(-1);
    const { before, after } = lastTwo(swap.frames);
    expect(swap.state()).toMatchObject({ swapping: true, swapFrom: 1, swapDir: -1, from: 1, dir: -1 });
    expect([after.outgoing, after.incoming]).toEqual([shown.incoming, shown.outgoing]);
    expect(after.holds).toEqual(before.holds);
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 0, dir: 0, outgoing: 1, incoming: 0, swapping: false });
  });

  /** A forward swap from page 0 caught on page 1 and pulled back toward page 0. */
  function caughtPulledBack() {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let elapsed = 0; elapsed < 40; elapsed += 8) swap.tick(8);
    swap.land(140);
    swap.drag(150);
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, settling: true, swapping: false });
    return swap;
  }
});

describe('wall swap onward commit mid-swap', () => {
  /** A forward swap from page 0, `ms` in on `frameMs` frames, caught on page 1 and flicked onward to page 2. */
  function onward(ms: number, frameMs = 8, reduceMotion = false) {
    const swap = harness(reduceMotion);
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    for (let elapsed = 0; elapsed < ms; elapsed += frameMs) swap.tick(frameMs);
    swap.land(CAUGHT_CARRY);
    const before = swap.frames.at(-1)!;
    swap.commit(1);
    return { swap, before, after: swap.frames.at(-1)!, commitIndex: swap.frames.length - 1 };
  }

  /** Every hold whose drawn weight changed between two frames, and by how much. */
  function holdSteps(before: Frame, after: Frame): Record<number, number> {
    const steps: Record<number, number> = {};
    for (const hold of new Set([...before.holds.keys(), ...after.holds.keys()])) {
      const step = (after.holds.get(hold) ?? 0) - (before.holds.get(hold) ?? 0);
      if (Math.abs(step) > 1e-12) steps[hold] = step;
    }
    return steps;
  }

  /** The native view draws a pair only within one page of its centre; the centre can be either. */
  function expectDrawableAround(frames: Frame[], centres: number[]) {
    for (const frame of frames) {
      for (const centre of centres) expect(Math.abs(frame.position - centre)).toBeLessThanOrEqual(1);
    }
  }

  /** Hold 5 is page 1's alone: the climb an onward fling from page 1 skips. */
  const skippedHold = (frame: Frame) => frame.holds.get(5) ?? 0;

  it('early: the skipped climb starts at 40%, the old climb’s own holds drop, nothing else moves', () => {
    const { swap, before, after, commitIndex } = onward(30, 10);
    expect(before.outgoing).toBeCloseTo(0.4 * (1 - easeIn(30 / 120, WALL_SWAP)), 10);
    expect(before.incoming).toBe(0);
    expect(swap.state()).toMatchObject({
      from: 1,
      dir: 1,
      swapping: true,
      swapFrom: 1,
      swapDir: 1,
      leadMs: 0,
      incoming: 0,
      durationMs: 200,
    });
    expect(swap.state().outgoing).toBe(WALL_SWAP.dimFloor);
    // Page 0's own holds (1, 2) go dark; page 1's own (5) and the one it
    // shares with page 2 (6) come up to 40%; holds 3 and 4 stay at 40%.
    expect(holdSteps(before, after)).toEqual({
      1: -before.outgoing,
      2: -before.outgoing,
      5: WALL_SWAP.dimFloor,
      6: WALL_SWAP.dimFloor,
    });
    expect(after.shared).toBe(before.shared);
    for (let frame = 0; frame < 24; frame++) swap.tick(8);
    expect(swap.state().swapping).toBe(true);
    // The second fling reaches the next climb at rest 200 ms after it commits.
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0, swapping: false });
    swap.land();
    swap.tick(8);
    const afterCommit = swap.frames.slice(commitIndex);
    expect(largestStep(afterCommit)).toBeLessThan(JUMP);
    for (const frame of afterCommit) expect(skippedHold(frame)).toBeLessThanOrEqual(WALL_SWAP.dimFloor);
    expectDrawableAround(swap.frames.slice(0, commitIndex), [0, 1]);
    expectDrawableAround(afterCommit, [1, 2]);
  });

  it('mid: a skipped climb partly lit below 40% comes up to 40%, with no jump', () => {
    const { swap, before, after, commitIndex } = onward(96);
    expect(before.outgoing).toBeGreaterThan(0);
    expect(before.incoming).toBeGreaterThan(0);
    expect(before.incoming).toBeLessThan(WALL_SWAP.dimFloor);
    expect(swap.state().outgoing).toBe(WALL_SWAP.dimFloor);
    expect(skippedHold(after) - skippedHold(before)).toBeCloseTo(WALL_SWAP.dimFloor - before.incoming, 10);
    for (let frame = 0; frame < 26; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1 });
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
    expectDrawableAround(swap.frames.slice(commitIndex), [1, 2]);
  });

  it('late: a skipped climb already above 40%, with the old climb gone, keeps its weight and only dims', () => {
    const { swap, before, after, commitIndex } = onward(160);
    expect(before.outgoing).toBe(0);
    expect(before.incoming).toBeGreaterThan(0.8);
    expect(swap.state().outgoing).toBe(before.incoming);
    // Same pixels: the pair changes, and nothing on the wall does.
    expect(holdSteps(before, after)).toEqual({});
    for (let frame = 0; frame < 26; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1 });
    const swapFrames = swap.frames.slice(commitIndex).filter((frame) => frame.position === 1 + WALL_SWAP.pairLean);
    expect(swapFrames.length).toBeGreaterThan(20);
    for (let index = 1; index < swapFrames.length; index++) {
      // Never brightened, and nothing arrives until it is down to 40%.
      expect(swapFrames[index].outgoing).toBeLessThanOrEqual(swapFrames[index - 1].outgoing);
      if (swapFrames[index].outgoing > WALL_SWAP.dimFloor) expect(swapFrames[index].incoming).toBe(0);
    }
    expect(largestStep(swap.frames)).toBeLessThan(JUMP);
    expectDrawableAround(swap.frames.slice(commitIndex), [1, 2]);
  });

  it('three quick flings: each skipped climb stays at 40% or less and every pair stays drawable', () => {
    const swap = harness();
    swap.drag(-SWIPE_THRESHOLD - 10);
    swap.commit(1);
    const commits = [0];
    for (let fling = 0; fling < 2; fling++) {
      for (let frame = 0; frame < 3; frame++) swap.tick(16);
      swap.land(CAUGHT_CARRY);
      swap.commit(1);
      commits.push(swap.frames.length - 1);
      expect(swap.state()).toMatchObject({ from: fling + 1, dir: 1, incoming: 0, outgoing: WALL_SWAP.dimFloor });
    }
    for (let frame = 0; frame < 26; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 3, dir: 0, outgoing: 1, incoming: 0 });
    expectDrawableAround(swap.frames.slice(1, commits[1]), [0, 1]);
    expectDrawableAround(swap.frames.slice(commits[1], commits[2]), [1, 2]);
    expectDrawableAround(swap.frames.slice(commits[2]), [2, 3]);
    // Holds 5 and 7 are pages 1 and 2 alone: both skipped.
    for (const frame of swap.frames) {
      expect(frame.holds.get(5) ?? 0).toBeLessThanOrEqual(WALL_SWAP.dimFloor);
      expect(frame.holds.get(7) ?? 0).toBeLessThanOrEqual(WALL_SWAP.dimFloor);
    }
    expect(largestStep(swap.frames.slice(commits[2]))).toBeLessThan(JUMP);
  });

  it('a fling back right after an onward one starts from the screen, relabelled', () => {
    const { swap, commitIndex } = onward(30, 10);
    swap.tick(8);
    swap.tick(8);
    swap.land(CAUGHT_CARRY);
    const shown = swap.state();
    swap.commit(-1);
    const [before, after] = swap.frames.slice(-2);
    expect(swap.state()).toMatchObject({ from: 2, dir: -1, swapping: true, swapFrom: 2, swapDir: -1, leadMs: 0 });
    expect([after.outgoing, after.incoming]).toEqual([shown.incoming, shown.outgoing]);
    expect(after.holds).toEqual(before.holds);
    for (let frame = 0; frame < 26; frame++) swap.tick(8);
    swap.land();
    swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 1, dir: 0, outgoing: 1, incoming: 0 });
    expect(largestStep(swap.frames.slice(commitIndex))).toBeLessThan(JUMP);
    expectDrawableAround(swap.frames.slice(commitIndex), [1, 2]);
  });

  it('a board caught after an onward fling and pulled back fades from the screen, with no jump', () => {
    const { swap, commitIndex } = onward(30, 10);
    for (let frame = 0; frame < 4; frame++) swap.tick(8);
    swap.land(140);
    for (const offset of [140, 142, 120, 100, 103]) {
      swap.drag(offset);
      swap.tick(8);
      expect(swap.state().swapping).toBe(true);
    }
    swap.drag(106);
    const [before, after] = swap.frames.slice(-2);
    expect(swap.state()).toMatchObject({ from: 2, dir: -1, swapping: false, settling: true });
    expect(after.holds).toEqual(before.holds);
    for (let frame = 0; frame < 16; frame++) {
      swap.drag(170);
      swap.tick(8);
    }
    expect(swap.state()).toMatchObject({ settling: false, incoming: 0 });
    expect(largestStep(swap.frames.slice(commitIndex))).toBeLessThan(JUMP);
    expectDrawableAround(swap.frames.slice(commitIndex), [1, 2]);
  });

  it('a JS-driven move during the onward swap shows the new climb at once', () => {
    const { swap } = onward(30, 10);
    swap.tick(8);
    swap.reset(5);
    expect(swap.state()).toMatchObject({ from: 5, dir: 0, outgoing: 1, incoming: 0, swapping: false });
  });

  it('under Reduce Motion the dissolve starts from the same 40% state, shared holds whole', () => {
    // No drag dim: page 0 is still bright when the onward fling commits.
    const { swap, before, after } = onward(40, 8, true);
    expect(before.outgoing).toBeCloseTo(1 - 40 / 240, 10);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, incoming: 0, durationMs: 240 });
    expect(swap.state().outgoing).toBe(WALL_SWAP.dimFloor);
    // Hold 3 is shared by pages 0 and 1 (whole) and page 1's own toward page 2;
    // hold 6 is shared by pages 1 and 2, so it is whole.
    expect(holdSteps(before, after)).toEqual({
      1: -before.outgoing,
      2: -before.outgoing,
      3: WALL_SWAP.dimFloor - 1,
      5: WALL_SWAP.dimFloor - before.incoming,
      6: 1 - before.incoming,
    });
    for (let frame = 0; frame < 30; frame++) swap.tick(8);
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, swapping: false });
    expect(swap.frames.every((frame) => frame.shared === 1)).toBe(true);
  });
});

describe('wall swap under Reduce Motion', () => {
  it('does not dim while dragging', () => {
    const swap = harness(true);
    swap.drag(-SWIPE_THRESHOLD * 2);
    expect(swap.state()).toMatchObject({ outgoing: 1, incoming: 0 });
  });

  it.each([60, 120])('crossfades linearly over 240 ms with weight steps under 0.08 at %i Hz', (frameRate) => {
    const swap = harness(true);
    swap.drag(-20);
    swap.commitLanded(1);
    expect(swap.state()).toMatchObject({ swapping: true, from: 0, dir: 1, outgoing: 1, durationMs: 240 });
    const frameMs = 1000 / frameRate;
    for (let frame = 1; frame * frameMs < 240; frame++) {
      swap.tick(frameMs);
      expect(swap.state().outgoing).toBeCloseTo(1 - (frame * frameMs) / 240, 10);
      expect(swap.state().incoming).toBeCloseTo((frame * frameMs) / 240, 10);
    }
    swap.tick(frameMs);
    expect(swap.state()).toMatchObject({ swapping: false, from: 1, dir: 0, outgoing: 1, incoming: 0 });
    expect(largestStep(swap.frames)).toBeLessThanOrEqual(0.08);
  });

  it('settles and leads in linearly after an interrupted dissolve', () => {
    const swap = harness(true);
    swap.drag(-90);
    swap.commit(1);
    swap.tick(80);
    swap.land(140);
    const shown = swap.drag(150);
    expect(shown).toMatchObject({ from: 1, dir: -1, settling: true, settleDurationMs: 240 });

    const halfway = swap.tick(120);
    expect(halfway.outgoing).toBeCloseTo((shown.outgoing + 1) / 2, 10);
    expect(halfway.incoming).toBeCloseTo(shown.incoming / 2, 10);
    expect(swap.commit(1)).toMatchObject({ from: 1, dir: -1, leadMs: 240 });
    const leadHalfway = swap.tick(120);
    expect(leadHalfway.outgoing).toBeCloseTo((halfway.outgoing + 1) / 2, 10);
    expect(leadHalfway.incoming).toBeCloseTo(halfway.incoming / 2, 10);
    expect(swap.tick(120)).toMatchObject({ from: 1, dir: 1, outgoing: 1, incoming: 0 });
    swap.land();
    expect(swap.tick(240)).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0, swapping: false });
  });

  it('works out a landed fling’s direction from the anchor it left', () => {
    const swap = harness(true);
    const before = swap.state();
    const step = stepWallSwap(
      before,
      {
        anchor: -1,
        offset: 0,
        fling: 0,
        steps: 1,
        reset: 0,
        swapMs: 0,
        settleMs: 0,
        reduceMotion: true,
        commitDistance: SWIPE_THRESHOLD,
      },
      WALL_SWAP,
    );
    expect(step).toMatchObject({ startSwap: true, state: { from: 0, dir: -1, durationMs: 240 } });
  });
});

describe('wall swap shared holds', () => {
  /** Hold 3: shared between pages 0 and 1, outgoing-only from page 0 toward page -1. */
  const holdThree = (frame: Frame) => frame.holds.get(3);

  it('are whole at rest, follow the outgoing dim while dragging and never go below 40%', () => {
    expect(wallSwapSharedWeight(wallSwapRest(0, { anchor: 0, steps: 0, reset: 0 }, WALL_SWAP), false, WALL_SWAP)).toBe(
      1,
    );
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
    expect(swap.frames.map(holdThree)).toEqual(
      swap.frames.map(() => dragOutgoingWeight(-40, SWIPE_THRESHOLD, false, WALL_SWAP)),
    );
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
    expect(wallSwapSharedWeight({ outgoing: 0.1, incoming: 0.2 }, true, WALL_SWAP)).toBe(1);
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
      expect(wallSwapSharedWeight({ outgoing, incoming }, false, WALL_SWAP)).toBe(expected);
      expect(wallSwapSharedWeight({ outgoing: incoming, incoming: outgoing }, false, WALL_SWAP)).toBe(expected);
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
