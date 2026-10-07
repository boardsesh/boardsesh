import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// xprem's two internals, mocked at the deep paths `qa-surf` imports them from.
// Nothing else in the app is allowed to reach them, so these two mocks are the
// whole seam.
const surf = vi.hoisted(() => ({
  surfTo: vi.fn(),
}));
const config = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readLoadedState: vi.fn(() => ({ branch: null as string | null, refusedBranch: null as string | null })),
}));
const updates = vi.hoisted(() => ({
  isEnabled: true,
  manifest: { extra: {} } as unknown,
  updateId: 'running-update' as string | null,
  downloadedId: undefined as string | undefined,
  isEmbeddedLaunch: false,
  isEmergencyLaunch: false,
  busy: { isStartupProcedureRunning: false, isChecking: false, isDownloading: false },
  stateListeners: new Set<() => void>(),
  setUpdateRequestHeadersOverride: vi.fn(),
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
const settings = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    setSetting: vi.fn((key: string, value: unknown) => {
      values[key] = value;
    }),
  };
});
const fetchMock = vi.hoisted(() => vi.fn());
// `__DEV__` is substituted textually by both Metro and Vitest, so the dev branch
// can only be exercised through this helper — which is exactly why qa-surf
// delegates to it instead of testing `__DEV__` itself.
const migration = vi.hoisted(() => ({ isBranchSurfingBuild: vi.fn(() => true) }));

vi.mock('@xprem/control-center/src/surf', () => ({
  surfTo: surf.surfTo,
}));
vi.mock('@xprem/control-center/src/config', () => ({
  BRANCH_HEADER: 'xprem-branch',
  readConfig: config.readConfig,
  readLoadedState: config.readLoadedState,
}));
vi.mock('expo-updates', () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  get manifest() {
    return updates.manifest;
  },
  get updateId() {
    return updates.updateId;
  },
  get latestContext() {
    return { ...updates.busy, downloadedManifest: updates.downloadedId ? { id: updates.downloadedId } : undefined };
  },
  addUpdatesStateChangeListener: (listener: () => void) => {
    updates.stateListeners.add(listener);
    return { remove: () => updates.stateListeners.delete(listener) };
  },
  get isEmbeddedLaunch() {
    return updates.isEmbeddedLaunch;
  },
  get isEmergencyLaunch() {
    return updates.isEmergencyLaunch;
  },
  UpdateCheckResultNotAvailableReason: {
    NO_UPDATE_AVAILABLE_ON_SERVER: 'noUpdateAvailableOnServer',
    UPDATE_REJECTED_BY_SELECTION_POLICY: 'updateRejectedBySelectionPolicy',
  },
  setUpdateRequestHeadersOverride: updates.setUpdateRequestHeadersOverride,
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
  reloadAsync: updates.reloadAsync,
}));
const platform = vi.hoisted(() => ({ os: 'ios' }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) =>
    settings.values[key] ?? (key === 'otaLeaveOwed' || key === 'earlyUpdates' ? false : null),
  setSetting: settings.setSetting,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { updates: {} } } }));
vi.mock('../../ota-channel-override-cleanup', () => ({
  isBranchSurfingBuild: migration.isBranchSurfingBuild,
}));

import {
  BRANCH_SURFING_UNAVAILABLE_MESSAGE,
  EARLY_UPDATES_OTA_BRANCH,
  fetchQaBranches,
  PIN_CHANGE_TIMEOUT_MS,
  UPDATES_IDLE_TIMEOUT_MS,
  joinEarlyUpdatesTrack,
  leaveForProductionTrack,
  otaBranchKind,
  readOtaPinnedBranch,
  resetOtaPinSessionForTests,
  qaSurfingAvailable,
  readRefusedPrNumber,
  readRunningPrNumber,
  surfToPr,
  surfToProduction,
  surfToStaging,
} from '../qa-surf';

const SURF_CONFIG = {
  baseUrl: 'https://updates.boardsesh.com',
  appId: 'app-id',
  channel: 'production',
  runtimeVersion: 'fingerprint',
  requestHeaders: {},
};

