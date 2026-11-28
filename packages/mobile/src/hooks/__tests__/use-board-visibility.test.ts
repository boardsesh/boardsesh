import { describe, expect, it, vi } from 'vitest';

// Only the pure mapping is under test; the provider's own imports stay out.
vi.mock('../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => undefined }));

import { launchFlagsFromBits } from '../use-board-visibility';

// One launch flag ships today, so these are the only cases that reach a bit past the first.
describe('launchFlagsFromBits', () => {
  const launchFlags = ['flag-a', 'flag-b', 'flag-c'];

  it('reads each launch flag from the bit at its own position', () => {
    expect(launchFlagsFromBits(launchFlags, 0b101)).toEqual({ 'flag-a': true, 'flag-b': false, 'flag-c': true });
    expect(launchFlagsFromBits(launchFlags, 0b010)).toEqual({ 'flag-a': false, 'flag-b': true, 'flag-c': false });
    expect(launchFlagsFromBits(launchFlags, 0)).toEqual({ 'flag-a': false, 'flag-b': false, 'flag-c': false });
  });

  it('reaches the 31st flag without touching the first', () => {
    const manyLaunchFlags = Array.from({ length: 31 }, (_unused, flagIndex) => `flag-${flagIndex}`);
    const enabledFlags = Object.entries(launchFlagsFromBits(manyLaunchFlags, 1 << 30)).filter(([, enabled]) => enabled);
    expect(enabledFlags).toEqual([['flag-30', true]]);
  });
});
