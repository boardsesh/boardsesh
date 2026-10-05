// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  earlyUpdates: false,
  otaPinnedBranch: null as string | null,
  runningBranch: null as string | null,
  surfingBuild: true,
  flag: 'on' as 'on' | 'off' | 'unknown',
}));
vi.mock('../../../settings/hooks', () => ({
  useSetting: (key: 'earlyUpdates' | 'otaPinnedBranch') => [state[key], vi.fn()],
}));
vi.mock('../../ota-branch-surfing-state', () => ({
  useOtaBranchSurfingState: () => ({ surfingBuild: state.surfingBuild, ready: true }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useEarlyUpdatesFlagState: () => state.flag,
  useFeatureFlagsResolved: () => true,
}));
// The real classifier and constants; only the native read is stood in for.
vi.mock('expo-updates', () => ({ isEmbeddedLaunch: false, manifest: { extra: {} } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { updates: {} } } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@xprem/control-center/src/surf', () => ({ surfTo: vi.fn() }));
vi.mock('@xprem/control-center/src/config', () => ({ BRANCH_HEADER: 'xprem-branch' }));
vi.mock('../../legacy-ota-channel-migration', () => ({ isBranchSurfingBuild: () => true }));
vi.mock('../../../settings', () => ({ getSetting: () => null, setSetting: vi.fn() }));
vi.mock('../../analytics', () => ({ track: vi.fn() }));
vi.mock('../qa-surf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../qa-surf')>()),
  readRunningOtaBranch: () => state.runningBranch,
}));

import {
  earlyUpdatesRowState,
  isEarlyUpdatesMember,
  useEarlyUpdatesMember,
  useEarlyUpdatesRow,
} from '../use-early-updates';

beforeEach(() => {
  state.earlyUpdates = false;
  state.otaPinnedBranch = null;
  state.runningBranch = null;
  state.surfingBuild = true;
  state.flag = 'on';
});

describe('earlyUpdatesRowState', () => {
  it.each([
    [false, null, 'default', 'off'],
    [true, 'pr-beta', 'early-updates', 'on'],
    // Asked for, but the phone is not on the branch: never plain "on".
    [true, null, 'default', 'waiting'],
    // Switched off, but still on the branch until a regular update is fetched.
    [false, 'pr-beta', 'early-updates', 'leaving'],
    // Joined this session: pinned, the regular bundle still running.
    [true, 'pr-beta', 'default', 'on'],
    [true, 'pr-123', 'preview', 'testing'],
    [false, 'pr-staging', 'staging', 'testing'],
    // A surf that loaded nothing: the preview owns the pin, whatever is running.
    [true, 'pr-123', 'default', 'testing'],
    // A preview pinned before the record existed.
    [true, null, 'preview', 'testing'],
  ] as const)('choice=%s pinned=%s running=%s is %s', (choice, pinnedBranch, runningBranchKind, expected) => {
    expect(earlyUpdatesRowState({ choice, pinnedBranch, runningBranchKind })).toBe(expected);
  });
});

describe('isEarlyUpdatesMember', () => {
  it('is the choice, unless the flag says off', () => {
    expect(isEarlyUpdatesMember(true, 'on')).toBe(true);
    expect(isEarlyUpdatesMember(true, 'off')).toBe(false);
    expect(isEarlyUpdatesMember(false, 'on')).toBe(false);
  });

  it('still counts a member whose flag has not resolved', () => {
    // A tester leaving a preview in the first seconds of a cold start must not
    // be sent to production because PostHog has not answered yet.
    expect(isEarlyUpdatesMember(true, 'unknown')).toBe(true);
  });

  it('is what the hook returns', () => {
    state.earlyUpdates = true;
    state.flag = 'unknown';
    expect(renderHook(() => useEarlyUpdatesMember()).result.current).toBe(true);
    state.flag = 'off';
    expect(renderHook(() => useEarlyUpdatesMember()).result.current).toBe(false);
  });
});

describe('useEarlyUpdatesRow', () => {
  it.each(['off', 'unknown'] as const)('hides the section while the flag is %s', (flag) => {
    // Ships dark: no value and off both read as hidden.
    state.flag = flag;
    state.earlyUpdates = true;
    expect(renderHook(() => useEarlyUpdatesRow()).result.current.show).toBe(false);
  });

  it('hides the section on a build that cannot surf', () => {
    state.surfingBuild = false;
    expect(renderHook(() => useEarlyUpdatesRow()).result.current.show).toBe(false);
  });

  it('offers the section and hands the sync what it needs', () => {
    const { result } = renderHook(() => useEarlyUpdatesRow());

    expect(result.current).toEqual({
      show: true,
      state: 'off',
      environment: { surfingBuild: true, surfingReady: true, flagsResolved: true, flag: 'on' },
    });
  });

  it('reads the state from settings and the running bundle, with no request', () => {
    state.earlyUpdates = true;
    expect(renderHook(() => useEarlyUpdatesRow()).result.current.state).toBe('waiting');

    state.otaPinnedBranch = 'pr-beta';
    expect(renderHook(() => useEarlyUpdatesRow()).result.current.state).toBe('on');

    state.otaPinnedBranch = null;
    state.runningBranch = 'pr-4792';
    expect(renderHook(() => useEarlyUpdatesRow()).result.current.state).toBe('testing');
  });

  it('keeps the environment reference-stable across renders', () => {
    const { result, rerender } = renderHook(() => useEarlyUpdatesRow());
    const first = result.current.environment;
    rerender();
    expect(result.current.environment).toBe(first);
  });
});
