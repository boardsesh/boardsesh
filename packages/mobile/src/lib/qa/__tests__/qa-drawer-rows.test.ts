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
    expect(runningQaPrNumberToOffer(4792, 'user-a')).toBe(4792);
  });

  it('offers nothing on production', () => {
    expect(runningQaPrNumberToOffer(null, 'user-a')).toBeNull();
  });

  it('offers nothing while the signed-in account is still unknown', () => {
    // A marker read without an owner is a marker read for whoever happens to
    // have used this device last.
    expect(runningQaPrNumberToOffer(4792, undefined)).toBeNull();
  });

  it('stops offering once this account has signed off this exact bundle', () => {
    // The marker, not a reload, is what ends the job: `surfTo(config, null)`
    // usually answers `nothing-to-load`, so the tester keeps running the preview
    // they just filed a verdict on.
    settings.qaVerdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    expect(runningQaPrNumberToOffer(4792, 'user-a')).toBeNull();
  });

  it('still offers a bundle a DIFFERENT tester signed off on this device', () => {
    // The settings store is device-wide. Without the account in the key, tester
    // A's sign-off silently hid tester B's "Finish testing" row.
    settings.qaVerdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    expect(runningQaPrNumberToOffer(4792, 'user-b')).toBe(4792);
  });

  it('offers again after the author publishes a new bundle', () => {
    settings.qaVerdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    updates.updateId = 'bundle-b';
    expect(runningQaPrNumberToOffer(4792, 'user-a')).toBe(4792);
  });

  it('ignores a marker left over from a different branch', () => {
    settings.qaVerdictSubmittedKey = 'user-a:pr-1:bundle-a';
    expect(runningQaPrNumberToOffer(4792, 'user-a')).toBe(4792);
  });

  it('ignores an unscoped marker left by a build before this change', () => {
    // Nothing migrates the old two-part keys; they re-arm the row once, which is
    // the right answer for a marker whose owner cannot be established.
    settings.qaVerdictSubmittedKey = 'pr-4792:bundle-a';
    expect(runningQaPrNumberToOffer(4792, 'user-a')).toBe(4792);
  });

  it('matches an embedded launch by its stand-in token', () => {
    // No updateId means the bundle baked into the binary, which cannot change
    // without a new build — one stable token per branch is exactly right.
    updates.updateId = null;
    settings.qaVerdictSubmittedKey = 'user-a:pr-4792:embedded';
    expect(runningQaPrNumberToOffer(4792, 'user-a')).toBeNull();
  });
});