type Branch = { name: string; lastUpdateAt: string };

// What the gate and the picker each take from the one answer.
async function listQaBranches(signal?: AbortSignal) {
  const answer = await fetchQaBranches(signal);
  return answer.kind === 'listed' ? answer.list : null;
}
async function listPrBranches(signal?: AbortSignal) {
  return (await listQaBranches(signal))?.previews ?? null;
}

/**
 * qa-surf reads the pin the app was LAUNCHED under once, at module load. A case
 * about that reading sets the launch up first, then loads a fresh copy.
 */
async function relaunch(launch: {
  record?: string | null;
  runningBranch?: string | null;
  interrupted?: { to: string | null } | null;
  emergency?: boolean;
  embedded?: boolean;
  os?: 'ios' | 'android';
}) {
  settings.values.otaPinnedBranch = launch.record ?? null;
  settings.values.otaPinSwitchInFlight = launch.interrupted ?? null;
  updates.manifest = { extra: { branch: launch.runningBranch ?? null } };
  updates.isEmergencyLaunch = launch.emergency ?? false;
  updates.isEmbeddedLaunch = launch.embedded ?? launch.emergency ?? false;
  platform.os = launch.os ?? 'ios';
  vi.resetModules();
  return import('../qa-surf');
}

/** The server's answer to `/branch_lists`. */
function serveBranches(branches: Branch[]): void {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ branches, total: branches.length }), { status: 200 }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  settings.setSetting.mockClear();
  for (const key of Object.keys(settings.values)) delete settings.values[key];
  resetOtaPinSessionForTests();
  updates.updateId = 'running-update';
  updates.downloadedId = undefined;
  updates.isEmbeddedLaunch = false;
  updates.isEmergencyLaunch = false;
  updates.busy = { isStartupProcedureRunning: false, isChecking: false, isDownloading: false };
  updates.stateListeners.clear();
  platform.os = 'ios';
  updates.setUpdateRequestHeadersOverride.mockReset();
  updates.checkForUpdateAsync.mockReset();
  updates.fetchUpdateAsync.mockReset();
  updates.reloadAsync.mockReset();
  surf.surfTo.mockReset();
  config.readConfig.mockReset().mockReturnValue(SURF_CONFIG);
  config.readLoadedState.mockReset().mockReturnValue({ branch: null, refusedBranch: null });
  migration.isBranchSurfingBuild.mockReset().mockReturnValue(true);
  updates.isEnabled = true;
  updates.manifest = { extra: {} };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('qaSurfingAvailable', () => {
  it('is true on a build with surfing headers and a usable config', () => {
    expect(qaSurfingAvailable()).toBe(true);
  });

  it('is false on a build that was never meant to surf', () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);
    expect(qaSurfingAvailable()).toBe(false);
  });

  it('does not ask xprem for a config on a build that cannot surf', () => {
    // readConfig console.warns loudly about missing build-time headers. That is
    // the right noise for a build that was MEANT to surf, and pure noise on a
    // dev client — so the capability check has to come first.
    migration.isBranchSurfingBuild.mockReturnValue(false);
    qaSurfingAvailable();
    expect(config.readConfig).not.toHaveBeenCalled();
  });

  it('is false when xprem cannot build a config', () => {
    config.readConfig.mockReturnValue(null);
    expect(qaSurfingAvailable()).toBe(false);
  });
});

describe('readRunningPrNumber', () => {
  it('reads the PR out of the running branch marker', () => {
    updates.manifest = { extra: { branch: 'pr-4792' } };
    expect(readRunningPrNumber()).toBe(4792);
  });

  it('is null on production', () => {
    expect(readRunningPrNumber()).toBeNull();
  });

  it('is null on a non-PR branch', () => {
    updates.manifest = { extra: { branch: 'feature-native-update' } };
    expect(readRunningPrNumber()).toBeNull();
  });
});

