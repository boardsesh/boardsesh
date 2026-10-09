import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteOtaHeadersChanged } from '../../ota-operation-owner';

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
  rollback: undefined as { commitTime: string } | undefined,
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
    return {
      ...updates.busy,
      isUpdatePending: Boolean(updates.downloadedId || updates.rollback),
      rollback: updates.rollback,
      downloadedManifest: updates.downloadedId ? { id: updates.downloadedId } : undefined,
    };
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
  fetchOwnedOtaUpdate,
  setOwnedOtaHeaders,
  captureOtaReloadReceipt,
  isOtaReloadReceiptCurrent,
  waitForOtaReloadReceipt,
  runPinChangeExclusively,
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
  updates.rollback = undefined;
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
      signal: expect.any(AbortSignal),
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

describe('bounded branch lists', () => {
  it('times out through body reading even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const request = fetchQaBranches();
    const rejection = expect(request).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('composes caller cancellation into the body deadline', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const controller = new AbortController();
    const request = fetchQaBranches(controller.signal);
    const rejection = expect(request).rejects.toThrow('cancelled');
    controller.abort();
    await rejection;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe('app-owned preview surfing', () => {
  beforeEach(() => {
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'preview-1' } });
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'preview-1';
      return { isNew: true, manifest: { id: 'preview-1' } };
    });
    updates.reloadAsync.mockResolvedValue(undefined);
  });

  it.each([
    ['staging', () => surfToStaging(), 'pr-staging'],
    ['PR', () => surfToPr(4792), 'pr-4792'],
  ])('downloads and records the %s pin before restarting', async (_name, start, branch) => {
    updates.reloadAsync.mockImplementation(async () => {
      expect(readOtaPinnedBranch()).toBe(branch);
    });
    await expect(start()).resolves.toBe('reloading');
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledWith(
      expect.objectContaining({ 'xprem-branch': branch }),
    );
    expect(surf.surfTo).not.toHaveBeenCalled();
  });

  it('clears the pin to the build headers after a production download', async () => {
    settings.values.otaPinnedBranch = 'pr-4792';
    await expect(surfToProduction()).resolves.toBe('reloading');
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledWith(null);
    expect(readOtaPinnedBranch()).toBeNull();
  });

  it('refuses builds without usable config without touching the record', async () => {
    config.readConfig.mockReturnValue(null);
    await expect(surfToPr(1)).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    await expect(surfToProduction()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('restores the previous pin when the preview has nothing launchable', async () => {
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false });
    await expect(surfToStaging()).resolves.toBe('nothing-to-load');
    expect(readOtaPinnedBranch()).toBeNull();
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('restores a previous early-updates pin after a check rejection', async () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
    await expect(surfToPr(4792)).rejects.toThrow('offline');
    expect(readOtaPinnedBranch()).toBe('pr-beta');
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'xprem-branch': 'pr-beta' }),
    );
  });

  it('restores the previous pin after a definite restart rejection', async () => {
    updates.reloadAsync.mockRejectedValue(new Error('restart rejected'));
    await expect(surfToPr(4792)).rejects.toThrow('restart rejected');
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

  it('holds the temporary pin until a timed-out native check finishes', async () => {
    vi.useFakeTimers();
    let finishCheck!: (result: unknown) => void;
    updates.checkForUpdateAsync.mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    );
    const joining = joinEarlyUpdatesTrack();
    const rejection = expect(joining).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(PIN_CHANGE_TIMEOUT_MS);
    await rejection;
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'xprem-branch': 'pr-beta' }),
    );
    expect(settings.values.otaPinSwitchInFlight).toEqual({ to: 'pr-beta' });
    finishCheck({ isAvailable: true, manifest: { id: 'beta-1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(settings.values.otaPinSwitchInFlight).toBeNull();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('expires a queued preview without calling native code while another check hangs', async () => {
    vi.useFakeTimers();
    let finishCheck!: (result: unknown) => void;
    updates.checkForUpdateAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    );
    const stuck = surfToPr(1);
    const stuckRejection = expect(stuck).rejects.toThrow('took too long');
    const queued = surfToPr(2);
    const queuedRejection = expect(queued).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(PIN_CHANGE_TIMEOUT_MS);
    await Promise.all([stuckRejection, queuedRejection]);
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    finishCheck({ isAvailable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(readOtaPinnedBranch()).toBeNull();
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

describe('owned download provenance and reload receipts', () => {
  it('preserves unknown emergency pending stamps even when fetch reports isNew', async () => {
    updates.downloadedId = 'cached';
    const fresh = await relaunch({ emergency: true });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'cached' } });
    await fresh.runPinChangeExclusively((lease) => lease.native(() => fresh.fetchOwnedOtaUpdate()));
    expect(fresh.captureOtaReloadReceipt()).toBeNull();
  });

  it('preserves a cached UUID stamp when fetched again under another pin', async () => {
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'stable-cached';
      return { isNew: true, manifest: { id: 'stable-cached' } };
    });
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    const stableReceipt = captureOtaReloadReceipt();
    expect(stableReceipt).not.toBeNull();
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'beta-new' } });
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'beta-new';
      return { isNew: true, manifest: { id: 'beta-new' } };
    });
    await joinEarlyUpdatesTrack();
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'stable-cached';
      return { isNew: true, manifest: { id: 'stable-cached' } };
    });
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    expect(captureOtaReloadReceipt()).toBeNull();
  });

  it('attributes a download event even when its native promise rejects', async () => {
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'downloaded-before-rejection';
      throw new Error('native bridge failed');
    });
    await expect(runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()))).rejects.toThrow(
      'bridge failed',
    );
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'downloaded-before-rejection' });
  });

  it('attributes a late timed-out fetch before headers are restored', async () => {
    vi.useFakeTimers();
    let finishFetch!: (result: unknown) => void;
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'late-beta' } });
    updates.fetchUpdateAsync.mockReturnValue(
      new Promise((resolve) => {
        finishFetch = resolve;
      }),
    );
    const joining = joinEarlyUpdatesTrack();
    const rejected = expect(joining).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(PIN_CHANGE_TIMEOUT_MS);
    await rejected;
    updates.downloadedId = 'late-beta';
    finishFetch({ isNew: true, manifest: { id: 'late-beta' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(captureOtaReloadReceipt()).toBeNull();
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'late-beta' } });
    await expect(joinEarlyUpdatesTrack()).resolves.toBe('switched');
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'late-beta' });
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
  });

  it('rejects a receipt after pending identity replacement under the same headers', async () => {
    updates.fetchUpdateAsync
      .mockImplementationOnce(async () => {
        updates.downloadedId = 'first';
        return { isNew: true, manifest: { id: 'first' } };
      })
      .mockImplementationOnce(async () => {
        updates.downloadedId = 'second';
        return { isNew: true, manifest: { id: 'second' } };
      });
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    const receipt = captureOtaReloadReceipt();
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    expect(receipt && isOtaReloadReceiptCurrent(receipt)).toBe(false);
  });

  it('invalidates an A to B to A receipt despite matching current pin and UUID', async () => {
    updates.downloadedId = 'startup-stable';
    const receipt = captureOtaReloadReceipt();
    expect(receipt).not.toBeNull();
    noteOtaHeadersChanged();
    noteOtaHeadersChanged();
    expect(receipt && isOtaReloadReceiptCurrent(receipt)).toBe(false);
  });

  it('follows manifest precedence when a context also contains an older rollback', () => {
    updates.downloadedId = 'startup-stable';
    updates.rollback = { commitTime: '2026-10-01T00:00:00Z' };
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'startup-stable' });
  });

  it('validates rollback identity and invalidates replacement rollback directives', () => {
    updates.rollback = { commitTime: '2026-10-01T00:00:00Z' };
    const receipt = captureOtaReloadReceipt();
    expect(receipt?.target).toEqual({ kind: 'rollback', commitTime: '2026-10-01T00:00:00Z' });
    updates.rollback = { commitTime: '2026-10-02T00:00:00Z' };
    expect(receipt && isOtaReloadReceiptCurrent(receipt)).toBe(false);
  });

  it('waits for the fetched UUID pending event rather than taking an older receipt', async () => {
    updates.downloadedId = 'older';
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'fresh' } });
    const operation = runPinChangeExclusively(async (lease) => {
      const fetched = await lease.native(() => fetchOwnedOtaUpdate());
      return waitForOtaReloadReceipt(lease, fetched);
    });
    await vi.waitFor(() => expect(updates.stateListeners.size).toBe(1));
    updates.downloadedId = 'fresh';
    for (const listener of updates.stateListeners) listener();
    expect((await operation)?.target).toEqual({ kind: 'update', id: 'fresh' });
    expect(updates.stateListeners.size).toBe(0);
  });

  it('attributes a rollback whose pending event follows native settlement under revised headers', async () => {
    noteOtaHeadersChanged();
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: false, isRollBackToEmbedded: true });
    const operation = runPinChangeExclusively(async (lease) => {
      const fetched = await lease.native(() => fetchOwnedOtaUpdate());
      return waitForOtaReloadReceipt(lease, fetched);
    });
    await vi.waitFor(() => expect(updates.stateListeners.size).toBe(1));
    updates.rollback = { commitTime: '2026-10-03T00:00:00Z' };
    for (const listener of updates.stateListeners) listener();
    expect((await operation)?.target).toEqual({ kind: 'rollback', commitTime: '2026-10-03T00:00:00Z' });
  });

  it('fetches an already safely stamped preview target before restarting onto it', async () => {
    updates.fetchUpdateAsync.mockImplementationOnce(async () => {
      updates.downloadedId = 'stable-cached';
      return { isNew: true, manifest: { id: 'stable-cached' } };
    });
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    updates.checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: true, manifest: { id: 'beta-new' } });
    updates.fetchUpdateAsync.mockImplementationOnce(async () => {
      updates.downloadedId = 'beta-new';
      return { isNew: true, manifest: { id: 'beta-new' } };
    });
    await joinEarlyUpdatesTrack();
    updates.checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: true, manifest: { id: 'stable-cached' } });
    updates.fetchUpdateAsync.mockImplementationOnce(async () => {
      updates.downloadedId = 'stable-cached';
      return { isNew: true, manifest: { id: 'stable-cached' } };
    });
    updates.reloadAsync.mockImplementation(async () => {
      expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'stable-cached' });
    });
    await expect(surfToProduction()).resolves.toBe('reloading');
    expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(3);
  });

  it('quarantines native work after header restoration fails', async () => {
    updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
    updates.setUpdateRequestHeadersOverride.mockImplementation((headers) => {
      if (headers === null) throw new Error('restore failed');
    });
    await expect(joinEarlyUpdatesTrack()).rejects.toThrow('restore failed');
    await expect(surfToPr(123)).rejects.toThrow('headers could not be restored');
    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
  });

  it('never restarts a preview whose native download finishes after its caller deadline', async () => {
    vi.useFakeTimers();
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'late-preview' } });
    let finishFetch!: (result: unknown) => void;
    updates.fetchUpdateAsync.mockReturnValue(
      new Promise((resolve) => {
        finishFetch = resolve;
      }),
    );
    const preview = surfToPr(123);
    const rejected = expect(preview).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(PIN_CHANGE_TIMEOUT_MS);
    await rejected;
    updates.downloadedId = 'late-preview';
    finishFetch({ isNew: true, manifest: { id: 'late-preview' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(readOtaPinnedBranch()).toBeNull();
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  });

  it('attributes subsequent raw downloads to the journal-proven launch pin', async () => {
    const fresh = await relaunch({ record: null, interrupted: { to: 'pr-beta' } });
    fresh.adoptRunningOtaPin();
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'fresh-beta';
      return { isNew: true, manifest: { id: 'fresh-beta' } };
    });
    await fresh.runPinChangeExclusively((lease) => lease.native(() => fresh.fetchOwnedOtaUpdate()));
    expect(fresh.captureOtaReloadReceipt()?.pin).toBe('pr-beta');
  });
});

