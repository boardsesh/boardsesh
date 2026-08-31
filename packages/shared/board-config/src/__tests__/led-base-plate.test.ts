import { describe, expect, it } from 'vitest';
import { hasLedBasePlate } from '../led-base-plate';

describe('hasLedBasePlate', () => {
  it('answers true for the Kilter Homewall, whose art carries a two-tone plate', () => {
    expect(hasLedBasePlate('kilter', 8)).toBe(true);
  });

  it('answers false for the Kilter Original, which bolts holds straight to the panel', () => {
    // Same board, different layout — which is the whole reason this is keyed by
    // layout rather than by board name.
    expect(hasLedBasePlate('kilter', 1)).toBe(false);
  });

  it('answers false for boards with no plated layout at all', () => {
    expect(hasLedBasePlate('tension', 10)).toBe(false);
    expect(hasLedBasePlate('moonboard', 1)).toBe(false);
    expect(hasLedBasePlate('woods', 1)).toBe(false);
  });

  it('is case-insensitive on the board name', () => {
    expect(hasLedBasePlate('Kilter', 8)).toBe(true);
  });

  it('answers false rather than throwing for an unknown or missing board', () => {
    // The editor resolves the board from a route param, so a hand-built deep link
    // can land here with anything. Defaulting to false hides a mode; defaulting to
    // true would offer one that traces nothing.
    expect(hasLedBasePlate('not-a-board', 8)).toBe(false);
    expect(hasLedBasePlate(undefined, 8)).toBe(false);
  });
});
