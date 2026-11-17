import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardTransitionDriver, BoardTransitionState } from '../../play-drawer/board-transition';
import { shippedSwapFrame, type BoardSwapFrame } from '../../play-drawer/swap-look';
import { WALL_SWAP, wallSwapDriver, type WallSwapInput } from '../../play-drawer/wall-swap';
import type { BoardMotionVariant, ParamValues } from '../types';
import { BOARD_MOTION_VARIANTS } from '../variants';
import {
  ARRIVES_CALM,
  ARRIVES_FROM_LEFT,
  ARRIVES_FROM_RIGHT,
  arrivalCode,
  LEAVING,
  NOT_SHOWN,
  runTuning,
  swapLookDriver,
} from '../variants/look-driver';
import { lookTransition, lookVariantDefaults, lookVariantTuning, SWAP_LOOK_LAB_MODE } from '../variants/look-variant';

type Operation =
  | { drag: number }
  | { commit: 1 | -1 }
  | { land: number }
  | { tick: number }
  | { reset: number }
  | { reduceMotion: boolean };

const ticks = (count: number, ms = 8): Operation[] => Array.from({ length: count }, () => ({ tick: ms }));

/** Drives `driver` with a pager and the two clocks the way use-wall-swap does; every frame. */
function run(operations: readonly Operation[], driver: BoardTransitionDriver, reduceMotion = false) {
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
  let state: BoardTransitionState = driver.rest(input);
  let swapEnd = 0;
  let settleEnd = 0;
  const frames: BoardSwapFrame[] = [];
  for (const operation of operations) {
    if ('drag' in operation) input = { ...input, offset: operation.drag };
    if ('commit' in operation) input = { ...input, steps: input.steps + 1, fling: operation.commit };
    if ('land' in operation) input = { ...input, anchor: input.anchor + input.fling, fling: 0, offset: operation.land };
    if ('tick' in operation) {
      input = {
        ...input,
        swapMs: Math.min(input.swapMs + operation.tick, swapEnd),
        settleMs: Math.min(input.settleMs + operation.tick, settleEnd),
      };
    }
    if ('reset' in operation)
      input = { ...input, anchor: operation.reset, offset: 0, fling: 0, reset: input.reset + 1 };
    if ('reduceMotion' in operation) input = { ...input, reduceMotion: operation.reduceMotion };
    const step = driver.step(state, input);
    state = step.state;
    frames.push(step.frame);
    if (step.startSwapMs !== null) {
      swapEnd = step.startSwapMs;
      input = { ...input, swapMs: 0 };
    }
    if (step.startSettleMs !== null) {
      settleEnd = step.startSettleMs;
      input = { ...input, settleMs: 0 };
    }
  }
  return frames;
}

/** Each page a frame shows: its weight and arrival flag. The nearest page is the one being left. */
function pages(frame: BoardSwapFrame): Map<number, { weight: number; arrives: number }> {
  const from = Math.round(frame[0]);
  const dir = Math.sign(frame[0] - from);
  const shown = new Map([[from, { weight: frame[1], arrives: frame.length === 6 ? frame[4] : 0 }]]);
  if (dir !== 0) shown.set(from + dir, { weight: frame[2], arrives: frame.length === 6 ? frame[5] : 0 });
  return shown;
}

