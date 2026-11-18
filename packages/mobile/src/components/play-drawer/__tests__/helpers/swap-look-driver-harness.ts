/**
 * Drives a board transition driver the way use-wall-swap does, one frame per
 * operation, and checks a swap look's frames. Shared by the driver's own tests
 * and the board motion lab's variant tests.
 */
import { expect } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardTransitionDriver, BoardTransitionState } from '../../board-transition';
import type { BoardSwapFrame } from '../../swap-look';
import { ARRIVES_CALM, ARRIVES_FROM_LEFT, ARRIVES_FROM_RIGHT, LEAVING } from '../../swap-look-driver';
import type { WallSwapInput } from '../../wall-swap';

export type Operation =
  | { drag: number }
  | { commit: 1 | -1 }
  | { land: number }
  | { tick: number }
  | { reset: number }
  | { reduceMotion: boolean };

export const ticks = (count: number, ms = 8): Operation[] => Array.from({ length: count }, () => ({ tick: ms }));

/** Drives `driver` with a pager and the two clocks the way use-wall-swap does; every frame. */
export function runDriver(operations: readonly Operation[], driver: BoardTransitionDriver, reduceMotion = false) {
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
export function pages(frame: BoardSwapFrame): Map<number, { weight: number; arrives: number }> {
  const from = Math.round(frame[0]);
  const dir = Math.sign(frame[0] - from);
  const shown = new Map([[from, { weight: frame[1], arrives: frame.length === 6 ? frame[4] : 0 }]]);
  if (dir !== 0) shown.set(from + dir, { weight: frame[2], arrives: frame.length === 6 ? frame[5] : 0 });
  return shown;
}

/** The sequences the shipped driver's own tests walk, as operations. */
export const SEQUENCES: Record<string, readonly Operation[]> = {
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

/** The sequences that end with one climb whole and nothing arriving. */
export const ENDS_AT_REST = [
  'drag and cancel',
  'drag across the middle',
  'commit and land',
  'caught and flicked onward',
  'reversed mid-swap',
  'three quick flicks',
] as const;

export function randomWalk(seed: number, length: number): Operation[] {
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

/** Leaving, arriving from either edge, either calm or not. */
export const ARRIVAL_CODES = [
  LEAVING,
  ARRIVES_FROM_RIGHT,
  ARRIVES_FROM_LEFT,
  ARRIVES_FROM_RIGHT + ARRIVES_CALM,
  ARRIVES_FROM_LEFT + ARRIVES_CALM,
];

/**
 * The look's invariants on every frame: weights in range, the shared floor
 * never below the look's, and a climb already on screen changing its arrival
 * flag only while its weight is 0 or 1 (so the native look's pixels cannot
 * jump).
 */
export function expectLookInvariants(frames: readonly BoardSwapFrame[], sharedFloor: number) {
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
