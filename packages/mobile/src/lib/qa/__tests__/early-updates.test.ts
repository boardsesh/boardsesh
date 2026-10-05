import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EarlyUpdatesFlagState } from '../../../providers/feature-flags-provider';
import type { OtaBranchKind } from '../qa-surf';

// qa-surf's native and network edges are stood in for; its pure parts
// (`otaBranchKind`, the branch constants) are the real ones, so the policy
// below is tested against the classifier it actually ships with. What a switch
// does to a device is covered end to end in ota-track-sequences.test.ts.
const surf = vi.hoisted(() => ({
  pinnedBranch: null as string | null,
  runningBranch: null as string | null,
  emergencyLaunch: false,
  fetchQaBranches: vi.fn(),
  joinEarlyUpdatesTrack: vi.fn(),
  leaveForProductionTrack: vi.fn(),
  surfToProduction: vi.fn(),
}));
vi.mock('expo-updates', () => ({ isEmbeddedLaunch: false, manifest: { extra: {} } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { updates: {} } } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@xprem/control-center/src/surf', () => ({ surfTo: vi.fn() }));
vi.mock('@xprem/control-center/src/config', () => ({
  BRANCH_HEADER: 'xprem-branch',
  readConfig: vi.fn(),
  readLoadedState: vi.fn(),
}));
vi.mock('../../legacy-ota-channel-migration', () => ({ isBranchSurfingBuild: () => true }));
vi.mock('../qa-surf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../qa-surf')>()),
  readOtaPinnedBranch: () => surf.pinnedBranch,
  readRunningOtaBranch: () => surf.runningBranch,
  readIsEmergencyLaunch: () => surf.emergencyLaunch,
  fetchQaBranches: surf.fetchQaBranches,
  joinEarlyUpdatesTrack: surf.joinEarlyUpdatesTrack,
  leaveForProductionTrack: surf.leaveForProductionTrack,
  surfToProduction: surf.surfToProduction,
}));

const store = vi.hoisted(() => ({ values: {} as Record<string, unknown>, setSetting: vi.fn() }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => store.values[key] ?? (key === 'earlyUpdates' ? false : null),
  setSetting: store.setSetting,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track: trackMock }));

import {
  decideEarlyUpdatesSync,
  noteBranchSurfingOff,
  returnToOwnTrack,
  setEarlyUpdatesChoice,
  syncEarlyUpdates,
  type EarlyUpdatesSyncInput,
} from '../early-updates';

const WANTS_IN: EarlyUpdatesSyncInput = {
  surfingBuild: true,
  surfingReady: true,
  flagsResolved: true,
  flag: 'on',
  choice: true,
  pinnedBranch: null,
  runningBranchKind: 'default',
  emergencyLaunch: false,
};
const MEMBER: EarlyUpdatesSyncInput = { ...WANTS_IN, pinnedBranch: 'pr-beta', runningBranchKind: 'early-updates' };
const ENVIRONMENT = { surfingBuild: true, surfingReady: true, flagsResolved: true, flag: 'on' } as const;

