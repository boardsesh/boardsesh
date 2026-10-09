import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EarlyUpdatesFlagState } from '../../../providers/feature-flags-provider';

// qa-surf's native and network edges are stood in for; its pure parts
// (`otaBranchKind`, the branch constants, the queue) are the real ones, so the
// policy below is tested against the classifier it actually ships with. What a
// switch does to a device is covered end to end in ota-track-sequences.test.ts.
const surf = vi.hoisted(() => ({
  pinnedBranch: null as string | null,
  runningBranch: null as string | null,
  runningUpdateId: 'running-update' as string | null,
  emergencyLaunch: false,
  fetchQaBranches: vi.fn(),
  joinEarlyUpdatesTrack: vi.fn(),
  leaveForProductionTrack: vi.fn(),
  dropPinAfterEmergencyLaunch: vi.fn(),
  fetchRegularUpdateAfterEmergencyLaunch: vi.fn(),
  surfToProduction: vi.fn(),
  waitForOtaUpdatesIdle: vi.fn(async () => {}),
}));
vi.mock('expo-updates', () => ({ isEmbeddedLaunch: false, isEmergencyLaunch: false, manifest: { extra: {} } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { updates: {} } } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@xprem/control-center/src/surf', () => ({ surfTo: vi.fn() }));
vi.mock('@xprem/control-center/src/config', () => ({
  BRANCH_HEADER: 'xprem-branch',
  readConfig: vi.fn(),
  readLoadedState: vi.fn(),
}));
vi.mock('../../ota-channel-override-cleanup', () => ({ isBranchSurfingBuild: () => true }));
vi.mock('../qa-surf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../qa-surf')>()),
  readOtaPinnedBranch: () => surf.pinnedBranch,
  readRunningOtaBranch: () => surf.runningBranch,
  readRunningUpdateId: () => surf.runningUpdateId,
  readIsEmergencyLaunch: () => surf.emergencyLaunch,
  fetchQaBranches: surf.fetchQaBranches,
  joinEarlyUpdatesTrack: surf.joinEarlyUpdatesTrack,
  leaveForProductionTrack: surf.leaveForProductionTrack,
  dropPinAfterEmergencyLaunch: surf.dropPinAfterEmergencyLaunch,
  fetchRegularUpdateAfterEmergencyLaunch: surf.fetchRegularUpdateAfterEmergencyLaunch,
  surfToProduction: surf.surfToProduction,
  waitForOtaUpdatesIdle: surf.waitForOtaUpdatesIdle,
}));

const store = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    setSetting: vi.fn((key: string, value: unknown) => {
      values[key] = value;
    }),
  };
});
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => {
    if (key in store.values) return store.values[key];
    return key === 'earlyUpdates' || key === 'otaLeaveOwed' ? false : null;
  },
  setSetting: store.setSetting,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track: trackMock }));

import {
  decideEarlyUpdatesSync,
  noteBranchSurfingOff,
  resetEarlyUpdatesLaunchForTests,
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
  flagOffConfirmed: false,
  choice: true,
  pinnedBranch: null,
  runningBranch: null,
  emergencyLaunch: false,
  leaveOwed: false,
  leaveBlocked: false,
};
const MEMBER: EarlyUpdatesSyncInput = { ...WANTS_IN, pinnedBranch: 'pr-beta', runningBranch: 'pr-beta' };
const ENVIRONMENT = {
  surfingBuild: true,
  surfingReady: true,
  flagsResolved: true,
  flag: 'on',
  flagOffConfirmed: false,
} as const;
const FLAG_OFF = { ...ENVIRONMENT, flag: 'off', flagOffConfirmed: true } as const;

