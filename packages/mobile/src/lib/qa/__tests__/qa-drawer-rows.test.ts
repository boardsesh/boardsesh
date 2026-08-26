import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates = vi.hoisted(() => ({ updateId: 'bundle-a' as string | null }));
const settings = vi.hoisted(() => ({ qaVerdictSubmittedKey: null as string | null }));

vi.mock('expo-updates', () => ({
  get updateId() {
    return updates.updateId;
  },
}));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => (key === 'qaVerdictSubmittedKey' ? settings.qaVerdictSubmittedKey : null),
}));

import { runningQaPrNumberToOffer } from '../qa-drawer-rows';

beforeEach(() => {
  updates.updateId = 'bundle-a';
  settings.qaVerdictSubmittedKey = null;
});

describe('runningQaPrNumberToOffer', () => {
  it('offers the running preview when no verdict has been filed', () => {
    expect(runningQaPrNumberToOffer(4792)).toBe(4792);
  });

  it('offers nothing on production', () => {
    expect(runningQaPrNumberToOffer(null)).toBeNull();
  });

  it('stops offering once this exact bundle has been signed off', () => {
    // The marker, not a reload, is what ends the job: `surfTo(config, null)`
    // usually answers `nothing-to-load`, so the tester keeps running the preview
    // they just filed a verdict on.
    settings.qaVerdictSubmittedKey = 'pr-4792:bundle-a';
    expect(runningQaPrNumberToOffer(4792)).toBeNull();
  });

  it('offers again after the author publishes a new bundle', () => {
    settings.qaVerdictSubmittedKey = 'pr-4792:bundle-a';
    updates.updateId = 'bundle-b';
    expect(runningQaPrNumberToOffer(4792)).toBe(4792);
  });

  it('ignores a marker left over from a different branch', () => {
    settings.qaVerdictSubmittedKey = 'pr-1:bundle-a';
    expect(runningQaPrNumberToOffer(4792)).toBe(4792);
  });

  it('matches an embedded launch by its stand-in token', () => {
    // No updateId means the bundle baked into the binary, which cannot change
    // without a new build — one stable token per branch is exactly right.
    updates.updateId = null;
    settings.qaVerdictSubmittedKey = 'pr-4792:embedded';
    expect(runningQaPrNumberToOffer(4792)).toBeNull();
  });
});