function offered(earlyUpdates: boolean) {
  return {
    kind: 'listed',
    list: { previews: [], staging: null, earlyUpdates: earlyUpdates ? { lastUpdateAt: '2026-10-05' } : null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  surf.pinnedBranch = null;
  surf.runningBranch = null;
  surf.emergencyLaunch = false;
  surf.fetchQaBranches.mockReset().mockResolvedValue(offered(true));
  surf.joinEarlyUpdatesTrack.mockReset().mockResolvedValue('switched');
  surf.leaveForProductionTrack.mockReset().mockResolvedValue('switched');
  surf.surfToProduction.mockReset().mockResolvedValue('nothing-to-load');
  store.values = {};
});

describe('decideEarlyUpdatesSync', () => {
  it('joins when the choice is on and the phone is not on the branch', () => {
    expect(decideEarlyUpdatesSync(WANTS_IN)).toBe('join');
  });

  it('does nothing for a member who is already on the branch', () => {
    expect(decideEarlyUpdatesSync(MEMBER)).toBe('none');
  });

  it('leaves when the choice went off while pinned', () => {
    expect(decideEarlyUpdatesSync({ ...MEMBER, choice: false })).toBe('leave');
  });

  it('leaves when the feature is switched off for a member', () => {
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'off' })).toBe('leave');
  });

  it('acts on the flag going off before it looks at which bundle is running', () => {
    // Our own pin, so a preview bundle still on screen is no reason to keep it.
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'off', runningBranchKind: 'preview' })).toBe('leave');
  });

  it('leaves to repair a pin that has nothing stamped for it', () => {
    expect(decideEarlyUpdatesSync({ ...MEMBER, emergencyLaunch: true, runningBranchKind: 'default' })).toBe('leave');
  });

  it.each(['pr-123', 'pr-staging'])("stands down while a tester's %s pin owns the header", (pinnedBranch) => {
    // Whatever is running: a surf that loaded nothing leaves the regular bundle
    // on screen with the preview pinned.
    for (const runningBranchKind of ['default', 'preview', 'staging', 'early-updates'] as const) {
      expect(decideEarlyUpdatesSync({ ...WANTS_IN, pinnedBranch, runningBranchKind })).toBe('none');
      expect(decideEarlyUpdatesSync({ ...WANTS_IN, pinnedBranch, runningBranchKind, flag: 'off' })).toBe('none');
    }
  });

  it.each(['preview', 'staging'] as const)(
    'stands down on a running %s bundle the record does not know',
    (runningBranchKind) => {
      expect(decideEarlyUpdatesSync({ ...WANTS_IN, runningBranchKind })).toBe('none');
    },
  );

  it('waits for the feature flags and for the surfing migration', () => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, flagsResolved: false })).toBe('wait');
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, surfingReady: false })).toBe('wait');
    expect(decideEarlyUpdatesSync({ ...MEMBER, choice: false, flagsResolved: false })).toBe('wait');
  });

  it('does nothing on a build that cannot surf', () => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, surfingBuild: false })).toBe('none');
  });

  it('moves nobody on a flag with no value', () => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, flag: 'unknown' })).toBe('none');
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'unknown' })).toBe('none');
  });

  // Every combination, against the rule written out the long way.
  const FLAGS: EarlyUpdatesFlagState[] = ['on', 'off', 'unknown'];
  const KINDS: OtaBranchKind[] = ['default', 'preview', 'staging', 'early-updates'];
  const PINS = [null, 'pr-beta', 'pr-123', 'pr-staging'];
  const cases = [true, false].flatMap((choice) =>
    FLAGS.flatMap((flag) =>
      PINS.flatMap((pinnedBranch) =>
        KINDS.flatMap((runningBranchKind) =>
          [true, false].map((emergencyLaunch) => ({ choice, flag, pinnedBranch, runningBranchKind, emergencyLaunch })),
        ),
      ),
    ),
  );

  it.each(cases)(
    'choice=$choice flag=$flag pinned=$pinnedBranch running=$runningBranchKind emergency=$emergencyLaunch',
    (overrides) => {
      const action = decideEarlyUpdatesSync({ ...WANTS_IN, ...overrides });
      const testerOwnsPin = overrides.pinnedBranch === 'pr-123' || overrides.pinnedBranch === 'pr-staging';
      const previewRunning = overrides.runningBranchKind === 'preview' || overrides.runningBranchKind === 'staging';

      if (overrides.pinnedBranch === 'pr-beta') {
        const mustLeave = !overrides.choice || overrides.flag === 'off' || overrides.emergencyLaunch;
        expect(action).toBe(mustLeave ? 'leave' : 'none');
      } else if (testerOwnsPin || previewRunning) {
        expect(action).toBe('none');
      } else {
        expect(action).toBe(overrides.choice && overrides.flag === 'on' ? 'join' : 'none');
      }
    },
  );

  it("never touches a tester's pin, and never joins anyone who has not opted in", () => {
    for (const overrides of cases) {
      const action = decideEarlyUpdatesSync({ ...WANTS_IN, ...overrides });
      if (overrides.pinnedBranch === 'pr-123' || overrides.pinnedBranch === 'pr-staging') expect(action).toBe('none');
      if (!overrides.choice) expect(action).not.toBe('join');
    }
  });
});

describe('syncEarlyUpdates', () => {
  beforeEach(() => {
    store.values.earlyUpdates = true;
  });

  it('asks the server for the branch, then joins', async () => {
    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('joined');

    // The newest page is enough: the branch publishes on every merge.
    expect(surf.fetchQaBranches).toHaveBeenCalledExactlyOnceWith(undefined, { wholeList: false });
    expect(surf.joinEarlyUpdatesTrack).toHaveBeenCalledOnce();
  });

  it('does not pin a branch the server does not offer this binary', async () => {
    surf.fetchQaBranches.mockResolvedValue(offered(false));

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('waiting');
    expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
  });

  it.each([{ kind: 'surfing-off' }, { kind: 'unavailable' }])('does not pin on a $kind answer', async (answer) => {
    surf.fetchQaBranches.mockResolvedValue(answer);

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('waiting');
    expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
  });

  it('is waiting when the join found nothing it could launch', async () => {
    surf.joinEarlyUpdatesTrack.mockResolvedValue('nothing-to-launch');
    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('waiting');
  });

  it.each([
    ['the branch list', () => surf.fetchQaBranches.mockRejectedValue(new TypeError('Network request failed'))],
    ['the join', () => surf.joinEarlyUpdatesTrack.mockRejectedValue(new Error('offline'))],
  ])('never throws when %s fails: deferred to the next launch', async (_label, arrange) => {
    arrange();
    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('deferred');
  });

  it('makes no request for a member who is already pinned', async () => {
    surf.pinnedBranch = 'pr-beta';

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');
    expect(surf.fetchQaBranches).not.toHaveBeenCalled();
    expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
  });

  it('makes no request for anyone who has not opted in', async () => {
    store.values.earlyUpdates = false;

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');
    expect(surf.fetchQaBranches).not.toHaveBeenCalled();
  });

  it('leaves without asking for the branch list', async () => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = false;

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');
    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
    expect(surf.fetchQaBranches).not.toHaveBeenCalled();
  });

  it('a leave that cannot be made now is deferred, not thrown', async () => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = false;
    surf.leaveForProductionTrack.mockRejectedValue(new Error('offline'));

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('deferred');
  });

  it('reads the running bundle through the real classifier', async () => {
    surf.runningBranch = 'pr-123';
    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');

    // pr-beta is not a PR: it does not make the sync stand down.
    surf.runningBranch = 'pr-beta';
    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('joined');
  });

  it('runs one switch at a time', async () => {
    let finishFirst: (outcome: string) => void = () => {};
    surf.joinEarlyUpdatesTrack.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );

    const first = syncEarlyUpdates(ENVIRONMENT);
    const second = syncEarlyUpdates(ENVIRONMENT);
    await vi.waitFor(() => expect(surf.joinEarlyUpdatesTrack).toHaveBeenCalledOnce());
    expect(surf.fetchQaBranches).toHaveBeenCalledOnce();

    surf.pinnedBranch = 'pr-beta';
    finishFirst('switched');
    await expect(first).resolves.toBe('joined');
    // The second saw the pin the first one made, and had nothing left to do.
    await expect(second).resolves.toBe('none');
  });
});

