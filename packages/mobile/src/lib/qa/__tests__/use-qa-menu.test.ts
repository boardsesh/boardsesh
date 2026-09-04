// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  surfingBuild: true,
  profileId: 'user-a' as string | undefined,
  runningPrNumber: null as number | null,
  verdictSubmittedKey: null as string | null,
}));

vi.mock('expo-updates', () => ({
  get updateId() {
    return 'bundle-a';
  },
}));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => (key === 'qaVerdictSubmittedKey' ? state.verdictSubmittedKey : null),
}));
vi.mock('../../graphql/hooks', () => ({
  useProfile: () => ({ data: state.profileId === undefined ? undefined : { id: state.profileId } }),
}));
vi.mock('../../ota-branch-surfing-state', () => ({
  useOtaBranchSurfingState: () => ({ surfingBuild: state.surfingBuild, ready: true }),
}));
vi.mock('../qa-surf', () => ({
  readRunningPrNumber: () => state.runningPrNumber,
}));

import { useQaMenu } from '../use-qa-menu';

beforeEach(() => {
  state.surfingBuild = true;
  state.profileId = 'user-a';
  state.runningPrNumber = null;
  state.verdictSubmittedKey = null;
});

describe('useQaMenu', () => {
  // The whole point of the change: the entry point is the only surface that can
  // SAY "previews are switched off" / "nothing to test", and hiding it behind
  // the tester role made those two states indistinguishable from no button.
  it('offers the entry point without the tester role', () => {
    const { result } = renderHook(() => useQaMenu());
    expect(result.current.show).toBe(true);
  });

  it('offers it to a signed-out user too, since surfing needs no account', () => {
    state.profileId = undefined;
    const { result } = renderHook(() => useQaMenu());
    expect(result.current.show).toBe(true);
  });

  it('hides it on a binary that cannot surf', () => {
    // Not a permission check — the row would offer something the app is
    // physically unable to do.
    state.surfingBuild = false;
    const { result } = renderHook(() => useQaMenu());
    expect(result.current.show).toBe(false);
  });

  it('names the running preview so the menu can offer to finish it', () => {
    state.runningPrNumber = 4792;
    const { result } = renderHook(() => useQaMenu());
    expect(result.current.prNumber).toBe(4792);
  });

  it('offers no PR on production', () => {
    const { result } = renderHook(() => useQaMenu());
    expect(result.current.prNumber).toBeNull();
  });

  it('drops back to the picker once this account has signed off this bundle', () => {
    state.runningPrNumber = 4792;
    state.verdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    const { result } = renderHook(() => useQaMenu());
    expect(result.current.show).toBe(true);
    expect(result.current.prNumber).toBeNull();
  });
});