describe('legacy channel download provenance', () => {
  const previewHeaders = { 'expo-app-id': 'app-id', 'expo-channel-name': 'preview' };

  it('retains channel identity for later recovery after a rejected restart', async () => {
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'eas-preview';
      return { isNew: true, manifest: { id: 'eas-preview' } };
    });
    await expect(
      runPinChangeExclusively(async (lease) => {
        setOwnedOtaHeaders(previewHeaders, 'channel:preview');
        await lease.native(() => fetchOwnedOtaUpdate());
        await lease.reload(async () => {
          throw new Error('restart rejected');
        });
      }),
    ).rejects.toThrow('restart rejected');
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    expect(captureOtaReloadReceipt()?.pin).toBe('channel:preview');
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'eas-preview' });
  });

  it('preserves a pre-existing baked pending stamp when a channel fetch reuses its UUID', async () => {
    updates.downloadedId = 'baked-pending';
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'baked-pending' } });
    await runPinChangeExclusively(async (lease) => {
      setOwnedOtaHeaders(previewHeaders, 'channel:preview');
      await lease.native(() => fetchOwnedOtaUpdate());
    });
    expect(captureOtaReloadReceipt()).toBeNull();
    await runPinChangeExclusively(async () => setOwnedOtaHeaders(null, null));
    expect(captureOtaReloadReceipt()?.pin).toBeNull();
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'baked-pending' });
  });

  it('preserves an unknown pending stamp across a successful cached channel fetch', async () => {
    noteOtaHeadersChanged();
    updates.downloadedId = 'unknown-pending';
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'unknown-pending' } });
    await runPinChangeExclusively(async (lease) => {
      setOwnedOtaHeaders(previewHeaders, 'channel:preview');
      await lease.native(() => fetchOwnedOtaUpdate());
    });
    expect(captureOtaReloadReceipt()).toBeNull();
  });

  it('uses restored channel headers for recovery after a failed switch', async () => {
    updates.fetchUpdateAsync.mockImplementationOnce(async () => {
      updates.downloadedId = 'channel-a-update';
      return { isNew: true, manifest: { id: 'channel-a-update' } };
    });
    await runPinChangeExclusively(async (lease) => {
      setOwnedOtaHeaders(previewHeaders, 'channel:preview');
      await lease.native(() => fetchOwnedOtaUpdate());
    });
    updates.fetchUpdateAsync.mockRejectedValueOnce(new Error('channel B download failed'));
    await expect(
      runPinChangeExclusively(async (lease) => {
        setOwnedOtaHeaders({ ...previewHeaders, 'expo-channel-name': 'staging' }, 'channel:staging');
        try {
          await lease.native(() => fetchOwnedOtaUpdate());
        } finally {
          setOwnedOtaHeaders(previewHeaders, 'channel:preview');
        }
      }),
    ).rejects.toThrow('channel B download failed');
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'channel-a-update' });
    updates.fetchUpdateAsync.mockImplementationOnce(async () => {
      updates.downloadedId = 'channel-a-recovery';
      return { isNew: true, manifest: { id: 'channel-a-recovery' } };
    });
    await runPinChangeExclusively((lease) => lease.native(() => fetchOwnedOtaUpdate()));
    expect(captureOtaReloadReceipt()?.pin).toBe('channel:preview');
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'channel-a-recovery' });
  });

  it('rejects old confirmation after channel A to B to A despite retained UUID provenance', async () => {
    updates.fetchUpdateAsync.mockImplementation(async () => {
      updates.downloadedId = 'eas-preview';
      return { isNew: true, manifest: { id: 'eas-preview' } };
    });
    await runPinChangeExclusively(async (lease) => {
      setOwnedOtaHeaders(previewHeaders, 'channel:preview');
      await lease.native(() => fetchOwnedOtaUpdate());
    });
    const receipt = captureOtaReloadReceipt();
    await runPinChangeExclusively(async () => {
      setOwnedOtaHeaders({ ...previewHeaders, 'expo-channel-name': 'staging' }, 'channel:staging');
      expect(captureOtaReloadReceipt()).toBeNull();
      setOwnedOtaHeaders(previewHeaders, 'channel:preview');
    });
    expect(captureOtaReloadReceipt()?.target).toEqual({ kind: 'update', id: 'eas-preview' });
    expect(receipt && isOtaReloadReceiptCurrent(receipt)).toBe(false);
  });
});