describe('readRefusedPrNumber', () => {
  it('reports a branch the server refused because it crashed here', () => {
    config.readLoadedState.mockReturnValue({ branch: null, refusedBranch: 'pr-4792' });
    expect(readRefusedPrNumber()).toBe(4792);
  });

  it('is null when nothing was refused', () => {
    expect(readRefusedPrNumber()).toBeNull();
  });
});

describe('listPrBranches', () => {
  it('offers staging separately from numbered PR previews', async () => {
    serveBranches([
      { name: 'pr-staging', lastUpdateAt: '2026-08-26T11:00:00.000Z' },
      { name: 'pr-100', lastUpdateAt: '2026-08-26T10:00:00.000Z' },
    ]);
    await expect(listQaBranches()).resolves.toEqual({
      staging: { lastUpdateAt: '2026-08-26T11:00:00.000Z' },
      earlyUpdates: null,
      previews: [{ prNumber: 100, branch: 'pr-100', lastUpdateAt: '2026-08-26T10:00:00.000Z' }],
    });
  });

  it('reports the early-updates branch with its last update, never as a PR', async () => {
    serveBranches([
      { name: 'pr-beta', lastUpdateAt: '2026-10-05T09:00:00.000Z' },
      { name: 'pr-100', lastUpdateAt: '2026-08-26T10:00:00.000Z' },
    ]);
    await expect(listQaBranches()).resolves.toEqual({
      staging: null,
      earlyUpdates: { lastUpdateAt: '2026-10-05T09:00:00.000Z' },
      previews: [{ prNumber: 100, branch: 'pr-100', lastUpdateAt: '2026-08-26T10:00:00.000Z' }],
    });
  });

  it('says so when the server has no early update for this binary', async () => {
    serveBranches([{ name: 'pr-100', lastUpdateAt: '2026-08-26T10:00:00.000Z' }]);
    const list = await listQaBranches();
    expect(list?.earlyUpdates).toBeNull();
  });

  it('keeps only pr-<n> branches, freshest first', () => {
    serveBranches([
      { name: 'pr-100', lastUpdateAt: '2026-08-20T10:00:00.000Z' },
      { name: 'production', lastUpdateAt: '2026-08-26T10:00:00.000Z' },
      { name: 'pr-200', lastUpdateAt: '2026-08-25T10:00:00.000Z' },
      { name: 'feature-native-update', lastUpdateAt: '2026-08-24T10:00:00.000Z' },
      { name: 'pr-beta', lastUpdateAt: '2026-08-27T10:00:00.000Z' },
    ]);

    return expect(listPrBranches()).resolves.toEqual([
      { prNumber: 200, branch: 'pr-200', lastUpdateAt: '2026-08-25T10:00:00.000Z' },
      { prNumber: 100, branch: 'pr-100', lastUpdateAt: '2026-08-20T10:00:00.000Z' },
    ]);
  });

  it('sinks an unparseable timestamp instead of scrambling the order', async () => {
    serveBranches([
      { name: 'pr-1', lastUpdateAt: 'not a date' },
      { name: 'pr-2', lastUpdateAt: '2026-08-25T10:00:00.000Z' },
    ]);

    const branches = await listPrBranches();
    expect(branches?.map((entry) => entry.prNumber)).toEqual([2, 1]);
  });

  it('returns null when surfing is switched off for this channel', async () => {
    // Distinct from an empty array, which means surfing is on but nothing is
    // published for this runtime version.
    fetchMock.mockResolvedValue(new Response('', { status: 404, headers: { 'xprem-branch-surfing': 'off' } }));
    await expect(listPrBranches()).resolves.toBeNull();
  });

  it('tells the server switching surfing off apart from any other 404', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404, headers: { 'xprem-branch-surfing': 'off' } }));
    await expect(fetchQaBranches()).resolves.toEqual({ kind: 'surfing-off' });

    // A proxy, an old server or a path-based deployment. Evidence of nothing.
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(fetchQaBranches()).resolves.toEqual({ kind: 'unavailable' });
  });

  it('only reads: no answer touches the pin or a setting', async () => {
    // It is a query function. Acting on surfing-off is noteBranchSurfingOff's
    // job, and a bare unpin here would leave nothing launchable.
    fetchMock.mockResolvedValue(new Response('', { status: 404, headers: { 'xprem-branch-surfing': 'off' } }));
    await listQaBranches();
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await listQaBranches();
    serveBranches([{ name: 'pr-beta', lastUpdateAt: '2026-10-05T09:00:00.000Z' }]);
    await listQaBranches();

    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('reads a body of another shape as no list', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    await expect(listQaBranches()).resolves.toBeNull();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('returns an empty list when nothing is published', async () => {
    serveBranches([]);
    await expect(listPrBranches()).resolves.toEqual([]);
  });

  it('asks for the whole list for this binary and passes the abort signal through', async () => {
    serveBranches([]);
    const controller = new AbortController();
    await listPrBranches(controller.signal);
    // `?all=1` is the whole list, not xprem's default newest-50 page: the screen
    // has no "show the rest" affordance, so a page cap silently hides PRs.
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://updates.boardsesh.com/branch_lists?all=1', {
      method: 'GET',
      headers: {
        'expo-app-id': 'app-id',
        'expo-channel-name': 'production',
        'expo-runtime-version': 'fingerprint',
        'expo-platform': 'ios',
      },
      signal: controller.signal,
    });
  });

  it('propagates an unreachable update server', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 502 }));
    await expect(listPrBranches()).rejects.toThrow('Could not reach the update server (502).');
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('refuses to run on a build that cannot surf', async () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);
    await expect(listPrBranches()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('otaBranchKind', () => {
  it.each([
    [null, 'default'],
    ['production', 'default'],
    ['pr-123', 'preview'],
    ['pr-staging', 'staging'],
    ['pr-beta', 'early-updates'],
    // Fits the surfing pattern, but nothing this app publishes on purpose.
    ['pr-experiment', 'default'],
  ] as const)('%s is %s', (branch, kind) => {
    expect(otaBranchKind(branch)).toBe(kind);
  });
});

describe('surfToPr / surfToStaging / surfToProduction', () => {
  it('pins the staged branch without remapping production', async () => {
    surf.surfTo.mockResolvedValue('reloading');
    await expect(surfToStaging()).resolves.toBe('reloading');
    expect(surf.surfTo).toHaveBeenCalledWith(SURF_CONFIG, 'pr-staging');
  });

  it('pins the PR branch and reports the outcome', async () => {
    surf.surfTo.mockResolvedValue('reloading');
    await expect(surfToPr(4792)).resolves.toBe('reloading');
    expect(surf.surfTo).toHaveBeenCalledWith(SURF_CONFIG, 'pr-4792');
  });

  it('clears the pin with null rather than a channel name', async () => {
    // null is "no override at all" — the native side reverts to the headers
    // baked at build time, the one state that cannot be wrong.
    surf.surfTo.mockResolvedValue('nothing-to-load');
    await expect(surfToProduction()).resolves.toBe('nothing-to-load');
    expect(surf.surfTo).toHaveBeenCalledWith(SURF_CONFIG, null);
  });

  it('refuses to surf on a build with no usable config', async () => {
    config.readConfig.mockReturnValue(null);
    await expect(surfToPr(1)).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    await expect(surfToProduction()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(surf.surfTo).not.toHaveBeenCalled();
    // And leaves the record alone: nothing was pinned.
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('records who owns the pin BEFORE the surf, because a reload never returns', async () => {
    surf.surfTo.mockImplementation(async () => {
      expect(readOtaPinnedBranch()).toBe('pr-4792');
      return 'reloading';
    });
    await surfToPr(4792);
    expect(readOtaPinnedBranch()).toBe('pr-4792');
  });

  it('keeps the record when the surf loaded nothing: the pin is still in place', async () => {
    surf.surfTo.mockResolvedValue('nothing-to-load');
    await surfToStaging();
    expect(readOtaPinnedBranch()).toBe('pr-staging');
  });

  it('clears the record on the way back to production', async () => {
    settings.values.otaPinnedBranch = 'pr-4792';
    surf.surfTo.mockResolvedValue('nothing-to-load');
    await surfToProduction();
    expect(readOtaPinnedBranch()).toBeNull();
  });

  it('puts the previous pin back, record and headers, when the surf rejects', async () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    surf.surfTo.mockRejectedValue(new Error('Could not reach the update server (502).'));

    await expect(surfToPr(4792)).rejects.toThrow('Could not reach the update server (502).');

    expect(readOtaPinnedBranch()).toBe('pr-beta');
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith({
      'expo-channel-name': 'production',
      'expo-app-id': 'app-id',
      'xprem-branch': 'pr-beta',
    });
  });

  it('puts "no pin" back as no override at all', async () => {
    surf.surfTo.mockRejectedValue(new Error('offline'));
    await expect(surfToPr(4792)).rejects.toThrow('offline');
    expect(readOtaPinnedBranch()).toBeNull();
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  });
});

describe('the pin the app was launched under', () => {
  it.each(['pr-123', 'pr-staging', 'pr-beta'])('a running %s bundle proves its own pin', async (branch) => {
    // Only an update stamped for the configured headers can launch.
    const fresh = await relaunch({ record: null, runningBranch: branch });
    fresh.adoptRunningOtaPin();
    expect(fresh.readOtaPinnedBranch()).toBe(branch);
  });

  it('a bundle from the regular track proves nothing, and nothing is written', async () => {
    // Either no pin, or a pin the server answered with the channel's own update.
    const fresh = await relaunch({ record: 'pr-beta' });
    settings.setSetting.mockClear();
    fresh.adoptRunningOtaPin();
    expect(settings.setSetting).not.toHaveBeenCalled();
    expect(fresh.readOtaPinnedBranch()).toBe('pr-beta');
  });

  it('a switch killed mid-join that still launched: the journal names the pin', async () => {
    const fresh = await relaunch({ record: null, interrupted: { to: 'pr-beta' } });
    fresh.adoptRunningOtaPin();

    expect(fresh.readOtaPinnedBranch()).toBe('pr-beta');
    expect(settings.values.otaPinSwitchInFlight).toBeNull();
  });

  it('a switch killed mid-leave: the record stops claiming the pin that was dropped', async () => {
    const fresh = await relaunch({ record: 'pr-beta', interrupted: { to: null } });
    fresh.adoptRunningOtaPin();

    expect(fresh.readOtaPinnedBranch()).toBeNull();
    expect(settings.values.otaPinSwitchInFlight).toBeNull();
  });

  it('an emergency launch proves nothing: adoption leaves everything for the repair', async () => {
    const fresh = await relaunch({ record: 'pr-beta', interrupted: { to: 'pr-beta' }, emergency: true });
    settings.setSetting.mockClear();
    fresh.adoptRunningOtaPin();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });
});

describe('leaving when there is nothing to download', () => {
  it('the loader policy turning the check down proves the running bundle needs no pin', async () => {
    // Even against a record that still says pr-beta (stale after a kill
    // mid-leave on a build without the journal).
    const fresh = await relaunch({ record: 'pr-beta' });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'updateRejectedBySelectionPolicy' });

    await expect(fresh.leaveForProductionTrack()).resolves.toBe('switched');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(fresh.readOtaPinnedBranch()).toBeNull();
  });

  it('a channel with nothing published is NOT launchable when the app launched under a pin', async () => {
    // iOS: the embedded row may be stamped for the pin being left. Dropping the
    // pin would then leave nothing launchable, at every cold start, for good.
    const fresh = await relaunch({ record: 'pr-beta', embedded: true, os: 'ios' });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'noUpdateAvailableOnServer' });

    await expect(fresh.leaveForProductionTrack()).resolves.toBe('nothing-to-launch');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'xprem-branch': 'pr-beta' }),
    );
    expect(fresh.readOtaPinnedBranch()).toBe('pr-beta');
  });

  it('a channel with nothing published is fine when the app launched with no pin', async () => {
    const fresh = await relaunch({ record: null });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'noUpdateAvailableOnServer' });

    await expect(fresh.leaveForProductionTrack()).resolves.toBe('switched');
  });

  it("Android's embedded bundle always launched with no pin, whatever the record says", async () => {
    const fresh = await relaunch({ record: 'pr-beta', embedded: true, os: 'android' });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'noUpdateAvailableOnServer' });

    await expect(fresh.leaveForProductionTrack()).resolves.toBe('switched');
  });

  it('is blocked, by name, when the regular update is on disk under the pin it is leaving', async () => {
    // The server has been answering the pinned requests with the channel's own
    // update. It is the one running; it cannot be restamped.
    const fresh = await relaunch({ record: 'pr-beta' });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'running-update' } });

    await expect(fresh.leaveForProductionTrack()).resolves.toBe('blocked');

    expect(settings.values.otaLeaveBlockedUpdateId).toBe('running-update');
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(fresh.readOtaPinnedBranch()).toBe('pr-beta');
  });

  it('a later successful switch forgets the block', async () => {
    settings.values.otaLeaveBlockedUpdateId = 'running-update';
    settings.values.otaLeaveOwed = true;
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'stable-9' } });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'stable-9' } });

    await expect(leaveForProductionTrack()).resolves.toBe('switched');

    expect(settings.values.otaLeaveBlockedUpdateId).toBeNull();
    expect(settings.values.otaLeaveOwed).toBe(false);
  });
});

