import { describe, expect, it } from 'vitest';
import type { BoardTransitionDriver } from '../../play-drawer/board-transition';
import { PLAYER_SWAP_LOOK } from '../../play-drawer/player-swap-look';
import { encodeSwapLook } from '../../play-drawer/swap-look';
import { ARRIVES_CALM, ARRIVES_FROM_RIGHT, swapLookTransition } from '../../play-drawer/swap-look-driver';
import { WALL_SWAP, wallSwapDriver } from '../../play-drawer/wall-swap';
import {
  ENDS_AT_REST,
  expectLookInvariants,
  pages,
  randomWalk,
  runDriver as run,
  SEQUENCES,
  ticks,
  type Operation,
} from '../../play-drawer/__tests__/helpers/swap-look-driver-harness';
import type { BoardMotionVariant, ParamValues } from '../types';
import { BOARD_MOTION_VARIANTS } from '../variants';
import { GHOST_PEEK_STANDBY } from '../variants/ghost-peek-standby';
import { lookTransition, lookVariantDefaults, lookVariantTuning, SWAP_LOOK_LAB_MODE } from '../variants/look-variant';

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

describe('swap look variants', () => {
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
      for (const name of ENDS_AT_REST) {
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

  it('builds its transition straight from slider values, with the player’s builder', () => {
    const spec = {
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
      sharedFloor: 1,
      runWindowMs: 0,
      runSwapMs: 0,
      ghostDrag: false,
      calmRuns: false,
    };
    const transition = lookTransition({}, { ...spec, linear: 0 });
    expect(transition.look).toMatchObject({
      holdWindow: 0.5,
      floor: WALL_SWAP.dimFloor,
      arrivalFloor: WALL_SWAP.dimFloor,
    });
    expect(transition.look).toEqual(swapLookTransition(spec).look);
  });

  it('I on Subtle is the player’s look: the same look sent, the same frames', () => {
    expect(lookVariantDefaults(GHOST_PEEK_STANDBY)).toEqual({ ...PLAYER_SWAP_LOOK, linear: 0 });
    const lab = GHOST_PEEK_STANDBY.createTransition(defaults(GHOST_PEEK_STANDBY));
    const player = swapLookTransition(PLAYER_SWAP_LOOK);
    if (!lab.look || !player.look || !lab.driver || !player.driver) throw new Error('no look');
    expect(encodeSwapLook(lab.look)).toEqual(encodeSwapLook(player.look));
    for (const operations of [...Object.values(SEQUENCES), randomWalk(31, 1500)]) {
      expect(run(operations, lab.driver)).toEqual(run(operations, player.driver));
    }
    // A slider moved in the lab no longer matches: the lab retunes a copy, never the player.
    const retuned = GHOST_PEEK_STANDBY.createTransition({ ...defaults(GHOST_PEEK_STANDBY), ghost: 0.2 });
    expect(retuned.look?.ghost).toBe(0.2);
    expect(PLAYER_SWAP_LOOK.look.ghost).toBe(0.4);
  });
});
