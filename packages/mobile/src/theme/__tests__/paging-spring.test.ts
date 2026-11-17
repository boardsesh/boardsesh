import { describe, expect, it } from 'vitest';
import { PAGING_LANDED_DISTANCE, pagingSpring } from '../paging-spring';

/**
 * Reanimated's critically damped spring (`criticallyDampedSpringCalculations`)
 * in closed form: where it is `t` seconds after starting at `from`.
 */
function settle(from: number, to: number, velocity: number) {
  const config = pagingSpring(from, to, velocity);
  const omega = Math.sqrt(config.stiffness / config.mass);
  const x0 = from - to;
  const at = (t: number) => {
    const envelope = Math.exp(-omega * t);
    const position = to + envelope * (x0 + (config.velocity + omega * x0) * t);
    const speed =
      envelope * (-omega * (x0 + (config.velocity + omega * x0) * t)) + envelope * (config.velocity + omega * x0);
    return { position, speed };
  };
  const energy = (t: number) => {
    const { position, speed } = at(t);
    return 0.5 * config.stiffness * (position - to) ** 2 + 0.5 * config.mass * speed ** 2;
  };
  return {
    config,
    at,
    energy,
    startEnergy: 0.5 * config.stiffness * x0 ** 2 + 0.5 * config.mass * config.velocity ** 2,
  };
}

/** Milliseconds until the spring has covered `share` of the way, sampled every 0.1 ms. */
function msToReach(from: number, to: number, velocity: number, share: number): number {
  const { at } = settle(from, to, velocity);
  const goal = from + (to - from) * share;
  for (let ms = 0; ms < 2000; ms += 0.1) {
    const { position } = at(ms / 1000);
    if ((to - from) * (position - goal) >= 0) return ms;
  }
  return Infinity;
}

/** The furthest the spring gets past its target, in points, over two seconds. */
function overshoot(from: number, to: number, velocity: number): number {
  const { at } = settle(from, to, velocity);
  let worst = 0;
  for (let ms = 0; ms < 2000; ms += 0.5) {
    worst = Math.max(worst, Math.sign(to - from) * (at(ms / 1000).position - to));
  }
  return worst;
}

// The board is 335 pt wide on the iPhone 17 Pro the swipes were filmed on.
const BOARD = 335;

describe('pagingSpring', () => {
  it('is critically damped at every speed', () => {
    for (const [from, velocity] of [
      [0, 0],
      [244, 2950],
      [120, 6000],
      [300, 40],
    ]) {
      const { damping, stiffness, mass } = pagingSpring(from, BOARD, velocity);
      expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeCloseTo(1, 12);
    }
  });

  it('raises the stiffness to k = max(400, (v / d)²), and no further', () => {
    expect(pagingSpring(244, BOARD, 2950).stiffness).toBeCloseTo((2950 / 91) ** 2, 6);
    expect(pagingSpring(85, BOARD, 300).stiffness).toBe(400);
  });

  it('carries the release velocity, and drops one pointing away from the target', () => {
    expect(pagingSpring(244, BOARD, 2950).velocity).toBe(2950);
    expect(pagingSpring(-244, -BOARD, -2950).velocity).toBe(-2950);
    expect(pagingSpring(200, BOARD, -800).velocity).toBe(0);
  });

  it.each([
    // The four releases measured on the iPhone 17 Pro recording, a much harder
    // flick, a slow release, a standstill, and both directions.
    [244, 2950],
    [263, 2550],
    [292, 2350],
    [233, 2900],
    [60, 9000],
    [170, 300],
    [100, 0],
    [-244, -2950],
  ])('never passes the middle from %s pt at %s pt/s', (from, velocity) => {
    const to = Math.sign(from) * BOARD;
    expect(overshoot(from, to, velocity)).toBeLessThan(1e-9);
  });

  it.each([
    [244, 2950],
    [263, 2550],
    [292, 2350],
  ])('lands a flick from %s pt at %s pt/s 90%% of the way in 40–75 ms', (from, velocity) => {
    const ms = msToReach(from, BOARD, velocity, 0.9);
    expect(ms).toBeGreaterThanOrEqual(40);
    expect(ms).toBeLessThanOrEqual(75);
  });

  it.each([
    [85, 300],
    [170, 0],
    [200, 150],
  ])('takes about 180 ms to get 90%% of the way from a slow release at %s pt, %s pt/s', (from, velocity) => {
    const ms = msToReach(from, BOARD, velocity, 0.9);
    expect(ms).toBeGreaterThanOrEqual(150);
    expect(ms).toBeLessThanOrEqual(200);
  });

  it('brings a cancelled swipe back without passing the middle', () => {
    // Let go short, still moving outward, or flicked back toward the middle.
    for (const [from, velocity] of [
      [-60, -400],
      [-60, 1500],
      [80, -3000],
    ]) {
      expect(overshoot(from, 0, velocity)).toBeLessThan(1e-9);
    }
  });

  it.each([
    [244, 2950],
    [85, 300],
    [-60, 1500],
  ])('finishes within a quarter point of the target from %s pt at %s pt/s', (from, velocity) => {
    const to = Math.abs(from) > 70 ? Math.sign(from) * BOARD : 0;
    const { config, energy, startEnergy, at } = settle(from, to, velocity);
    // The first frame Reanimated's energy test passes.
    let ms = 0;
    while (energy(ms / 1000) / startEnergy > config.energyThreshold) ms += 1000 / 120;
    expect(Math.abs(at(ms / 1000).position - to)).toBeLessThanOrEqual(PAGING_LANDED_DISTANCE);
    // And it does not creep on below a pixel: Reanimated's default threshold
    // kept this flick going until about 300 ms.
    if (velocity === 2950) expect(ms).toBeLessThanOrEqual(210);
  });
});