describe('a switch waits its turn and gives up', () => {
  beforeEach(() => {
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'beta-1' } });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'beta-1' } });
  });

  it('does not write the override while the launch-time check or download is running', async () => {
    updates.busy = { isStartupProcedureRunning: true, isChecking: false, isDownloading: true };
    const joining = joinEarlyUpdatesTrack();
    await Promise.resolve();
    await Promise.resolve();
    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();

    // Still downloading: a state change that is not "idle" changes nothing.
    updates.busy = { isStartupProcedureRunning: false, isChecking: false, isDownloading: true };
    for (const listener of updates.stateListeners) listener();
    await Promise.resolve();
    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();

    updates.busy = { isStartupProcedureRunning: false, isChecking: false, isDownloading: false };
    for (const listener of updates.stateListeners) listener();

    await expect(joining).resolves.toBe('switched');
    expect(updates.stateListeners.size).toBe(0);
  });

  it('gives up, having written nothing, when expo-updates never goes idle', async () => {
    vi.useFakeTimers();
    updates.busy = { isStartupProcedureRunning: true, isChecking: false, isDownloading: false };
    const joining = joinEarlyUpdatesTrack();
    const rejection = expect(joining).rejects.toThrow('expo-updates stayed busy');
    await vi.advanceTimersByTimeAsync(UPDATES_IDLE_TIMEOUT_MS);
    await rejection;

    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('a hung native call times out and puts the previous pin back', async () => {
    vi.useFakeTimers();
    updates.checkForUpdateAsync.mockReturnValue(new Promise(() => {}));
    const joining = joinEarlyUpdatesTrack();
    const rejection = expect(joining).rejects.toThrow('The update server took too long.');
    await vi.advanceTimersByTimeAsync(PIN_CHANGE_TIMEOUT_MS);
    await rejection;

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(readOtaPinnedBranch()).toBeNull();
    expect(settings.values.otaPinSwitchInFlight).toBeNull();
  });

  it("a hung surf times out too, so it cannot hold a tester's next one for the session", async () => {
    vi.useFakeTimers();
    settings.values.otaPinnedBranch = 'pr-beta';
    surf.surfTo.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue('reloading');

    const stuck = surfToPr(1);
    const rejection = expect(stuck).rejects.toThrow('The update server took too long.');
    const next = surfToPr(2);
    await vi.advanceTimersByTimeAsync(PIN_CHANGE_TIMEOUT_MS);
    await rejection;

    await expect(next).resolves.toBe('reloading');
    expect(surf.surfTo).toHaveBeenLastCalledWith(SURF_CONFIG, 'pr-2');
  });

  it('journals the switch while its outcome is unknown', async () => {
    updates.checkForUpdateAsync.mockImplementation(async () => {
      expect(settings.values.otaPinSwitchInFlight).toEqual({ to: 'pr-beta' });
      return { isAvailable: true, manifest: { id: 'beta-1' } };
    });

    await joinEarlyUpdatesTrack();

    expect(settings.values.otaPinSwitchInFlight).toBeNull();
  });
});

