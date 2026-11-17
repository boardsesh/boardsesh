// Steps Reanimated's own `withSpring` (react-native-reanimated/src, the version
// the app ships), frame by frame at 120 Hz like the iPhone 17 Pro the swipes
// were filmed on. Only the two modules that reach the UI runtime are stood in:
// the logger, and `defineAnimation`, which here hands back the animation object
// the spring builds instead of registering it with a worklet runtime.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-reanimated/src/common', () => ({ logger: { warn: () => undefined } }));
vi.mock('react-native-reanimated/src/animation/util', () => ({
  defineAnimation: (_start: unknown, factory: () => unknown) => factory(),
  getReduceMotionForAnimation: () => false,
}));
// The pager is imported for its tell threshold only; its hooks never run here.
vi.mock('react-native-reanimated', () => ({
  cancelAnimation: () => undefined,
  runOnJS: (fn: unknown) => fn,
  useAnimatedReaction: () => undefined,
  useSharedValue: (value: unknown) => ({ value }),
}));

import { TELL_JS_REMAINING } from '../../components/play-drawer/use-swipe-pager';
import { PAGING_LANDED_DISTANCE, pagingSpring } from '../paging-spring';
import { springs } from '../animations';

// Loaded at run time only, by a path the type checker does not follow: a static
// import would type-check Reanimated's own source along with ours.
const SPRING_SOURCE = 'react-native-reanimated/src/animation/spring/spring';
let withSpring: typeof import('react-native-reanimated').withSpring;
beforeAll(async () => {
  ({ withSpring } = (await import(/* @vite-ignore */ SPRING_SOURCE)) as { withSpring: typeof withSpring });
});

type SpringAnimation = {
  onStart: (animation: SpringAnimation, value: number, now: number, previous: undefined) => void;
  onFrame: (animation: SpringAnimation, now: number) => boolean;
  current: number;
};

const FRAME_MS = 1000 / 120;
// The board is 335 pt wide on the iPhone 17 Pro the swipes were filmed on.
const BOARD = 335;

/**
 * Every frame of a spring from `from` toward `to` until Reanimated says it is
 * done: the value after each frame, and when it was drawn.
 */
function frames(from: number, to: number, config: object): { ms: number; value: number }[] {
  const animation = withSpring(to, config as never) as unknown as SpringAnimation;
  animation.onStart(animation, from, 0, undefined);
  const drawn: { ms: number; value: number }[] = [];
  for (let frame = 1; frame <= 600; frame += 1) {
    const ms = frame * FRAME_MS;
    const done = animation.onFrame(animation, ms);
    drawn.push({ ms, value: animation.current });
    if (done) return drawn;
  }
  throw new Error('the spring never finished');
}

/** What the climber sees of a release at `from` pt, `velocity` pt/s, toward the next climb. */
function release(from: number, velocity: number) {
  const drawn = frames(from, BOARD, pagingSpring(from, BOARD, velocity));
  const reach = (share: number) => drawn.find(({ value }) => value >= from + (BOARD - from) * share)?.ms ?? Infinity;
  const tellAt = BOARD * (1 - TELL_JS_REMAINING);
  return {
    drawn,
    msTo90: reach(0.9),
    // The JS thread is told on the first frame past the threshold (at once if
    // the finger let go past it).
    msToTell: from >= tellAt ? 0 : (drawn.find(({ value }) => value >= tellAt)?.ms ?? Infinity),
    msToLand: drawn[drawn.length - 1].ms,
  };
}

// What it did before #7720: toward the screen width plus 80 pt on the
// interactive spring, with the JS thread told once it passed the board width,
// where the content was clamped.
function oldTellMs(from: number, velocity: number): number {
  const drawn = frames(from, 402 + 80, { ...springs.interactive, velocity, overshootClamping: true });
  return drawn.find(({ value }) => value >= BOARD)?.ms ?? Infinity;
}

// The four releases measured on the iPhone 17 Pro recording.
const FLICKS: [number, number][] = [
  [244, 2950],
  [263, 2550],
  [292, 2350],
  [233, 2900],
];
// Let go slowly, or not moving at all, past the commit distance.
const SLOW: [number, number][] = [
  [170, 0],
  [85, 300],
  [120, 0],
  [200, 500],
  [100, 1200],
];

