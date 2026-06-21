import { describe, it, expect } from 'vitest';

import { resolveFavoriteRollback } from '../favorite-rollback';

// A failed favorite toggle rolls the optimistic override back to its pre-tap
// value — but only when that optimistic value is still the one on screen. A
// newer tap or a climb change (which resets the override to null) must win over
// a late error, otherwise the heart diverges from what the user sees.
describe('resolveFavoriteRollback', () => {
  it('rolls back to the previous value when our optimistic flip is still shown', () => {
    // Tapped an unfavorited climb (previous null → optimistic true); the toggle
    // failed and nothing else moved the heart, so undo back to null.
    expect(resolveFavoriteRollback(true, true, null)).toBe(null);
    // Same, starting from a concrete previous override.
    expect(resolveFavoriteRollback(false, false, true)).toBe(true);
  });

  it('leaves a newer tap untouched instead of clobbering it', () => {
    // First tap set optimistic true, a second tap has since moved the override
    // back to false. The first tap's late error must not resurrect null.
    expect(resolveFavoriteRollback(false, true, null)).toBe(false);
  });

  it('does not resurrect a stale value onto a climb that has since changed', () => {
    // The climb changed mid-flight, resetting the override to null. A late error
    // from the previous climb must leave the new climb showing its own status.
    expect(resolveFavoriteRollback(null, true, false)).toBe(null);
  });
});