describe('dropPinAfterEmergencyLaunch', () => {
  it('drops the pin and every record of it, synchronously, with no request', async () => {
    const fresh = await relaunch({ record: 'pr-beta', interrupted: { to: 'pr-beta' }, emergency: true });
    settings.values.otaLeaveOwed = true;

    expect(fresh.dropPinAfterEmergencyLaunch()).toBe(true);

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledExactlyOnceWith(null);
    expect(fresh.readOtaPinnedBranch()).toBeNull();
    expect(settings.values.otaPinSwitchInFlight).toBeNull();
    expect(settings.values.otaLeaveOwed).toBe(false);
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['a pin record', { record: 'pr-123' }, {}],
    ['an interrupted switch', { interrupted: { to: 'pr-beta' } }, {}],
    ['the early-updates choice', {}, { earlyUpdates: true }],
  ] as const)('reports %s as evidence of a pin', async (_label, launch, stored) => {
    const fresh = await relaunch({ ...launch, emergency: true });
    Object.assign(settings.values, stored);

    expect(fresh.dropPinAfterEmergencyLaunch()).toBe(true);
  });

  it('reports no evidence for a phone that never had a pin, and writes no setting', async () => {
    // An emergency launch has many causes that have nothing to do with branches.
    const fresh = await relaunch({ emergency: true });
    settings.setSetting.mockClear();

    expect(fresh.dropPinAfterEmergencyLaunch()).toBe(false);

    // "No override" over no override: harmless, and it covers an override this
    // app has no record of.
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledExactlyOnceWith(null);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });
});

