import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardTransitionState } from '../board-transition';
import { pngBareWallUsable, pngSwapLayers, pngSwapPageOpacity, type PngSwapLayers } from '../png-swap-layers';
import type { BoardSwapFrame } from '../swap-look';
import { WALL_SWAP, wallSwapDriver, type WallSwapInput } from '../wall-swap';

/**
 * Three overlapping climbs by page, as hold ids: 3 and 4 are lit in pages 0
 * and 1, 4 in pages 0 and -1.
 */
const CLIMBS = new Map<number, ReadonlySet<number>>([
  [-1, new Set([4, 9, 10])],
  [0, new Set([1, 2, 3, 4])],
  [1, new Set([3, 4, 5, 6])],
]);
const ALL_HOLDS = [1, 2, 3, 4, 5, 6, 9, 10];

/**
 * What the composited stack shows, drawn as the carousel draws it: the bare
 * wall first, then the boards in page order, each a whole picture at its
 * opacity. A board shows the unlit wall everywhere but its lit holds, as the
 * bare wall does, so `wall` is how much of the frame is covered by that wall
 * (1 means the drawer never shows through) and `holds` is each hold's light.
 */
function composite(layers: PngSwapLayers) {
  let wall = layers.bareWallOpacity;
  const holds = new Map<number, number>(ALL_HOLDS.map((hold) => [hold, 0]));
  for (const page of [-1, 0, 1]) {
    const opacity = pngSwapPageOpacity(layers, page);
    const lit = CLIMBS.get(page) ?? new Set<number>();
    wall = opacity + (1 - opacity) * wall;
    for (const hold of ALL_HOLDS) {
      holds.set(hold, opacity * (lit.has(hold) ? 1 : 0) + (1 - opacity) * (holds.get(hold) ?? 0));
    }
  }
  return { wall, holds };
}

/** The shipped driver, run the way use-wall-swap runs it, with each frame's layers. */
function harness(reduceMotion = false, wholeWall = reduceMotion) {
  const driver = wallSwapDriver();
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
  let swapEndMs = 0;
  const frames: { frame: BoardSwapFrame; layers: PngSwapLayers }[] = [];
  const apply = (changes: Partial<WallSwapInput>) => {
    input = { ...input, ...changes };
    const step = driver.step(state, input);
    state = step.state;
    if (step.startSwapMs !== null) {
      input = { ...input, swapMs: 0 };
      swapEndMs = step.startSwapMs;
    }
    if (step.startSettleMs !== null) input = { ...input, settleMs: 0 };
    const layers = pngSwapLayers(step.frame, wholeWall, input.anchor);
    frames.push({ frame: step.frame, layers });
    return layers;
  };
  return {
    drag: (offset: number) => apply({ offset }),
    commit: (direction: 1 | -1) => apply({ steps: input.steps + 1, fling: direction }),
    land: () => apply({ anchor: input.anchor + input.fling, fling: 0, offset: 0 }),
    tick: (ms = 8) => apply({ swapMs: Math.min(input.swapMs + ms, swapEndMs) }),
    frames,
  };
}

/** A whole swipe: drag to the commit distance, commit, run the swap out, land. */
function swipe(direction: 1 | -1, reduceMotion = false) {
  const run = harness(reduceMotion);
  for (let offset = 8; offset <= SWIPE_THRESHOLD; offset += 8) run.drag(-direction * offset);
  run.commit(direction);
  for (let tick = 0; tick < 40; tick++) run.tick();
  run.land();
  return run.frames;
}