describe('setEarlyUpdatesChoice', () => {
  it('stores the choice and reports it before any network', async () => {
    surf.fetchQaBranches.mockImplementation(async () => {
      expect(store.setSetting).toHaveBeenCalledExactlyOnceWith('earlyUpdates', true);
      expect(trackMock).toHaveBeenCalledExactlyOnceWith('Early Updates Toggled', { enabled: true });
      return offered(true);
    });
    store.setSetting.mockImplementation((key: string, value: unknown) => {
      store.values[key] = value;
    });

    await expect(setEarlyUpdatesChoice(true, ENVIRONMENT)).resolves.toBe('joined');
    expect(surf.fetchQaBranches).toHaveBeenCalledOnce();
  });

  it('keeps the choice when the switch-over cannot be made, and does not throw', async () => {
    store.setSetting.mockImplementation((key: string, value: unknown) => {
      store.values[key] = value;
    });
    surf.fetchQaBranches.mockRejectedValue(new TypeError('Network request failed'));

    await expect(setEarlyUpdatesChoice(true, ENVIRONMENT)).resolves.toBe('deferred');
    expect(store.values.earlyUpdates).toBe(true);
  });

  it('switching off reports once and starts the leave', async () => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = true;
    store.setSetting.mockImplementation((key: string, value: unknown) => {
      store.values[key] = value;
    });

    await expect(setEarlyUpdatesChoice(false, ENVIRONMENT)).resolves.toBe('left');
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('Early Updates Toggled', { enabled: false });
  });
});

describe('noteBranchSurfingOff', () => {
  it('leaves properly, and keeps the choice', async () => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = true;

    await noteBranchSurfingOff();

    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
    expect(store.setSetting).not.toHaveBeenCalled();
  });

  it("unpins a tester's preview too, as the server asked", async () => {
    surf.pinnedBranch = 'pr-123';
    await noteBranchSurfingOff();
    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
  });

  it('does nothing at all for a phone that is not pinned', async () => {
    await noteBranchSurfingOff();

    expect(surf.leaveForProductionTrack).not.toHaveBeenCalled();
    expect(store.setSetting).not.toHaveBeenCalled();
  });

  it('swallows a leave that cannot be made now', async () => {
    surf.pinnedBranch = 'pr-beta';
    surf.leaveForProductionTrack.mockRejectedValue(new Error('offline'));
    await expect(noteBranchSurfingOff()).resolves.toBeUndefined();
  });
});

describe('returnToOwnTrack', () => {
  it('takes a non-member back to production the way it always did', async () => {
    await expect(returnToOwnTrack(false)).resolves.toBe('nothing-to-load');

    expect(surf.surfToProduction).toHaveBeenCalledOnce();
    expect(surf.fetchQaBranches).not.toHaveBeenCalled();
    expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
  });

  it('takes a member to early updates, with no production surf and so no reload', async () => {
    await expect(returnToOwnTrack(true)).resolves.toBe('early-updates-next-launch');

    expect(surf.joinEarlyUpdatesTrack).toHaveBeenCalledOnce();
    expect(surf.surfToProduction).not.toHaveBeenCalled();
  });

  it('takes a member to production while the server does not offer early updates', async () => {
    surf.fetchQaBranches.mockResolvedValue(offered(false));

    await expect(returnToOwnTrack(true)).resolves.toBe('nothing-to-load');
    expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
    expect(surf.surfToProduction).toHaveBeenCalledOnce();
  });

  it('rejects when the switch cannot be made, leaving the preview pin where it was', async () => {
    surf.joinEarlyUpdatesTrack.mockRejectedValue(new Error('offline'));

    await expect(returnToOwnTrack(true)).rejects.toThrow('offline');
    expect(surf.surfToProduction).not.toHaveBeenCalled();
  });
});