/** The sequences the shipped driver's own tests walk, as operations. */
const SEQUENCES: Record<string, readonly Operation[]> = {
  'drag and cancel': [-30, -60, -90, -60, -20, -4, 0].map((drag) => ({ drag })),
  'drag across the middle': [{ drag: -40 }, { drag: SWIPE_THRESHOLD }, ...ticks(8), { drag: 0 }, ...ticks(20)],
  'commit and land': [{ drag: -SWIPE_THRESHOLD - 10 }, { commit: 1 }, ...ticks(6, 16), { land: 0 }, ...ticks(40, 16)],
  'caught and pulled back': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(5),
    { land: 140 },
    ...[140, 142, 120, 100, 103, 106, 120, 140, 160, 170].flatMap((drag): Operation[] => [{ drag }, { tick: 8 }]),
    ...ticks(60),
  ],
  'caught and flicked onward': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(5),
    { land: 140 },
    { drag: 120 },
    { tick: 8 },
    { commit: 1 },
    ...ticks(60),
    { land: 0 },
    ...ticks(60),
  ],
  'reversed mid-swap': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(10),
    { commit: -1 },
    ...ticks(60),
    { land: 0 },
    ...ticks(60),
  ],
  'reversed during a lead-in, then onward again': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(5),
    { land: 140 },
    { drag: 150 },
    { tick: 8 },
    { commit: 1 },
    ...ticks(3),
    { commit: -1 },
    ...ticks(3),
    { commit: 1 },
    ...ticks(80),
  ],
  'three quick flicks': [
    { drag: -20 },
    { commit: 1 },
    ...ticks(3),
    { land: 0 },
    { drag: -20 },
    { commit: 1 },
    ...ticks(3),
    { land: 0 },
    { drag: -20 },
    { commit: 1 },
    ...ticks(60),
    { land: 0 },
    ...ticks(60),
  ],
  'a JS-driven move mid-swap': [{ drag: -90 }, { commit: 1 }, ...ticks(4), { reset: 5 }, ...ticks(4)],
};

function randomWalk(seed: number, length: number): Operation[] {
  let value = seed;
  const random = () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
  const operations: Operation[] = [];
  for (let index = 0; index < length; index++) {
    const roll = random();
    if (roll < 0.3) operations.push({ drag: Math.round((random() * 2 - 1) * 400) });
    else if (roll < 0.4) operations.push({ commit: random() < 0.7 ? 1 : -1 });
    else if (roll < 0.47) operations.push({ land: random() < 0.6 ? 0 : Math.round((random() * 2 - 1) * 300) });
    else if (roll < 0.49) operations.push({ reset: Math.round(random() * 10) });
    else operations.push({ tick: [4, 8, 16.67][Math.floor(random() * 3)] });
  }
  return operations;
}

function defaults(variant: BoardMotionVariant): ParamValues {
  return Object.fromEntries(variant.params.map((spec) => [spec.key, spec.default]));
}

const LOOK_VARIANTS = BOARD_MOTION_VARIANTS.filter((variant) => variant.requiresNativeLab === SWAP_LOOK_LAB_MODE);

/** The full tuning `variant` runs with `params`, curves included. */
function tuningOf(variant: BoardMotionVariant, params: ParamValues = defaults(variant)) {
  const base = lookVariantDefaults(variant);
  if (!base) throw new Error(`${variant.id} is not a look variant`);
  return lookVariantTuning(params, base);
}

function lookDriverOf(variant: BoardMotionVariant, params: ParamValues = defaults(variant)): BoardTransitionDriver {
  const { driver } = variant.createTransition(params);
  if (!driver) throw new Error(`${variant.id} has no driver`);
  return driver;
}

/** Leaving, arriving from either edge, either calm or not. */
const ARRIVAL_CODES = [
  LEAVING,
  ARRIVES_FROM_RIGHT,
  ARRIVES_FROM_LEFT,
  ARRIVES_FROM_RIGHT + ARRIVES_CALM,
  ARRIVES_FROM_LEFT + ARRIVES_CALM,
];

/**
 * The look's invariants on every frame: weights in range, the shared floor
 * never below the variant's, and a climb already on screen changing its
 * arrival flag only while its weight is 0 or 1 (so the native look's pixels
 * cannot jump).
 */
function expectLookInvariants(frames: readonly BoardSwapFrame[], sharedFloor: number) {
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    expect(frame).toHaveLength(6);
    for (const weight of [frame[1], frame[2], frame[3]]) {
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
    expect(frame[3]).toBeGreaterThanOrEqual(sharedFloor - 1e-9);
    if (frame.length === 6) expect(ARRIVAL_CODES).toContain(frame[4]);
    if (frame.length === 6) expect(ARRIVAL_CODES).toContain(frame[5]);
    if (index === 0) continue;
    const before = pages(frames[index - 1]);
    for (const [page, now] of pages(frame)) {
      const then = before.get(page);
      if (then && then.arrives !== now.arrives) expect([0, 1]).toContain(now.weight);
    }
  }
}