function listed(branches: { earlyUpdates?: boolean; previews?: string[]; staging?: boolean } = {}) {
  return {
    kind: 'listed',
    list: {
      previews: (branches.previews ?? []).map((branch) => ({ prNumber: 0, branch, lastUpdateAt: '2026-10-05' })),
      staging: branches.staging ? { lastUpdateAt: '2026-10-05' } : null,
      earlyUpdates: (branches.earlyUpdates ?? true) ? { lastUpdateAt: '2026-10-05' } : null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEarlyUpdatesLaunchForTests();
  surf.pinnedBranch = null;
  surf.runningBranch = null;
  surf.runningUpdateId = 'running-update';
  surf.emergencyLaunch = false;
  surf.fetchQaBranches.mockReset().mockResolvedValue(listed());
  surf.joinEarlyUpdatesTrack.mockReset().mockResolvedValue('switched');
  surf.leaveForProductionTrack.mockReset().mockResolvedValue('switched');
  // true: there was a sign of a pin, so a regular update is worth fetching.
  surf.dropPinAfterEmergencyLaunch.mockReset().mockReturnValue(true);
  surf.fetchRegularUpdateAfterEmergencyLaunch.mockReset().mockResolvedValue(undefined);
  surf.surfToProduction.mockReset().mockResolvedValue('nothing-to-load');
  for (const key of Object.keys(store.values)) delete store.values[key];
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

  it('leaves on a confirmed flag-off, whichever bundle is running', () => {
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'off', flagOffConfirmed: true })).toBe('leave');
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'off', flagOffConfirmed: true, runningBranch: 'pr-123' })).toBe(
      'leave',
    );
  });

  it('does not act on an "off" that is cached, mid sign-out, or already tried this launch', () => {
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'off', flagOffConfirmed: false })).toBe('none');
  });

  it('repairs after an emergency launch before anything else, flags included', () => {
    // Whoever owns the pin, and with no record at all (a kill mid-join leaves
    // the override written and the record empty).
    for (const pinnedBranch of [null, 'pr-beta', 'pr-123', 'pr-staging']) {
      expect(decideEarlyUpdatesSync({ ...WANTS_IN, pinnedBranch, emergencyLaunch: true })).toBe('repair');
    }
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, emergencyLaunch: true, flagsResolved: false })).toBe('repair');
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, choice: false, emergencyLaunch: true })).toBe('repair');
  });

  it('an emergency launch never turns into a join', () => {
    // Joining would write a pin over a phone that has just shown it has nothing
    // to launch under one, and offline that repeats at every open.
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, emergencyLaunch: true })).not.toBe('join');
  });

  it.each(['pr-beta', 'pr-123', 'pr-staging', null])(
    'carries out a leave the server is owed, from %s',
    (pinnedBranch) => {
      expect(decideEarlyUpdatesSync({ ...WANTS_IN, pinnedBranch, runningBranch: pinnedBranch, leaveOwed: true })).toBe(
        'leave',
      );
    },
  );

  it('does not repeat a leave that was refused on the update still running', () => {
    expect(decideEarlyUpdatesSync({ ...MEMBER, choice: false, leaveBlocked: true })).toBe('none');
    expect(decideEarlyUpdatesSync({ ...MEMBER, leaveOwed: true, leaveBlocked: true })).toBe('none');
  });

  it.each(['pr-123', 'pr-staging'])("stands down while a tester's %s bundle is the one running", (branch) => {
    const testing = { ...WANTS_IN, pinnedBranch: branch, runningBranch: branch };
    expect(decideEarlyUpdatesSync(testing)).toBe('none');
    expect(decideEarlyUpdatesSync({ ...testing, flag: 'off', flagOffConfirmed: true })).toBe('none');
    expect(decideEarlyUpdatesSync({ ...testing, choice: false })).toBe('none');
  });

  it.each(['pr-123', 'pr-staging'])('asks the server about a %s pin whose bundle is not running', (pinnedBranch) => {
    // Waiting for its first update, or its branch is gone. Only the server knows.
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, pinnedBranch })).toBe('check-preview');
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, pinnedBranch, choice: false })).toBe('check-preview');
  });

  it('a dead preview pin that could not be dropped still lets the phone join', () => {
    const stranded = { ...WANTS_IN, pinnedBranch: 'pr-123', leaveBlocked: true };
    expect(decideEarlyUpdatesSync(stranded)).toBe('join');
    expect(decideEarlyUpdatesSync({ ...stranded, choice: false })).toBe('none');
  });

  it.each(['pr-123', 'pr-staging'])('stands down on a running %s bundle the record does not know', (runningBranch) => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, runningBranch })).toBe('none');
  });

  it('waits for the feature flags and for the surfing migration', () => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, flagsResolved: false })).toBe('wait');
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, surfingReady: false })).toBe('wait');
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, surfingReady: false, emergencyLaunch: true })).toBe('wait');
    expect(decideEarlyUpdatesSync({ ...MEMBER, choice: false, flagsResolved: false })).toBe('wait');
  });

  it('does nothing on a build that cannot surf', () => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, surfingBuild: false, emergencyLaunch: true })).toBe('none');
  });

  it('moves nobody on a flag with no value', () => {
    expect(decideEarlyUpdatesSync({ ...WANTS_IN, flag: 'unknown' })).toBe('none');
    expect(decideEarlyUpdatesSync({ ...MEMBER, flag: 'unknown' })).toBe('none');
  });

  // Every combination, against the rule written out the long way.
  const FLAGS: EarlyUpdatesFlagState[] = ['on', 'off', 'unknown'];
  const BRANCHES = [null, 'pr-beta', 'pr-123', 'pr-staging'];
  const BOOLEANS = [true, false];
  const cases = BOOLEANS.flatMap((choice) =>
    FLAGS.flatMap((flag) =>
      BOOLEANS.flatMap((flagOffConfirmed) =>
        BRANCHES.flatMap((pinnedBranch) =>
          BRANCHES.flatMap((runningBranch) =>
            BOOLEANS.flatMap((leaveOwed) =>
              BOOLEANS.map((leaveBlocked) => ({
                choice,
                flag,
                flagOffConfirmed,
                pinnedBranch,
                runningBranch,
                leaveOwed,
                leaveBlocked,
              })),
            ),
          ),
        ),
      ),
    ),
  );
  const isPreview = (branch: string | null) => branch === 'pr-123' || branch === 'pr-staging';

  it('agrees with the rule written out the long way, for all 768 combinations', () => {
    expect(cases).toHaveLength(768);
    for (const overrides of cases) {
      const action = decideEarlyUpdatesSync({ ...WANTS_IN, ...overrides });
      const context = JSON.stringify(overrides);
      const wantsIn = overrides.choice && overrides.flag === 'on';
      const leave = overrides.leaveBlocked ? 'none' : 'leave';

      if (overrides.leaveOwed) {
        expect(action, context).toBe(leave);
      } else if (overrides.pinnedBranch === 'pr-beta') {
        const mustLeave = !overrides.choice || (overrides.flag === 'off' && overrides.flagOffConfirmed);
        expect(action, context).toBe(mustLeave ? leave : 'none');
      } else if (isPreview(overrides.pinnedBranch)) {
        if (overrides.runningBranch === overrides.pinnedBranch) expect(action, context).toBe('none');
        else if (!overrides.leaveBlocked) expect(action, context).toBe('check-preview');
        else expect(action, context).toBe(wantsIn ? 'join' : 'none');
      } else if (isPreview(overrides.runningBranch)) {
        expect(action, context).toBe('none');
      } else {
        expect(action, context).toBe(wantsIn ? 'join' : 'none');
      }
    }
  });

  it('never moves a tester off a preview that is running, and never joins anyone who has not opted in', () => {
    for (const overrides of cases) {
      const action = decideEarlyUpdatesSync({ ...WANTS_IN, ...overrides });
      const testing = isPreview(overrides.pinnedBranch) && overrides.runningBranch === overrides.pinnedBranch;
      if (testing && !overrides.leaveOwed) expect(action).toBe('none');
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

    expect(surf.fetchQaBranches).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(surf.joinEarlyUpdatesTrack).toHaveBeenCalledOnce();
  });

  it('does not pin a branch the server does not offer this binary', async () => {
    surf.fetchQaBranches.mockResolvedValue(listed({ earlyUpdates: false }));

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

  it.each([
    ['throws', () => surf.leaveForProductionTrack.mockRejectedValue(new Error('offline')), 'deferred'],
    // The server had nothing the phone could launch without the pin: the pin
    // was put back, and the leave waits for the next launch. Not dropped.
    ['finds nothing to launch', () => surf.leaveForProductionTrack.mockResolvedValue('nothing-to-launch'), 'deferred'],
    [
      'is refused on an update it already holds',
      () => surf.leaveForProductionTrack.mockResolvedValue('blocked'),
      'blocked',
    ],
  ])('a leave that %s is reported, not thrown', async (_label, arrange, outcome) => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = false;
    arrange();

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe(outcome);
  });

  it('skips a leave that was refused on the update still running', async () => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = false;
    store.values.otaLeaveBlockedUpdateId = 'running-update';

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');
    expect(surf.leaveForProductionTrack).not.toHaveBeenCalled();

    // A different update is running now: worth one more try.
    surf.runningUpdateId = 'next-update';
    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');
  });

  it('acts on a confirmed flag-off once per launch', async () => {
    surf.pinnedBranch = 'pr-beta';
    surf.leaveForProductionTrack.mockResolvedValue('nothing-to-launch');

    await expect(syncEarlyUpdates(FLAG_OFF)).resolves.toBe('deferred');
    // The flag flaps, or the effect re-runs: not tried again this launch.
    await expect(syncEarlyUpdates(FLAG_OFF)).resolves.toBe('none');
    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
  });

  it("the once-per-launch limit is the flag's alone: the climber switching off still leaves", async () => {
    surf.pinnedBranch = 'pr-beta';
    await syncEarlyUpdates(FLAG_OFF);
    store.values.earlyUpdates = false;

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');
    expect(surf.leaveForProductionTrack).toHaveBeenCalledTimes(2);
  });

  it("carries out a leave the server is owed, for a tester's preview pin too", async () => {
    surf.pinnedBranch = 'pr-123';
    surf.runningBranch = 'pr-123';
    store.values.otaLeaveOwed = true;

    await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');
    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
  });

  describe('after an emergency launch', () => {
    beforeEach(() => {
      surf.emergencyLaunch = true;
      surf.pinnedBranch = 'pr-beta';
    });

    it('drops the pin, fetches a regular update, and does not join in the same breath', async () => {
      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');

      expect(surf.dropPinAfterEmergencyLaunch).toHaveBeenCalledOnce();
      expect(surf.fetchRegularUpdateAfterEmergencyLaunch).toHaveBeenCalledOnce();
      expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
    });

    it('with no sign of a pin: no request at all, and the queue is not held', async () => {
      // Any climber can have an emergency launch, for reasons that have nothing
      // to do with branches. For them this must cost nothing.
      surf.pinnedBranch = null;
      store.values.earlyUpdates = false;
      surf.dropPinAfterEmergencyLaunch.mockReturnValue(false);

      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');

      expect(surf.fetchRegularUpdateAfterEmergencyLaunch).not.toHaveBeenCalled();
      expect(surf.fetchQaBranches).not.toHaveBeenCalled();
      expect(surf.leaveForProductionTrack).not.toHaveBeenCalled();
      expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
    });

    it('does not wait for the flags', async () => {
      await syncEarlyUpdates({ ...ENVIRONMENT, flagsResolved: false, flag: 'unknown' });
      expect(surf.dropPinAfterEmergencyLaunch).toHaveBeenCalledOnce();
    });

    it('repairs once: the rest of the launch decides as an ordinary one', async () => {
      // The pin is dropped before the part that can fail.
      surf.fetchRegularUpdateAfterEmergencyLaunch.mockRejectedValue(new Error('offline'));
      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('deferred');
      surf.pinnedBranch = null;

      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('joined');
      expect(surf.dropPinAfterEmergencyLaunch).toHaveBeenCalledOnce();
    });
  });

  describe("a tester's pin whose bundle is not running", () => {
    beforeEach(() => {
      surf.pinnedBranch = 'pr-123';
      surf.runningBranch = null;
    });

    it('is left alone while the server still offers the branch', async () => {
      surf.fetchQaBranches.mockResolvedValue(listed({ previews: ['pr-123'] }));

      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');
      expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
      expect(surf.leaveForProductionTrack).not.toHaveBeenCalled();
    });

    it('a member is returned to early updates when the branch is gone', async () => {
      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('joined');
      expect(surf.leaveForProductionTrack).not.toHaveBeenCalled();
    });

    it('everyone else is returned to the regular track', async () => {
      store.values.earlyUpdates = false;

      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');
      expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
    });

    it('a member goes to the regular track while early updates is not offered either', async () => {
      surf.fetchQaBranches.mockResolvedValue(listed({ earlyUpdates: false }));

      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('left');
      expect(surf.joinEarlyUpdatesTrack).not.toHaveBeenCalled();
    });

    it('a staging pin is judged by the staging branch', async () => {
      surf.pinnedBranch = 'pr-staging';
      surf.fetchQaBranches.mockResolvedValue(listed({ staging: true }));
      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');

      surf.fetchQaBranches.mockResolvedValue(listed({ staging: false }));
      await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('joined');
    });

    it.each([{ kind: 'surfing-off' }, { kind: 'unavailable' }])(
      'changes nothing on a $kind answer, which says nothing about the branch',
      async (answer) => {
        surf.fetchQaBranches.mockResolvedValue(answer);

        await expect(syncEarlyUpdates(ENVIRONMENT)).resolves.toBe('none');
        expect(surf.leaveForProductionTrack).not.toHaveBeenCalled();
      },
    );
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
      expect(store.values.earlyUpdates).toBe(true);
      expect(trackMock).toHaveBeenCalledExactlyOnceWith('Early Updates Toggled', { enabled: true });
      return listed();
    });

    await expect(setEarlyUpdatesChoice(true, ENVIRONMENT)).resolves.toBe('joined');
    expect(surf.fetchQaBranches).toHaveBeenCalledOnce();
  });

  it('keeps the choice when the switch-over cannot be made, and does not throw', async () => {
    surf.fetchQaBranches.mockRejectedValue(new TypeError('Network request failed'));

    await expect(setEarlyUpdatesChoice(true, ENVIRONMENT)).resolves.toBe('deferred');
    expect(store.values.earlyUpdates).toBe(true);
  });

  it('switching off reports once and starts the leave', async () => {
    surf.pinnedBranch = 'pr-beta';
    store.values.earlyUpdates = true;

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
    expect(store.values.earlyUpdates).toBe(true);
    expect(store.setSetting).not.toHaveBeenCalled();
  });

  it("unpins a tester's preview too, as the server asked", async () => {
    surf.pinnedBranch = 'pr-123';
    await noteBranchSurfingOff();
    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
  });

  it('attempts the leave with no pin on record: a build older than the record may have pinned', async () => {
    await noteBranchSurfingOff();

    expect(surf.leaveForProductionTrack).toHaveBeenCalledOnce();
    // It worked, so nothing is owed and nothing is written.
    expect(store.setSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', () => surf.leaveForProductionTrack.mockRejectedValue(new Error('offline'))],
    ['finds nothing to launch', () => surf.leaveForProductionTrack.mockResolvedValue('nothing-to-launch')],
    ['is refused', () => surf.leaveForProductionTrack.mockResolvedValue('blocked')],
  ])('records the leave as owed when it %s, and never throws', async (_label, arrange) => {
    surf.pinnedBranch = 'pr-staging';
    arrange();

    await expect(noteBranchSurfingOff()).resolves.toBeUndefined();

    expect(store.values.otaLeaveOwed).toBe(true);
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
    surf.fetchQaBranches.mockResolvedValue(listed({ earlyUpdates: false }));

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