describe('fetchRegularUpdateAfterEmergencyLaunch', () => {
  it('downloads the regular update the server has', async () => {
    const fresh = await relaunch({ emergency: true });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'stable-9' } });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'stable-9' } });

    await fresh.fetchRegularUpdateAfterEmergencyLaunch();

    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('downloads nothing when the server has nothing new', async () => {
    const fresh = await relaunch({ emergency: true });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'noUpdateAvailableOnServer' });

    await fresh.fetchRegularUpdateAfterEmergencyLaunch();

    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('throws offline, for the caller to swallow', async () => {
    const fresh = await relaunch({ emergency: true });
    updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));

    await expect(fresh.fetchRegularUpdateAfterEmergencyLaunch()).rejects.toThrow('offline');
  });
});

describe('joinEarlyUpdatesTrack / leaveForProductionTrack', () => {
  const BUILD_HEADERS = {
    'expo-channel-name': 'baked-at-export',
    'expo-app-id': 'baked-app-id',
    'xprem-branch': '',
    'xprem-surf-blocked': '',
    'x-extra': 'kept',
  };
  const EARLY_HEADERS = {
    'expo-channel-name': 'production',
    'expo-app-id': 'app-id',
    'xprem-branch': 'pr-beta',
    'x-extra': 'kept',
  };

  beforeEach(() => {
    config.readConfig.mockReturnValue({ ...SURF_CONFIG, requestHeaders: BUILD_HEADERS });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'beta-1' } });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'beta-1' } });
  });

  it('pins with the header set xprem itself builds for that branch', async () => {
    // Ask the real xprem what it would send, by letting its surfTo run against
    // the same mocked expo-updates with nothing to load.
    const realSurf = await vi.importActual<typeof import('@xprem/control-center/src/surf')>(
      '@xprem/control-center/src/surf',
    );
    updates.checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: false });
    await realSurf.surfTo({ ...SURF_CONFIG, requestHeaders: BUILD_HEADERS }, EARLY_UPDATES_OTA_BRANCH);
    const xpremHeaders: unknown = updates.setUpdateRequestHeadersOverride.mock.calls[0][0];
    updates.setUpdateRequestHeadersOverride.mockClear();

    await joinEarlyUpdatesTrack();

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledExactlyOnceWith(xpremHeaders);
    // And spelled out, so a change in xprem cannot quietly move both sides.
    expect(xpremHeaders).toEqual(EARLY_HEADERS);
  });

  it('checks and downloads under the new pin, records it, and never reloads', async () => {
    await expect(joinEarlyUpdatesTrack()).resolves.toBe('switched');

    const pinOrder = updates.setUpdateRequestHeadersOverride.mock.invocationCallOrder[0];
    expect(pinOrder).toBeLessThan(updates.checkForUpdateAsync.mock.invocationCallOrder[0]);
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(readOtaPinnedBranch()).toBe('pr-beta');
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(surf.surfTo).not.toHaveBeenCalled();
  });

  it('records the pin only after the download', async () => {
    updates.fetchUpdateAsync.mockImplementation(async () => {
      expect(readOtaPinnedBranch()).toBeNull();
      return { isNew: true, manifest: { id: 'beta-1' } };
    });
    await joinEarlyUpdatesTrack();
    expect(readOtaPinnedBranch()).toBe('pr-beta');
  });

  it.each([
    ['the check throws', () => updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'))],
    ['the download throws', () => updates.fetchUpdateAsync.mockRejectedValue(new Error('offline'))],
  ])('puts the previous pin back and rejects when %s', async (_label, arrange) => {
    arrange();

    await expect(joinEarlyUpdatesTrack()).rejects.toThrow('offline');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(readOtaPinnedBranch()).toBeNull();
  });

  it("puts a tester's preview pin back exactly when a join from it fails", async () => {
    settings.values.otaPinnedBranch = 'pr-4792';
    updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));

    await expect(joinEarlyUpdatesTrack()).rejects.toThrow('offline');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith({
      ...EARLY_HEADERS,
      'xprem-branch': 'pr-4792',
    });
    expect(readOtaPinnedBranch()).toBe('pr-4792');
  });

  it.each([
    ['the update already running', () => (updates.updateId = 'beta-1')],
    ['an update the launch-time check already downloaded', () => (updates.downloadedId = 'beta-1')],
  ])('refuses %s: it is on disk under another stamp and would not launch', async (_label, arrange) => {
    // What the server sends when it does not have the branch for this binary:
    // the channel's own update. expo-updates would report it "downloaded"
    // without restamping it.
    arrange();

    await expect(joinEarlyUpdatesTrack()).resolves.toBe('nothing-to-launch');

    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(readOtaPinnedBranch()).toBeNull();
  });

  it('refuses a download that produced nothing', async () => {
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: false });
    await expect(joinEarlyUpdatesTrack()).resolves.toBe('nothing-to-launch');
    expect(readOtaPinnedBranch()).toBeNull();
  });

  it('refuses when the server has nothing newer and the running bundle is not stamped for the pin', async () => {
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'updateRejectedBySelectionPolicy' });
    await expect(joinEarlyUpdatesTrack()).resolves.toBe('nothing-to-launch');
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  });

  it('leaving clears the override, downloads a regular update and records no pin', async () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'stable-2' } });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'stable-2' } });

    await expect(leaveForProductionTrack()).resolves.toBe('switched');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledExactlyOnceWith(null);
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(readOtaPinnedBranch()).toBeNull();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('leaving offline puts the early-updates pin back and keeps the record', async () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));

    await expect(leaveForProductionTrack()).rejects.toThrow('offline');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(EARLY_HEADERS);
    expect(readOtaPinnedBranch()).toBe('pr-beta');
  });

  it('refuses on a build that cannot surf, without touching the headers', async () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);
    await expect(joinEarlyUpdatesTrack()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    await expect(leaveForProductionTrack()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
  });
});
