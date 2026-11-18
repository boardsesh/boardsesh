import { describe, expect, it } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardTransitionDriver } from '../../play-drawer/board-transition';
import { WALL_SWAP, WALL_SWAP_NATIVE_API, wallSwapDriver, type WallSwapInput } from '../../play-drawer/wall-swap';
import type { BoardMotionVariant, ParamValues } from '../types';
import { BOARD_MOTION_VARIANTS, DEFAULT_VARIANT_ID } from '../variants';
import { tuningFromParams, WALL_SWAP_PARAMS } from '../variants/tuning-params';

function defaults(variant: BoardMotionVariant): ParamValues {
  return Object.fromEntries(variant.params.map((spec) => [spec.key, spec.default]));
}

function variant(id: string): BoardMotionVariant {
  const found = BOARD_MOTION_VARIANTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no variant ${id}`);
  return found;
}

function driverOf(found: BoardMotionVariant, params: ParamValues): BoardTransitionDriver {
  const { driver } = found.createTransition(params);
  if (!driver) throw new Error(`${found.id} has no driver`);
  return driver;
}

const AT_REST: WallSwapInput = {
  anchor: 0,
  offset: 0,
  fling: 0,
  steps: 0,
  reset: 0,
  swapMs: 0,
  settleMs: 0,
  reduceMotion: false,
  commitDistance: SWIPE_THRESHOLD,
};

/** A drag to the threshold, then the commit: the frame at the threshold and the swap clock started. */
function dragAndCommit(driver: BoardTransitionDriver) {
  const dragged = driver.step(driver.rest(AT_REST), { ...AT_REST, offset: -SWIPE_THRESHOLD });
  const committed = driver.step(dragged.state, { ...AT_REST, offset: -SWIPE_THRESHOLD, steps: 1, fling: 1 });
  return { dragFrame: dragged.frame, swapMs: committed.startSwapMs };
}

describe('board motion variants', () => {
  it('list A to C, then I and J, then D to H, with unique kebab-case ids and slider keys', () => {
    expect(BOARD_MOTION_VARIANTS.map((candidate) => candidate.letter)).toEqual([
      'A',
      'B',
      'C',
      'I',
      'J',
      'D',
      'E',
      'F',
      'G',
      'H',
    ]);
    expect(DEFAULT_VARIANT_ID).toBe('ghost-peek-standby');
    expect(new Set(BOARD_MOTION_VARIANTS.map((candidate) => candidate.id)).size).toBe(BOARD_MOTION_VARIANTS.length);
    for (const candidate of BOARD_MOTION_VARIANTS) {
      expect(candidate.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      const keys = candidate.params.map((spec) => spec.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const spec of candidate.params) {
        expect(spec.default).toBeGreaterThanOrEqual(spec.min);
        expect(spec.default).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  it('A starts on exactly the shipped numbers, one slider each', () => {
    const shipped = variant('shipped-wall-swap');
    expect(shipped.params).toBe(WALL_SWAP_PARAMS);
    expect(tuningFromParams(defaults(shipped))).toStrictEqual({
      ...WALL_SWAP,
      easeIn: [...WALL_SWAP.easeIn],
      easeOut: [...WALL_SWAP.easeOut],
    });
    expect(dragAndCommit(driverOf(shipped, defaults(shipped)))).toEqual(dragAndCommit(wallSwapDriver()));
    expect(shipped.createTransition(defaults(shipped)).revealMode).toBe('swap');
    expect(shipped.requiresNativeApi).toBe(WALL_SWAP_NATIVE_API);
  });

  it('A follows its sliders', () => {
    const shipped = variant('shipped-wall-swap');
    const { dragFrame, swapMs } = dragAndCommit(
      driverOf(shipped, { ...defaults(shipped), dimFloor: 0.1, durationMs: 500 }),
    );
    expect(dragFrame[1]).toBeCloseTo(0.1, 10);
    expect(swapMs).toBe(500);
  });

  it('B is the wipe, with nothing to tune', () => {
    const wipe = variant('wipe');
    expect(wipe.createTransition({})).toEqual({ revealMode: 'wipe' });
    expect(wipe.params).toEqual([]);
  });

  it('C dissolves once, with no dim while dragging and shared holds steady, Reduce Motion or not', () => {
    const dissolve = variant('dissolve');
    expect(dissolve.requiresNativeApi).toBe(WALL_SWAP_NATIVE_API);
    expect(defaults(dissolve)).toEqual({ durationMs: WALL_SWAP.reduceMotionDurationMs });
    const { dragFrame, swapMs } = dragAndCommit(driverOf(dissolve, { durationMs: 300 }));
    expect(dragFrame).toEqual([WALL_SWAP.pairLean, 1, 0, 1]);
    expect(swapMs).toBe(300);
  });
});
