// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const surf = vi.hoisted(() => ({
  runningBranch: null as string | null,
  pinEarlyUpdates: vi.fn(),
  clearOtaBranchPin: vi.fn(),
  surfToProduction: vi.fn(),
}));
// A copy of `otaBranchKind` (the real one is covered in qa-surf.test.ts), so
// these cases can be written with the branch NAMES a phone actually runs
// without loading xprem's sources.
vi.mock('../../../lib/qa/qa-surf', async () => {
  const { parsePrBranch } = await import('../../../lib/qa/pr-branch');
  return {
    readRunningOtaBranch: () => surf.runningBranch,
    otaBranchKind: (branch: string | null) => {
      if (branch === 'pr-beta') return 'early-updates';
      if (branch === 'pr-staging') return 'staging';
      return parsePrBranch(branch) === null ? 'default' : 'preview';
    },
    pinEarlyUpdates: surf.pinEarlyUpdates,
    clearOtaBranchPin: surf.clearOtaBranchPin,
    surfToProduction: surf.surfToProduction,
  };
});

const settingsStore = vi.hoisted(() => ({ values: {} as Record<string, boolean> }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => settingsStore.values[key] ?? false,
  setSetting: (key: string, value: boolean) => {
    settingsStore.values[key] = value;
  },
}));

const surfingCtrl = vi.hoisted(() => ({ surfingBuild: true, ready: true }));
vi.mock('../../../lib/ota-branch-surfing-state', () => ({ useOtaBranchSurfingState: () => surfingCtrl }));

const flagsCtrl = vi.hoisted(() => ({ state: 'on' as 'on' | 'off' | 'unknown', resolved: true }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useEarlyUpdatesFlagState: () => flagsCtrl.state,
  useFeatureFlagsResolved: () => flagsCtrl.resolved,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError }));

import { EarlyUpdatesLaunchSync } from '../EarlyUpdatesLaunchSync';

beforeEach(() => {
  vi.clearAllMocks();
  surf.pinEarlyUpdates.mockReset();
  surf.clearOtaBranchPin.mockReset();
  surf.runningBranch = null;
  settingsStore.values = { earlyUpdates: true };
  surfingCtrl.surfingBuild = true;
  surfingCtrl.ready = true;
  flagsCtrl.state = 'on';
  flagsCtrl.resolved = true;
});

describe('EarlyUpdatesLaunchSync', () => {
  it('re-pins a member at launch, silently', () => {
    render(<EarlyUpdatesLaunchSync />);

    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
    // The launch re-pin is not a toggle, and it never surfs.
    expect(trackMock).not.toHaveBeenCalled();
    expect(surf.surfToProduction).not.toHaveBeenCalled();
  });

  it('re-pins a member whose pin a failed surf or an old verdict cleared', () => {
    // The next launch after the pin was lost: the regular track is running
    // again, and the stored choice puts the pin back.
    surf.runningBranch = null;
    render(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('re-pins a member running an early update', () => {
    surf.runningBranch = 'pr-beta';
    render(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });

  it.each(['pr-123', 'pr-staging'])('does not pull a member off %s', (runningBranch) => {
    surf.runningBranch = runningBranch;
    render(<EarlyUpdatesLaunchSync />);

    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();
    expect(surf.clearOtaBranchPin).not.toHaveBeenCalled();
  });

  it('leaves everyone who has not joined alone', () => {
    settingsStore.values = {};
    render(<EarlyUpdatesLaunchSync />);

    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();
    expect(surf.clearOtaBranchPin).not.toHaveBeenCalled();
  });

  it('waits for the flags, then pins once', () => {
    flagsCtrl.resolved = false;
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();

    flagsCtrl.resolved = true;
    rerender(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('waits for the surfing migration, whose reload would wipe the pin', () => {
    surfingCtrl.ready = false;
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();

    surfingCtrl.ready = true;
    rerender(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('pins once per launch, however often it re-renders', () => {
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    flagsCtrl.state = 'unknown';
    rerender(<EarlyUpdatesLaunchSync />);
    flagsCtrl.state = 'on';
    rerender(<EarlyUpdatesLaunchSync />);

    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('switched off: clears the pin once and keeps the choice', () => {
    flagsCtrl.state = 'off';
    const first = render(<EarlyUpdatesLaunchSync />);

    expect(surf.clearOtaBranchPin).toHaveBeenCalledOnce();
    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();
    expect(settingsStore.values.earlyUpdates).toBe(true);
    first.unmount();

    // The next launch, still switched off. A tester may have pinned a PR by
    // now, so the override is no longer ours to clear.
    render(<EarlyUpdatesLaunchSync />);
    expect(surf.clearOtaBranchPin).toHaveBeenCalledOnce();
  });

  it('switched back on: the member is pinned again without lifting a finger', () => {
    flagsCtrl.state = 'off';
    render(<EarlyUpdatesLaunchSync />).unmount();

    flagsCtrl.state = 'on';
    render(<EarlyUpdatesLaunchSync />);

    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
    expect(settingsStore.values.earlyUpdatesPinClearedByFlag).toBe(false);
  });

  it('a stale "off" followed by the real answer in the same launch ends pinned', () => {
    flagsCtrl.state = 'off';
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    expect(surf.clearOtaBranchPin).toHaveBeenCalledOnce();

    flagsCtrl.state = 'on';
    rerender(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('does not drop a member when PostHog never answers', () => {
    flagsCtrl.state = 'unknown';
    render(<EarlyUpdatesLaunchSync />);

    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();
    expect(surf.clearOtaBranchPin).not.toHaveBeenCalled();
  });

  it('does nothing on a build that cannot surf', () => {
    surfingCtrl.surfingBuild = false;
    render(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();
  });

  it('swallows a failed header write and tries again next launch', () => {
    surf.pinEarlyUpdates.mockImplementation(() => {
      throw new Error('native');
    });
    expect(() => render(<EarlyUpdatesLaunchSync />).unmount()).not.toThrow();
    expect(reportHandledError).toHaveBeenCalledOnce();

    surf.pinEarlyUpdates.mockReset();
    render(<EarlyUpdatesLaunchSync />);
    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
  });
});