describe('swap look driver', () => {
  it('lists I and J first, then D to H, each needing the native swap look and API 7', () => {
    expect(LOOK_VARIANTS.map((variant) => variant.letter)).toEqual(['I', 'J', 'D', 'E', 'F', 'G', 'H']);
    for (const variant of LOOK_VARIANTS) {
      expect(variant.requiresNativeApi).toBe(7);
      const transition = variant.createTransition(defaults(variant));
      expect(transition.revealMode).toBe('swap');
      expect(transition.look?.floor).toBe(defaults(variant).dimFloor);
      expect(tuningOf(variant).dimFloor).toBe(defaults(variant).dimFloor);
    }
  });

  it('ties the look floor to the drag floor and follows its sliders', () => {
    const cascade = LOOK_VARIANTS.find((variant) => variant.id === 'sideways-cascade');
    if (!cascade) throw new Error('no cascade');
    const look = cascade.createTransition({ ...defaults(cascade), dimFloor: 0.3, holdWindow: 0.6 }).look;
    expect(look).toMatchObject({ floor: 0.3, holdWindow: 0.6, climbUp: false });
    const climbUp = LOOK_VARIANTS.find((variant) => variant.id === 'climb-up');
    expect(climbUp?.createTransition({ ...defaults(climbUp), climbUp: 0 }).look?.climbUp).toBe(false);
    expect(climbUp?.createTransition(defaults(climbUp)).look?.climbUp).toBe(true);
  });

  it.each(LOOK_VARIANTS.map((variant) => [variant.letter, variant] as const))(
    '%s keeps the look invariants through every scripted sequence and a long random walk',
    (_letter, variant) => {
      const params = defaults(variant);
      const sharedFloor = params.sharedFloor;
      for (const operations of [...Object.values(SEQUENCES), randomWalk(11, 2500)]) {
        expectLookInvariants(run(operations, lookDriverOf(variant)), sharedFloor);
      }
    },
  );

  it.each(LOOK_VARIANTS.map((variant) => [variant.letter, variant] as const))(
    '%s ends every sequence at rest: one climb whole, shared floor settled, nothing arriving',
    (_letter, variant) => {
      const endsLifted = [
        'drag and cancel',
        'drag across the middle',
        'commit and land',
        'caught and flicked onward',
        'reversed mid-swap',
        'three quick flicks',
      ];
      for (const name of endsLifted) {
        const last = run(SEQUENCES[name], lookDriverOf(variant)).at(-1);
        expect(last?.[1]).toBe(1);
        expect(last?.[2]).toBe(0);
        expect(Number.isInteger(last?.[0])).toBe(true);
        expect(last?.slice(4)).toEqual([0, 0]);
        // A commit within the run window (a reversal or an onward flick too) keeps shared holds whole until the next.
        expect([defaults(variant).sharedFloor, 1]).toContain(last?.[3]);
      }
      expect(run(SEQUENCES['a JS-driven move mid-swap'], lookDriverOf(variant)).at(-1)?.slice(0, 3)).toEqual([5, 1, 0]);
    },
  );

  it('without ghosts, the side weights are exactly the shipped machine with the variant’s tuning', () => {
    for (const variant of LOOK_VARIANTS.filter((candidate) => !lookVariantDefaults(candidate)?.ghostDrag)) {
      const params = { ...defaults(variant), runWindowMs: 0 };
      const tuning = tuningOf(variant, params);
      for (const operations of [...Object.values(SEQUENCES), randomWalk(5, 1500)]) {
        const look = run(operations, lookDriverOf(variant, params));
        const shipped = run(operations, wallSwapDriver(tuning));
        expect(look.map((frame) => frame.slice(0, 3))).toEqual(shipped.map((frame) => frame.slice(0, 3)));
      }
    }
  });

  it('marks the arriving climb from the first drag frame and drops the mark once it is whole', () => {
    const variant = LOOK_VARIANTS[0];
    const frames = run(
      [{ drag: -40 }, { drag: -90 }, { commit: 1 }, ...ticks(40), { land: 0 }, ...ticks(40)],
      lookDriverOf(variant),
    );
    expect(frames[0].slice(4)).toEqual([LEAVING, ARRIVES_FROM_RIGHT]);
    // Previous: the climb on the left comes in from the left edge.
    expect(run([{ drag: 40 }], lookDriverOf(variant))[0].slice(4)).toEqual([LEAVING, ARRIVES_FROM_LEFT]);
    const arrived = frames.at(-1);
    expect(arrived?.slice(0, 3)).toEqual([1, 1, 0]);
    expect(arrived?.slice(4)).toEqual([0, 0]);
  });

  it('a reversal mid-swap keeps every climb’s weight and flag: the same pixels, played back', () => {
    for (const variant of LOOK_VARIANTS) {
      for (const ms of [0, 40, 96, 160]) {
        const operations: Operation[] = [{ drag: -90 }, { commit: 1 }, ...ticks(ms / 8), { land: 140 }, { commit: -1 }];
        const frames = run(operations, lookDriverOf(variant));
        const before = pages(frames[frames.length - 2]);
        const after = pages(frames[frames.length - 1]);
        for (const [page, shown] of after) {
          const previous = before.get(page);
          if (!previous) {
            expect(shown.weight).toBe(0);
            continue;
          }
          expect(shown.weight).toBeCloseTo(previous.weight, 12);
          // A dark or whole climb looks the same either way; anything between keeps its rules.
          if (shown.weight > 0 && shown.weight < 1) expect(shown.arrives).toBe(previous.arrives);
        }
        expect(frames.at(-1)?.[3]).toBeCloseTo(frames[frames.length - 2][3], 12);
      }
    }
  });

  it('E shows the next climb as a ghost while dragging, carries it into the swap and takes it back on a cancel', () => {
    const ghost = LOOK_VARIANTS.find((variant) => variant.id === 'ghost-peek');
    if (!ghost) throw new Error('no ghost peek');
    expect(lookVariantDefaults(ghost)?.calmRuns).toBe(true);
    const floor = defaults(ghost).dimFloor;
    const dragged = run([{ drag: -40 }, { drag: -SWIPE_THRESHOLD }], lookDriverOf(ghost));
    expect(dragged[0][2]).toBeCloseTo(floor / 2, 6);
    expect(dragged[1][2]).toBeCloseTo(floor, 6);
    expect(dragged[1].slice(4)).toEqual([0, 1]);
    // 160 ms: inside the 180 ms fill, so the pair is still the one dragged.
    const committed = run([{ drag: -SWIPE_THRESHOLD }, { commit: 1 }, ...ticks(20)], lookDriverOf(ghost));
    expect(committed[1][2]).toBeCloseTo(floor, 6);
    for (let index = 2; index < committed.length; index++) {
      expect(committed[index][2]).toBeGreaterThanOrEqual(committed[index - 1][2] - 1e-9);
    }
    const cancelled = run(
      [-40, -80, -40, -10, 0].map((drag) => ({ drag })),
      lookDriverOf(ghost),
    );
    expect(cancelled.at(-1)?.slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('a flick run keeps shared holds whole, easing the floor up rather than jumping', () => {
    const strike = LOOK_VARIANTS.find((variant) => variant.id === 'led-strike');
    if (!strike) throw new Error('no LED strike');
    const params = defaults(strike);
    expect(params.sharedFloor).toBeLessThan(1);
    const frames = run(SEQUENCES['three quick flicks'], lookDriverOf(strike));
    expect(frames.at(-1)?.[3]).toBe(1);
    for (let index = 1; index < frames.length; index++) {
      expect(Math.abs(frames[index][3] - frames[index - 1][3])).toBeLessThan(0.1);
    }
    const slow = run(
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
      lookDriverOf(strike),
    );
    expect(slow.at(-1)?.[3]).toBe(params.sharedFloor);
  });

  it('gives every look variant a Bold preset over its own sliders, inside their ranges', () => {
    for (const variant of LOOK_VARIANTS) {
      const bold = variant.boldParams;
      if (!bold) throw new Error(`${variant.id} has no Bold preset`);
      expect(Object.keys(bold).sort()).toEqual(variant.params.map((spec) => spec.key).sort());
      for (const spec of variant.params) {
        expect(bold[spec.key]).toBeGreaterThanOrEqual(spec.min);
        expect(bold[spec.key]).toBeLessThanOrEqual(spec.max);
      }
      expect(bold).not.toEqual(defaults(variant));
      // Where Bold asks for it, the side weights are linear and each hold eases itself.
      if (bold.linear === 1) expect(tuningOf(variant, bold).easeOut).toEqual([0, 0, 1, 1]);
      const look = variant.createTransition(bold).look;
      expect(look?.arrivalFloor).toBe((look?.floor ?? 0) * (bold.arrivalFloorShare ?? 1));
    }
  });

  it.each(LOOK_VARIANTS.map((variant) => [variant.letter, variant] as const))(
    '%s on Bold keeps the look invariants and ends every swipe at rest',
    (_letter, variant) => {
      const bold = variant.boldParams ?? {};
      for (const operations of [...Object.values(SEQUENCES), randomWalk(23, 2500)]) {
        expectLookInvariants(run(operations, lookDriverOf(variant, bold)), bold.sharedFloor);
      }
      for (const name of ['drag and cancel', 'commit and land', 'reversed mid-swap', 'three quick flicks']) {
        const last = run(SEQUENCES[name], lookDriverOf(variant, bold)).at(-1);
        expect(last?.slice(1, 3)).toEqual([1, 0]);
        expect(last?.slice(4)).toEqual([0, 0]);
      }
    },
  );

  it('on Bold, a flick onward mid-swap keeps the skipped climb at its weight on screen', () => {
    // One front for the arriving climb is not uniform at the drag floor, so the
    // machine's "at least the floor" restart would jump; the driver keeps the screen.
    const keepers = LOOK_VARIANTS.filter((candidate) => (candidate.boldParams?.arrivalFloorShare ?? 1) < 1);
    expect(keepers.map((variant) => variant.letter)).toEqual(['D', 'F', 'G']);
    for (const variant of keepers) {
      const frames = run(
        [{ drag: -90 }, { commit: 1 }, ...ticks(10), { land: 140 }, { drag: 120 }, { commit: 1 }, ...ticks(4)],
        lookDriverOf(variant, variant.boldParams),
      );
      const commitIndex = frames.length - 5;
      const skipped = pages(frames[commitIndex - 1]).get(1);
      const restarted = pages(frames[commitIndex]).get(1);
      expect(skipped?.weight).toBeLessThan(defaults(variant).dimFloor);
      expect(restarted?.weight).toBeCloseTo(skipped?.weight ?? -1, 12);
      expect(restarted?.arrives).toBe(skipped?.arrives);
    }
  });

  it('a flick run can shorten the swap', () => {
    expect(runTuning(WALL_SWAP, 100)).toMatchObject({ durationMs: 100, outgoingEndMs: 60, incomingStartMs: 30 });
    expect(runTuning(WALL_SWAP, 0)).toBe(WALL_SWAP);
  });

  it('under Reduce Motion is the shipped dissolve: four numbers, no look', () => {
    for (const variant of LOOK_VARIANTS) {
      const tuning = tuningOf(variant);
      for (const operations of Object.values(SEQUENCES)) {
        const frames = run(operations, lookDriverOf(variant), true);
        for (const frame of frames) expect(frame).toHaveLength(4);
        expect(frames).toEqual(run(operations, wallSwapDriver(tuning), true));
      }
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

  it('a quick re-flick keeps the skipped climb’s entry edge, so its front never flips side', () => {
    let checked = 0;
    for (const variant of LOOK_VARIANTS) {
      for (const ms of [16, 48, 80, 104, 160]) {
        const frames = run(
          [{ drag: -90 }, { commit: 1 }, ...ticks(ms / 8), { land: 140 }, { drag: 120 }, { commit: 1 }, ...ticks(2)],
          lookDriverOf(variant),
        );
        const before = pages(frames[frames.length - 4]).get(1);
        const after = pages(frames[frames.length - 3]).get(1);
        if (before && after && before.weight > 0 && before.weight < 1 && after.weight > 0 && after.weight < 1) {
          expect(after.arrives & 3).toBe(ARRIVES_FROM_RIGHT);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('I and E keep a flick run calm: no ghosts, no drag dim, no swell', () => {
    for (const id of ['ghost-peek-standby', 'ghost-peek']) {
      const variant = LOOK_VARIANTS.find((candidate) => candidate.id === id);
      if (!variant) throw new Error(`no ${id}`);
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
      const frames = run(operations, lookDriverOf(variant));
      for (const frame of frames.slice(34, 36)) {
        expect(frame[1]).toBe(1);
        expect(frame[2]).toBe(0);
        expect(frame.length === 6 ? frame[5] : -1).toBe(ARRIVES_FROM_RIGHT + ARRIVES_CALM);
      }
      // The run's arrival keeps its calm code: no swell.
      expect(frames.at(-1)?.[5]).toBe(ARRIVES_FROM_RIGHT + ARRIVES_CALM);
      // The same drag outside a run: ghosts and dim.
      const fresh = run([{ drag: -60 }], lookDriverOf(variant))[0];
      expect(fresh[1]).toBeLessThan(1);
      expect(fresh[2]).toBeGreaterThan(0);
      expect(fresh.length === 6 ? fresh[5] : -1).toBe(ARRIVES_FROM_RIGHT);
    }
    // D keeps its drag dim in a run (calm runs are E and I only).
    const cascade = LOOK_VARIANTS.find((candidate) => candidate.id === 'sideways-cascade');
    if (!cascade) throw new Error('no cascade');
    const frames = run(
      [{ drag: -90 }, { commit: 1 }, ...ticks(3), { land: 0 }, { drag: -20 }, { drag: -60 }],
      lookDriverOf(cascade),
    );
    expect(frames.at(-1)?.[1]).toBeLessThan(1);
  });

  it('look frames reach a binary without the look as the shipped four numbers', () => {
    expect(shippedSwapFrame([0.25, 0.6, 0.2, 1, 0, 1])).toEqual([0.25, 0.6, 0.2, 1]);
    expect(shippedSwapFrame([0.25, 0.6, 0.2, 0.4, 0, 1])).toEqual([0.25, 0.6, 0.2, 0.6]);
    expect(shippedSwapFrame([0.25, 0.1, 0.2, 0.4, 0, 1])).toEqual([0.25, 0.1, 0.2, 0.4]);
    const shipped = [0.25, 0.6, 0.2, 0.6] as const;
    expect(shippedSwapFrame(shipped)).toBe(shipped);
  });

  it('builds its transition straight from slider values', () => {
    const transition = lookTransition(
      {},
      {
        tuning: WALL_SWAP,
        look: {
          holdWindow: 0.5,
          lowWindow: 1,
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
        },
        arrivalFloorShare: 1,
        linear: 0,
        sharedFloor: 1,
        runWindowMs: 0,
        runSwapMs: 0,
        ghostDrag: false,
        calmRuns: false,
      },
    );
    expect(transition.look).toMatchObject({
      holdWindow: 0.5,
      floor: WALL_SWAP.dimFloor,
      arrivalFloor: WALL_SWAP.dimFloor,
    });
    const plain = swapLookDriver({
      tuning: WALL_SWAP,
      sharedFloor: 1,
      ghostFloor: 0,
      arrivalFloor: WALL_SWAP.dimFloor,
      runWindowMs: 0,
      runSwapMs: 0,
      calmRuns: false,
    });
    expect(run(SEQUENCES['commit and land'], plain).map((frame) => frame.slice(0, 3))).toEqual(
      run(SEQUENCES['commit and land'], wallSwapDriver()).map((frame) => frame.slice(0, 3)),
    );
  });
});
