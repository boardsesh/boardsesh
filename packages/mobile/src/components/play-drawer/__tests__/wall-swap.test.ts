import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import {
  dragOutgoingWeight,
  easeIn,
  easeOut,
  playerRevealMode,
  stepWallSwap,
  swapTiming,
  swapWeightsAt,
  WALL_SWAP,
  wallSwapPagePosition,
  wallSwapRest,
  type WallSwapInput,
  type WallSwapState,
} from '../wall-swap';

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
    const pages = new Map([[state.from, state.outgoing]]);
    if (state.dir !== 0) pages.set(state.from + state.dir, state.incoming);
    frames.push({ outgoing: state.outgoing, incoming: state.incoming, position: wallSwapPagePosition(state), pages });
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
        swapMs: Math.min(input.swapMs + ms, state.durationMs),
        settleMs: Math.min(input.settleMs + ms, WALL_SWAP.settleMs),
      }),
    reset: (anchor: number) => apply({ anchor, offset: 0, fling: 0, reset: input.reset + 1 }),
    state: () => state,
    frames,
  };
}

/** One frame: the weights, the pair's page position, and each paired climb's class weight. */
type Frame = { outgoing: number; incoming: number; position: number; pages: Map<number, number> };

/**
 * The largest change from one frame to the next in any climb's class weight. A
 * climb leaving the pair must be dark (its partner whole) when it goes.
 */
function largestStep(frames: Frame[]) {
  let largest = 0;
  for (let index = 1; index < frames.length; index++) {
    const before = frames[index - 1].pages;
    const after = frames[index].pages;
    for (const page of new Set([...before.keys(), ...after.keys()])) {
      // A climb outside the pair is dark, unless it is the one on show alone.
      const weight = (pages: Map<number, number>) => pages.get(page) ?? 0;
      largest = Math.max(largest, Math.abs(weight(after) - weight(before)));
    }
  }
  return largest;
}

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
  it('a reversal mid-swap fades from the weights on screen with no jump', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let frame = 0; frame < 5; frame++) swap.tick();
    const before = swap.state();
    expect(before.outgoing).toBeGreaterThan(0);
    expect(before.incoming).toBeGreaterThan(0);
    // Caught mid-fling: the pager carries the arriving board's offset, which
    // still leans back toward the climb being left.
    swap.land(140);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: false, settling: true });
    expect(swap.state().outgoing).toBe(before.incoming);
    expect(swap.state().incoming).toBe(before.outgoing);
    expect(wallSwapPagePosition(swap.state())).toBe(1 - WALL_SWAP.pairLean);
    for (const offset of [150, 160, 170, 170, 170, 165, 165, 165, 165, 165]) {
      swap.drag(offset);
      swap.tick();
    }
    expect(swap.state()).toMatchObject({ settling: false, incoming: 0 });
    expect(swap.state().outgoing).toBeCloseTo(0.4, 10);
    expect(largestStep(swap.frames)).toBeLessThan(0.2);
  });

  it('a commit after a reversal starts from where the weights are', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let frame = 0; frame < 5; frame++) swap.tick();
    swap.land(140);
    swap.drag(160);
    swap.tick();
    const shown = swap.state();
    swap.commit(-1);
    expect(swap.state()).toMatchObject({ from: 1, dir: -1, swapping: true });
    expect(swap.state().outgoing).toBe(shown.outgoing);
    expect(swap.state().incoming).toBe(shown.incoming);
  });

  it('a new fling during a swap snaps the running swap to its end before starting the next', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let frame = 0; frame < 3; frame++) swap.tick();
    expect(swap.state().incoming).toBeLessThan(1);
    // Caught after the arriving board stopped, then flicked onward.
    swap.land(0);
    swap.commit(1);
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: true, outgoing: 1, incoming: 0 });
    for (let frame = 0; frame < 13; frame++) swap.tick();
    swap.land();
    swap.tick();
    expect(swap.state()).toMatchObject({ from: 2, dir: 0, outgoing: 1, incoming: 0 });
  });

  it('an onward drag during a swap lets it finish, then dims the arrived climb from whole', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    swap.tick();
    swap.land(0);
    swap.drag(-30);
    expect(swap.state().swapping).toBe(true);
    for (let frame = 0; frame < 12; frame++) swap.tick();
    expect(swap.state()).toMatchObject({ from: 1, dir: 1, swapping: false, settling: true, outgoing: 1 });
    for (let frame = 0; frame < 9; frame++) swap.tick();
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(-30, SWIPE_THRESHOLD, false), 10);
    expect(largestStep(swap.frames.slice(-10))).toBeLessThan(0.2);
  });

  it('crossing to the other side keeps a lit pair until its arriving climb is dark', () => {
    const swap = harness();
    swap.drag(-90);
    swap.commit(1);
    for (let frame = 0; frame < 6; frame++) swap.tick();
    swap.land(120);
    swap.drag(-40);
    // The old climb is still lit, so the pair stays and the outgoing side heads for whole.
    expect(swap.state().dir).toBe(-1);
    for (let frame = 0; frame < 10; frame++) swap.tick();
    swap.drag(-41);
    expect(swap.state().dir).toBe(1);
    for (let frame = 0; frame < 9; frame++) swap.tick();
    expect(swap.state().outgoing).toBeCloseTo(dragOutgoingWeight(-41, SWIPE_THRESHOLD, false), 10);
    expect(largestStep(swap.frames.slice(1))).toBeLessThan(0.2);
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

describe('player reveal', () => {
  it('swaps on API 6 binaries and keeps the wipe on older ones', () => {
    expect(playerRevealMode(6)).toBe('swap');
    expect(playerRevealMode(7)).toBe('swap');
    expect(playerRevealMode(5)).toBe('wipe');
    expect(playerRevealMode(0)).toBe('wipe');
  });
});