function expectUnit(value: number) {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

describe('pngSwapLayers', () => {
  it('shows the climb on its own at rest, with nothing under it', () => {
    const layers = pngSwapLayers([0, 1, 0, 1], false, 0);
    expect(layers).toMatchObject({ leavingPage: 0, leavingOpacity: 1, bareWallOpacity: 0 });
    expect(pngSwapPageOpacity(layers, 1)).toBe(0);
    expect(pngSwapPageOpacity(layers, -1)).toBe(0);
  });

  it.each([1, -1] as const)('dims the current board over the bare wall while dragging toward %i', (direction) => {
    const run = harness();
    const halfway = run.drag(-direction * (SWIPE_THRESHOLD / 2));
    expect(halfway.leavingPage).toBe(0);
    expect(halfway.arrivingPage).toBe(direction);
    expect(halfway.leavingOpacity).toBeCloseTo(0.7, 5);
    expect(halfway.arrivingOpacity).toBe(0);
    expect(halfway.bareWallOpacity).toBe(1);
    const atCommit = run.drag(-direction * SWIPE_THRESHOLD * 2);
    expect(atCommit.leavingOpacity).toBeCloseTo(WALL_SWAP.dimFloor, 5);
    // Nothing of the next climb shows while dragging.
    expect(composite(atCommit).holds.get(direction > 0 ? 5 : 9)).toBe(0);
  });

  it.each([1, -1] as const)('hands the climb over at 40%% then lifts the new one whole, toward %i', (direction) => {
    const frames = swipe(direction);
    const leaving = CLIMBS.get(0)!;
    const arriving = CLIMBS.get(direction)!;
    const leavingOnly = [...leaving].filter((hold) => !arriving.has(hold));
    const arrivingOnly = [...arriving].filter((hold) => !leaving.has(hold));
    const shared = [...leaving].filter((hold) => arriving.has(hold));
    let previous: Map<number, number> | null = null;
    for (const { layers } of frames) {
      for (const opacity of [layers.leavingOpacity, layers.arrivingOpacity, layers.bareWallOpacity]) {
        expectUnit(opacity);
      }
      const { wall, holds } = composite(layers);
      // The unlit wall is always whole: the drawer never shows through.
      expect(wall).toBeCloseTo(1, 9);
      // Shared holds never dip below the floor.
      for (const hold of shared) expect(holds.get(hold)!).toBeGreaterThanOrEqual(WALL_SWAP.dimFloor - 1e-9);
      // The new climb's own holds wait until the old climb's are down to 40%.
      const arrivingLight = Math.max(...arrivingOnly.map((hold) => holds.get(hold)!));
      const leavingLight = Math.max(...leavingOnly.map((hold) => holds.get(hold)!));
      if (arrivingLight > 1e-9) expect(leavingLight).toBeLessThanOrEqual(WALL_SWAP.dimFloor + 1e-9);
      // No hold jumps between 8 ms frames.
      if (previous) {
        for (const hold of ALL_HOLDS) expect(Math.abs(holds.get(hold)! - previous.get(hold)!)).toBeLessThan(0.2);
      }
      previous = holds;
    }
    const last = frames.at(-1)!.layers;
    expect(last).toMatchObject({ leavingPage: direction, leavingOpacity: 1, bareWallOpacity: 0 });
    expect(pngSwapPageOpacity(last, 0)).toBe(0);
  });

  it('never sends an opacity past 1 when the board on top is nearly whole', () => {
    for (const frame of [
      [0.25, 0.05, 0.999, 1],
      [-0.25, 0.999, 0.05, 1],
      [0.25, 0.6, 0.9999999, 1],
    ] as const) {
      const layers = pngSwapLayers(frame, false, 0);
      for (const opacity of [layers.leavingOpacity, layers.arrivingOpacity, layers.bareWallOpacity])
        expectUnit(opacity);
      expect(composite(layers).wall).toBeCloseTo(1, 9);
    }
  });

  it('keeps the board whole and dissolves under Reduce Motion, with shared holds whole throughout', () => {
    const frames = swipe(1, true);
    const shared = [3, 4];
    for (const { layers } of frames) {
      const { wall, holds } = composite(layers);
      expect(wall).toBeCloseTo(1, 9);
      // A dissolve between whole boards: the bare wall is never needed.
      expect(layers.bareWallOpacity).toBe(0);
      for (const hold of shared) expect(holds.get(hold)!).toBeCloseTo(1, 9);
    }
    // No dim while dragging.
    expect(frames[SWIPE_THRESHOLD / 8 - 1].layers.leavingOpacity).toBe(1);
  });

  it('does not dim before the bare wall has painted: the drag stays whole', () => {
    const run = harness(false, true);
    const layers = run.drag(-SWIPE_THRESHOLD);
    expect(layers.leavingOpacity).toBe(1);
    expect(layers.bareWallOpacity).toBe(0);
  });

  it('shows the rest page for a frame whose position is not a number, and clamps bad weights', () => {
    expect(pngSwapLayers([Number.NaN, 1, 0, 1], false, 3)).toMatchObject({
      leavingPage: 3,
      leavingOpacity: 1,
      bareWallOpacity: 0,
    });
    const layers = pngSwapLayers([0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN], false, 0);
    for (const opacity of [layers.leavingOpacity, layers.arrivingOpacity, layers.bareWallOpacity]) expectUnit(opacity);
    expect(composite(layers).wall).toBeCloseTo(1, 9);
  });

  it('reads a swap look frame by its shipped four numbers', () => {
    const look: BoardSwapFrame = [0.25, 0.4, 0, 0.4, 0, 1];
    expect(pngSwapLayers(look, false, 0)).toEqual(pngSwapLayers([0.25, 0.4, 0, 0.4], false, 0));
  });

  it('reads the pair back from the page position, which leans under half a page', () => {
    expect(WALL_SWAP.pairLean).toBeLessThan(0.5);
    for (const from of [-2, -1, 0, 1, 2]) {
      for (const direction of [-1, 0, 1]) {
        const layers = pngSwapLayers([from + direction * WALL_SWAP.pairLean, 0.7, 0, 0.7], false, 99);
        expect(layers.leavingPage).toBe(from);
        expect(layers.arrivingPage).toBe(from + direction);
      }
    }
  });
});

describe('pngBareWallUsable', () => {
  it('takes the bare wall up only from rest, so a board never jumps from whole to its dim', () => {
    expect(pngBareWallUsable(true, false, [0, 1, 0, 1])).toBe(true);
    // Mid-drag (the pair leans toward the next climb): wait for the next rest.
    expect(pngBareWallUsable(true, false, [0.25, 1, 0, 1])).toBe(false);
    expect(pngBareWallUsable(true, false, [0, 0.7, 0, 0.7])).toBe(false);
  });

  it('keeps it once taken, and drops it at once when it stops being ready', () => {
    expect(pngBareWallUsable(true, true, [0.25, 0.4, 0, 0.4])).toBe(true);
    expect(pngBareWallUsable(false, true, [0.25, 0.4, 0, 0.4])).toBe(false);
    expect(pngBareWallUsable(false, false, [0, 1, 0, 1])).toBe(false);
  });
});
