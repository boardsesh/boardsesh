import { describe, expect, it } from 'vitest';
import { materialStepCount } from '../MoreForm.slider';

// Material3 counts the values BETWEEN the endpoints; SwiftUI takes the increment.
// Getting this wrong is invisible in a screenshot — the thumb just refuses to
// land on the last value — so every real slider bound in the app is pinned here.
describe('materialStepCount', () => {
  it.each([
    // [name, min, max, step, expected steps, expected selectable values]
    ['glowReach', 0.5, 2, 0.1, 14, 16],
    ['plateauShare', 0.2, 0.7, 0.05, 9, 11],
    ['veilOpacity', 0, 0.9, 0.05, 17, 19],
    ['fillOpacity', 0.3, 0.9, 0.05, 11, 13],
    ['brushThickness', 0.5, 2, 0.1, 14, 16],
    ['shapeSize', 0.5, 2, 0.1, 14, 16],
  ])('%s spans %d..%d by %d → %d steps', (_name, min, max, step, expected, selectable) => {
    expect(materialStepCount(min, max, step)).toBe(expected);
    // The identity that makes the conversion legible: steps are the gaps between
    // the selectable values, minus the two endpoints.
    expect(materialStepCount(min, max, step)).toBe(selectable - 2);
  });

  it('treats a degenerate step as continuous rather than dividing by zero', () => {
    expect(materialStepCount(0, 1, 0)).toBe(0);
    expect(materialStepCount(0, 1, Number.NaN)).toBe(0);
    expect(materialStepCount(0, 1, -0.1)).toBe(0);
  });

  it('never returns a negative count when the step exceeds the range', () => {
    expect(materialStepCount(0, 0.1, 1)).toBe(0);
  });
});
