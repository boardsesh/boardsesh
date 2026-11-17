import { describe, it, expect } from 'vitest';
import { springs, timing } from '../animations';
import type { SpringPreset, TimingPreset } from '../animations';

// ── Spring presets ──────────────────────────────────────────────────────

describe('springs', () => {
  const springNames = Object.keys(springs) as SpringPreset[];

  it.each(springNames)('preset "%s" has damping, stiffness, and mass properties', (preset) => {
    const config = springs[preset];
    expect(config).toHaveProperty('damping');
    expect(config).toHaveProperty('stiffness');
    expect(config).toHaveProperty('mass');
  });

  it.each(springNames)('preset "%s" has all positive values', (preset) => {
    const config = springs[preset];
    expect(config.damping).toBeGreaterThan(0);
    expect(config.stiffness).toBeGreaterThan(0);
    expect(config.mass).toBeGreaterThan(0);
  });

  it('snappy has higher stiffness than gentle', () => {
    expect(springs.snappy.stiffness).toBeGreaterThan(springs.gentle.stiffness);
  });

  // `paging` is left out: it is the floor of a settle whose stiffness the
  // release raises (`pagingSpring`), not a response for a control.
  it('snappy has the highest stiffness of the control presets', () => {
    for (const preset of springNames.filter((name) => name !== 'paging')) {
      expect(springs.snappy.stiffness).toBeGreaterThanOrEqual(springs[preset].stiffness);
    }
  });

  it('paging is critically damped, so a page never overshoots', () => {
    const { damping, stiffness, mass } = springs.paging;
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBe(1);
  });

  it('bouncy has the lowest damping (most overshoot)', () => {
    for (const preset of springNames) {
      expect(springs.bouncy.damping).toBeLessThanOrEqual(springs[preset].damping);
    }
  });
});

// ── Timing presets ──────────────────────────────────────────────────────

describe('timing', () => {
  const timingNames = Object.keys(timing) as TimingPreset[];

  it.each(timingNames)('preset "%s" is a positive number', (preset) => {
    expect(typeof timing[preset]).toBe('number');
    expect(timing[preset]).toBeGreaterThan(0);
  });

  it('instant < fast < normal < slow', () => {
    expect(timing.instant).toBeLessThan(timing.fast);
    expect(timing.fast).toBeLessThan(timing.normal);
    expect(timing.normal).toBeLessThan(timing.slow);
  });

  it('instant is very short (under 100ms)', () => {
    expect(timing.instant).toBeLessThan(100);
  });

  it('slow is reasonable (under 1 second)', () => {
    expect(timing.slow).toBeLessThan(1000);
  });
});
