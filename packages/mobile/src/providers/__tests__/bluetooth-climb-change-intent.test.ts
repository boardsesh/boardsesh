import { describe, it, expect } from 'vitest';
import { shouldSuppressClimbChangeIntent, createClimbChangeIntentArmer } from '../bluetooth-climb-change-intent';

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

describe('createClimbChangeIntentArmer', () => {
  it('returns null when nothing has been marked', () => {
    const armer = createClimbChangeIntentArmer(5_000);
    expect(armer.consume(0)).toBeNull();
  });

  it('returns the marked intent once, then null — one-shot', () => {
    const armer = createClimbChangeIntentArmer(5_000);
    armer.mark('swipe', 1_000);
    expect(armer.consume(1_100)).toBe('swipe');
    expect(armer.consume(1_200)).toBeNull();
  });

  it('returns null once the TTL has elapsed, and still clears the tag', () => {
    const armer = createClimbChangeIntentArmer(5_000);
    armer.mark('tap', 1_000);
    // Consumed exactly at the deadline: still valid (<=).
    expect(armer.consume(6_000)).toBe('tap');

    armer.mark('tap', 1_000);
    // Consumed past the deadline: expired.
    expect(armer.consume(6_001)).toBeNull();
    // The expired tag was still cleared — a later consume doesn't resurrect it.
    expect(armer.consume(6_002)).toBeNull();
  });

  it('a later mark() replaces an earlier unconsumed one — only the latest tag survives', () => {
    const armer = createClimbChangeIntentArmer(5_000);
    armer.mark('swipe', 1_000);
    armer.mark('tap', 1_001);
    expect(armer.consume(1_002)).toBe('tap');
  });

  it('re-arms its own TTL window on every mark(), independent of prior marks', () => {
    // A mark 4s in still expires 5s after ITS OWN timestamp, not the first
    // mark's — covers the regression this armer replaced (a settings toggle
    // spuriously consuming/clearing the tag before the real queue-item
    // change landed): re-marking must fully reset the deadline.
    const armer = createClimbChangeIntentArmer(5_000);
    armer.mark('swipe', 1_000);
    armer.mark('swipe', 5_000);
    expect(armer.consume(9_999)).toBe('swipe');
  });
});
