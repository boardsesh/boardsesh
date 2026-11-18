import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardTransitionDriver, BoardTransitionState } from '../board-transition';
import {
  playerRevealMode,
  stepWallSwap,
  swapClockMs,
  WALL_SWAP,
  wallSwapDriver,
  wallSwapPagePosition,
  wallSwapRest,
  wallSwapSharedWeight,
  type WallSwapInput,
  type WallSwapState,
  type WallSwapTuning,
} from '../wall-swap';

/**
 * One frame built straight from `stepWallSwap`, as use-wall-swap built it
 * before the driver: the frame and the two clock restarts.
 */
type Applied = { frame: readonly number[]; startSwapMs: number | null; startSettleMs: number | null };

type Operation =
  | { drag: number }
  | { commit: 1 | -1 }
  | { commitLanded: 1 | -1 }
  | { land: number }
  | { tick: number }
  | { reset: number };

/**
 * Runs one sequence straight through `stepWallSwap` (with the shipped numbers,
 * then the frame and clocks use-wall-swap used to build from it) and through
 * `driver`, feeding both the same pager and clocks.
 *
 * Both sides are today's `stepWallSwap`, so this proves only that the driver
 * adds nothing on top of it. What the swap itself does is pinned by the
 * behaviour tests in wall-swap.test.ts.
 */
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
  let steppedState: WallSwapState = wallSwapRest(input.anchor, input, WALL_SWAP);
  let driverState: BoardTransitionState = driver.rest(input);
  const stepped: Applied[] = [];
  const driven: Applied[] = [];
  for (const operation of operations) {
    if ('drag' in operation) input = { ...input, offset: operation.drag };
    if ('commit' in operation) input = { ...input, steps: input.steps + 1, fling: operation.commit };
    if ('commitLanded' in operation) {
      input = { ...input, steps: input.steps + 1, fling: 0, anchor: input.anchor + operation.commitLanded, offset: 0 };
    }
    if ('land' in operation) input = { ...input, anchor: input.anchor + input.fling, fling: 0, offset: operation.land };
    if ('tick' in operation) {
      input = {
        ...input,
        swapMs: Math.min(input.swapMs + operation.tick, swapClockMs(steppedState)),
        settleMs: Math.min(input.settleMs + operation.tick, steppedState.settleDurationMs),
      };
    }
    if ('reset' in operation)
      input = { ...input, anchor: operation.reset, offset: 0, fling: 0, reset: input.reset + 1 };

    const before = stepWallSwap(steppedState, input, WALL_SWAP);
    steppedState = before.state;
    stepped.push({
      frame: [
        wallSwapPagePosition(before.state, WALL_SWAP),
        before.state.outgoing,
        before.state.incoming,
        wallSwapSharedWeight(before.state, input.reduceMotion, WALL_SWAP),
      ],
      startSwapMs: before.startSwap ? swapClockMs(before.state) : null,
      startSettleMs: before.startSettleMs,
    });
    const step = driver.step(driverState, input);
    driverState = step.state;
    driven.push({ frame: step.frame, startSwapMs: step.startSwapMs, startSettleMs: step.startSettleMs });
    expect(step.state).toStrictEqual(before.state);

    if (before.startSwap) input = { ...input, swapMs: 0 };
    if (before.startSettleMs !== null) input = { ...input, settleMs: 0 };
  }
  return { stepped, driven };
}

const ticks = (count: number, ms = 8): Operation[] => Array.from({ length: count }, () => ({ tick: ms }));

/** The sequences wall-swap.test.ts walks, as operations. */
const SEQUENCES: Record<string, readonly Operation[]> = {
  'drag and cancel': [-30, -60, -90, -60, -20, -4, 0].map((drag) => ({ drag })),
  'drag across the middle': [{ drag: -40 }, { drag: SWIPE_THRESHOLD }, ...ticks(8)],
  'commit and land': [{ drag: -SWIPE_THRESHOLD - 10 }, { commit: 1 }, ...ticks(6, 16), { land: 0 }, ...ticks(7, 16)],
  'caught and pulled back': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(5),
    { land: 140 },
    ...[140, 142, 120, 100, 103, 106, 120, 140, 160, 170].flatMap((drag): Operation[] => [{ drag }, { tick: 8 }]),
    ...ticks(16),
  ],
  'caught and flicked onward': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(5),
    { land: 140 },
    { drag: 120 },
    { tick: 8 },
    { commit: 1 },
    ...ticks(30),
    { land: 0 },
    { tick: 8 },
  ],
  'pulled back then committed the other way (lead-in)': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(5),
    { land: 140 },
    { drag: 150 },
    { tick: 8 },
    { commit: 1 },
    ...ticks(45),
  ],
  'reversed mid-swap': [
    { drag: -90 },
    { commit: 1 },
    ...ticks(4),
    { commit: -1 },
    ...ticks(30),
    { land: 0 },
    ...ticks(4),
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
    ...ticks(40),
  ],
  'three quick flings': [
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
    ...ticks(30),
    { land: 0 },
    ...ticks(4),
  ],
  'a JS-driven move mid-swap': [{ drag: -90 }, { commit: 1 }, ...ticks(4), { reset: 5 }, ...ticks(4)],
  'a landed fling under Reduce Motion': [{ drag: -90 }, { commitLanded: 1 }, ...ticks(20)],
};

