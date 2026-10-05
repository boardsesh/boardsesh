import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EarlyUpdatesFlagState } from '../../../providers/feature-flags-provider';
import type { OtaBranchKind } from '../qa-surf';

const surf = vi.hoisted(() => ({
  pinEarlyUpdates: vi.fn(),
  clearOtaBranchPin: vi.fn(),
  surfToProduction: vi.fn(),
}));
vi.mock('../qa-surf', () => surf);

const store = vi.hoisted(() => ({ values: {} as Record<string, unknown>, setSetting: vi.fn() }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => store.values[key] ?? false,
  setSetting: store.setSetting,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track: trackMock }));

import {
  applyEarlyUpdatesPin,
  clearEarlyUpdatesPinForFlag,
  decideEarlyUpdatesLaunch,
  returnToOwnTrack,
  setEarlyUpdatesMembership,
  type EarlyUpdatesLaunchInput,
} from '../early-updates';

const MEMBER_ON_PRODUCTION: EarlyUpdatesLaunchInput = {
  surfingBuild: true,
  surfingReady: true,
  flagsResolved: true,
  flag: 'on',
  member: true,
  pinClearedByFlag: false,
  runningBranchKind: 'default',
};

beforeEach(() => {
  vi.clearAllMocks();
  surf.pinEarlyUpdates.mockReset();
  surf.clearOtaBranchPin.mockReset();
  surf.surfToProduction.mockReset();
  store.values = {};
});

describe('decideEarlyUpdatesLaunch', () => {
  it('re-pins a member running the regular track', () => {
    expect(decideEarlyUpdatesLaunch(MEMBER_ON_PRODUCTION)).toBe('pin');
  });

  it('re-pins a member already running an early update', () => {
    // The pin cannot be read back, so "already there" is not knowable. Writing
    // the same headers again costs nothing.
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, runningBranchKind: 'early-updates' })).toBe('pin');
  });

  it.each(['preview', 'staging'] as const)('leaves a member testing a %s bundle alone', (runningBranchKind) => {
    // They chose that branch after joining. Re-pinning would pull a tester off
    // the PR they are in the middle of.
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, runningBranchKind })).toBe('none');
  });

  it('waits for the feature flags', () => {
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, flagsResolved: false })).toBe('wait');
  });

  it('waits for the surfing migration, which clears the override and reloads', () => {
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, surfingReady: false })).toBe('wait');
  });

  it('does nothing on a build that cannot surf', () => {
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, surfingBuild: false })).toBe('none');
  });

  it('clears the pin once when the feature is switched off for a member', () => {
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, flag: 'off' })).toBe('clear');
  });

  it('does not clear a second time', () => {
    // A tester may have pinned a PR preview since. That pin is not ours to drop.
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, flag: 'off', pinClearedByFlag: true })).toBe('none');
  });

  it('neither pins nor clears when PostHog never answered', () => {
    // Offline in a basement gym is not the feature being switched off.
    expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, flag: 'unknown' })).toBe('none');
  });

  // Every combination, against the rule written out the long way.
  const FLAGS: EarlyUpdatesFlagState[] = ['on', 'off', 'unknown'];
  const KINDS: OtaBranchKind[] = ['default', 'preview', 'staging', 'early-updates'];
  const cases = [true, false].flatMap((member) =>
    [true, false].flatMap((flagsResolved) =>
      FLAGS.flatMap((flag) =>
        KINDS.flatMap((runningBranchKind) =>
          [true, false].map((pinClearedByFlag) => ({
            member,
            flagsResolved,
            flag,
            runningBranchKind,
            pinClearedByFlag,
          })),
        ),
      ),
    ),
  );

  it.each(cases)(
    'member=$member resolved=$flagsResolved flag=$flag running=$runningBranchKind cleared=$pinClearedByFlag',
    (overrides) => {
      const action = decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, ...overrides });
      const testing = overrides.runningBranchKind === 'preview' || overrides.runningBranchKind === 'staging';

      if (!overrides.flagsResolved) {
        expect(action).toBe('wait');
      } else if (!overrides.member || testing || overrides.flag === 'unknown') {
        expect(action).toBe('none');
      } else if (overrides.flag === 'on') {
        expect(action).toBe('pin');
      } else {
        expect(action).toBe(overrides.pinClearedByFlag ? 'none' : 'clear');
      }
    },
  );

  it('never pins anyone who has not opted in, whatever else is true', () => {
    for (const overrides of cases.filter((entry) => !entry.member)) {
      expect(decideEarlyUpdatesLaunch({ ...MEMBER_ON_PRODUCTION, ...overrides })).not.toBe('pin');
    }
  });
});

