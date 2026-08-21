import { describe, it, expect } from 'vitest';
import { shouldSuppressClimbChangeIntent } from '../bluetooth-climb-change-intent';

describe('shouldSuppressClimbChangeIntent', () => {
  it('never suppresses an untagged change, regardless of the settings', () => {
    expect(shouldSuppressClimbChangeIntent(null, { lightOnSwipe: true, lightOnClimbTap: true })).toBe(false);
    expect(shouldSuppressClimbChangeIntent(null, { lightOnSwipe: false, lightOnClimbTap: false })).toBe(false);
  });

  it('suppresses a swipe-tagged change only when lightOnSwipe is off', () => {
    expect(shouldSuppressClimbChangeIntent('swipe', { lightOnSwipe: true, lightOnClimbTap: false })).toBe(false);
    expect(shouldSuppressClimbChangeIntent('swipe', { lightOnSwipe: false, lightOnClimbTap: true })).toBe(true);
  });

  it('suppresses a tap-tagged change only when lightOnClimbTap is off', () => {
    expect(shouldSuppressClimbChangeIntent('tap', { lightOnSwipe: false, lightOnClimbTap: true })).toBe(false);
    expect(shouldSuppressClimbChangeIntent('tap', { lightOnSwipe: true, lightOnClimbTap: false })).toBe(true);
  });

  it('a swipe tag ignores lightOnClimbTap and a tap tag ignores lightOnSwipe', () => {
    // Each tag is gated by its own setting only — the other setting's value
    // must not leak into the decision.
    expect(shouldSuppressClimbChangeIntent('swipe', { lightOnSwipe: true, lightOnClimbTap: false })).toBe(false);
    expect(shouldSuppressClimbChangeIntent('tap', { lightOnSwipe: false, lightOnClimbTap: true })).toBe(false);
  });
});