describe('wallSwapDriver', () => {
  it.each(Object.entries(SEQUENCES))(
    'builds the same frames and clock restarts as stepWallSwap: %s',
    (_name, operations) => {
      for (const reduceMotion of [false, true]) {
        const { stepped, driven } = run(operations, wallSwapDriver(), reduceMotion);
        expect(driven).toStrictEqual(stepped);
      }
    },
  );

  it('matches stepWallSwap over a long seeded random walk too', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const operations: Operation[] = [];
    for (let index = 0; index < 3000; index++) {
      const roll = random();
      if (roll < 0.3) operations.push({ drag: Math.round((random() * 2 - 1) * 400) });
      else if (roll < 0.4) operations.push({ commit: random() < 0.7 ? 1 : -1 });
      else if (roll < 0.47) operations.push({ land: random() < 0.6 ? 0 : Math.round((random() * 2 - 1) * 300) });
      else if (roll < 0.49) operations.push({ reset: Math.round(random() * 10) });
      else operations.push({ tick: [4, 8, 16.67][Math.floor(random() * 3)] });
    }
    const { stepped, driven } = run(operations, wallSwapDriver());
    expect(driven).toStrictEqual(stepped);
  });

  it('reads the tuning it is given, not WALL_SWAP: an equal copy behaves the same', () => {
    const copy: WallSwapTuning = { ...WALL_SWAP, easeIn: [...WALL_SWAP.easeIn], easeOut: [...WALL_SWAP.easeOut] };
    for (const operations of Object.values(SEQUENCES)) {
      expect(run(operations, wallSwapDriver(copy)).driven).toStrictEqual(run(operations, wallSwapDriver()).driven);
    }
  });

  it('retuned, changes the dim, the clocks and the pair it names', () => {
    const driver = wallSwapDriver({ ...WALL_SWAP, dimFloor: 0.2, durationMs: 400, settleMs: 300, pairLean: 0.1 });
    const input: WallSwapInput = {
      anchor: 0,
      offset: -SWIPE_THRESHOLD,
      fling: 0,
      steps: 0,
      reset: 0,
      swapMs: 0,
      settleMs: 0,
      reduceMotion: false,
      commitDistance: SWIPE_THRESHOLD,
    };
    const dragged = driver.step(driver.rest(input), input);
    [0.1, 0.2, 0, 0.2].forEach((expected, index) => expect(dragged.frame[index]).toBeCloseTo(expected, 10));
    const committed = driver.step(dragged.state, { ...input, steps: 1, fling: 1 });
    expect(committed.startSwapMs).toBe(400);
    // Crossing to the other side eases from the weight on screen, on the settle clock.
    const crossed = driver.step(driver.rest(input), { ...input, offset: -40 });
    expect(driver.step(crossed.state, { ...input, offset: SWIPE_THRESHOLD }).startSettleMs).toBe(300);
  });
});

describe('playerRevealMode with a preference', () => {
  it('gives the wipe whenever asked, and the swap only from API 6', () => {
    expect(playerRevealMode(7, 'wipe')).toBe('wipe');
    expect(playerRevealMode(6, 'swap')).toBe('swap');
    expect(playerRevealMode(5, 'swap')).toBe('wipe');
    expect(playerRevealMode(7)).toBe('swap');
  });
});

describe('wall-swap worklets', () => {
  it('take no default parameters: the worklets plugin evaluates one before it binds the closure', () => {
    const source = readFileSync(new URL('../wall-swap.ts', import.meta.url), 'utf8');
    // `function name(params)` or `const name = (params)`, then a one-line return
    // type (at most one brace group), then a body that opens with 'worklet'.
    const worklets = [
      ...source.matchAll(
        /(?:function\s+(\w+)|const\s+(\w+)\s*=)\s*\(([^)]*)\)[^;{\n]*(?:\{[^{}\n]*\}[^;{\n]*)?\{\s*'worklet';/g,
      ),
    ];
    // Every worklet in the file is read, none skipped.
    expect(worklets).toHaveLength(source.split("'worklet'").length - 1);
    const defaulted = worklets
      .filter(([, , , parameters]) => parameters.replace(/=>/g, '').includes('='))
      .map(([, functionName, constName]) => functionName ?? constName);
    expect(defaulted).toEqual([]);
  });
});