describe('setEarlyUpdatesMembership', () => {
  it('pins, then stores the choice, then reports it', () => {
    setEarlyUpdatesMembership(true);

    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
    expect(store.setSetting).toHaveBeenCalledExactlyOnceWith('earlyUpdates', true);
    expect(surf.pinEarlyUpdates.mock.invocationCallOrder[0]).toBeLessThan(store.setSetting.mock.invocationCallOrder[0]);
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('Early Updates Toggled', { enabled: true });
  });

  it('stores nothing and reports nothing when the pin fails', () => {
    surf.pinEarlyUpdates.mockImplementation(() => {
      throw new Error('Branch surfing is unavailable on this build');
    });

    expect(() => setEarlyUpdatesMembership(true)).toThrow('Branch surfing is unavailable on this build');
    expect(store.setSetting).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('leaving clears the pin without a surf, then stores the choice', () => {
    setEarlyUpdatesMembership(false);

    expect(surf.clearOtaBranchPin).toHaveBeenCalledOnce();
    expect(surf.surfToProduction).not.toHaveBeenCalled();
    expect(store.setSetting).toHaveBeenCalledExactlyOnceWith('earlyUpdates', false);
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('Early Updates Toggled', { enabled: false });
  });

  it('keeps the choice on when clearing the pin fails', () => {
    surf.clearOtaBranchPin.mockImplementation(() => {
      throw new Error('native');
    });

    expect(() => setEarlyUpdatesMembership(false)).toThrow('native');
    expect(store.setSetting).not.toHaveBeenCalled();
  });

  it('joining again forgets an earlier switch-off clear', () => {
    store.values.earlyUpdatesPinClearedByFlag = true;
    setEarlyUpdatesMembership(true);
    expect(store.setSetting).toHaveBeenCalledWith('earlyUpdatesPinClearedByFlag', false);
  });
});

describe('launch pin and clear', () => {
  it('re-pins without a settings write or an event on an ordinary launch', () => {
    applyEarlyUpdatesPin();

    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
    expect(store.setSetting).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('clears for the flag, keeps the choice, and remembers it cleared', () => {
    clearEarlyUpdatesPinForFlag();

    expect(surf.clearOtaBranchPin).toHaveBeenCalledOnce();
    // The choice is untouched, so the member is back when the flag is.
    expect(store.setSetting).toHaveBeenCalledExactlyOnceWith('earlyUpdatesPinClearedByFlag', true);
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('returnToOwnTrack', () => {
  it('takes a non-member back to production the way it always did', async () => {
    surf.surfToProduction.mockResolvedValue('nothing-to-load');

    await expect(returnToOwnTrack(false)).resolves.toBe('nothing-to-load');
    expect(surf.pinEarlyUpdates).not.toHaveBeenCalled();
  });

  it('takes a member back to early updates, pin only', async () => {
    await expect(returnToOwnTrack(true)).resolves.toBe('early-updates-next-launch');

    expect(surf.pinEarlyUpdates).toHaveBeenCalledOnce();
    // No production surf: that would clear the pin and could reload the app.
    expect(surf.surfToProduction).not.toHaveBeenCalled();
  });

  it('rejects, not throws, when the pin fails', async () => {
    surf.pinEarlyUpdates.mockImplementation(() => {
      throw new Error('native');
    });
    await expect(returnToOwnTrack(true)).rejects.toThrow('native');
  });
});