describe('pagingSpring on Reanimated’s own spring', () => {
  it('is critically damped at every speed', () => {
    for (const [from, velocity] of [...FLICKS, ...SLOW, [60, 9000]]) {
      const { damping, stiffness, mass } = pagingSpring(from, BOARD, velocity);
      expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeCloseTo(1, 12);
    }
    const { damping, stiffness, mass } = springs.paging;
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBe(1);
  });

  it('raises the stiffness to k = max(floor, (v / d)²), and no further', () => {
    expect(pagingSpring(292, BOARD, 2350).stiffness).toBeCloseTo((2350 / 43) ** 2, 6);
    expect(pagingSpring(85, BOARD, 300).stiffness).toBe(springs.paging.stiffness);
  });

  it('carries the release velocity, and drops one pointing away from the target', () => {
    expect(pagingSpring(244, BOARD, 2950).velocity).toBe(2950);
    expect(pagingSpring(-244, -BOARD, -2950).velocity).toBe(-2950);
    expect(pagingSpring(200, BOARD, -800).velocity).toBe(0);
  });

  it.each([...FLICKS, ...SLOW, [60, 9000] as [number, number], [300, 0] as [number, number]])(
    'never passes the middle from %s pt at %s pt/s, either way',
    (from, velocity) => {
      for (const { value } of release(from, velocity).drawn) expect(value).toBeLessThanOrEqual(BOARD + 1e-9);
      for (const { value } of frames(-from, -BOARD, pagingSpring(-from, -BOARD, -velocity))) {
        expect(value).toBeGreaterThanOrEqual(-BOARD - 1e-9);
      }
    },
  );

  it.each(FLICKS)('takes a flick from %s pt at %s pt/s 90%% of the way in 40–75 ms', (from, velocity) => {
    const { msTo90 } = release(from, velocity);
    expect(msTo90).toBeGreaterThanOrEqual(40);
    expect(msTo90).toBeLessThanOrEqual(75 + 1e-6);
  });

  // The floor was 400 in #7720: a still release took about 450 ms to land, and
  // the drawer's pull-down and the next swipe waited on that.
  it.each(SLOW)('lands a slow release from %s pt at %s pt/s within 200 ms', (from, velocity) => {
    expect(release(from, velocity).msToLand).toBeLessThanOrEqual(200 + 1e-6);
  });

  it.each(FLICKS)('lands a flick from %s pt at %s pt/s within 160 ms', (from, velocity) => {
    expect(release(from, velocity).msToLand).toBeLessThanOrEqual(160);
  });

  it.each([...FLICKS, ...SLOW])(
    'tells the JS thread no later than the old spring did, from %s pt at %s pt/s',
    (from, velocity) => {
      expect(release(from, velocity).msToTell).toBeLessThanOrEqual(oldTellMs(from, velocity));
    },
  );

  it.each([...FLICKS, ...SLOW])(
    'snaps its last frame by about half a point, from %s pt at %s pt/s',
    (from, velocity) => {
      const { drawn } = release(from, velocity);
      // Reanimated checks the energy left after a frame is drawn, so the frame
      // before the snap can sit a little past the landed distance.
      expect(BOARD - drawn[drawn.length - 2].value).toBeLessThanOrEqual(PAGING_LANDED_DISTANCE * 1.1);
    },
  );

  it('brings a cancelled swipe back without passing the middle, within 200 ms', () => {
    // Let go short, still moving outward, or flicked back toward the middle.
    for (const [from, velocity] of [
      [-60, -400],
      [-60, 1500],
      [-79, 0],
      [80, -3000],
    ]) {
      const drawn = frames(from, 0, pagingSpring(from, 0, velocity));
      for (const { value } of drawn) expect(Math.sign(value) * Math.sign(from)).toBeGreaterThanOrEqual(0);
      expect(drawn[drawn.length - 1].ms).toBeLessThanOrEqual(200 + 1e-6);
    }
  });
});
