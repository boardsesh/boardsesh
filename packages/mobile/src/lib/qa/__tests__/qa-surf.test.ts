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
    return { downloadedManifest: updates.downloadedId ? { id: updates.downloadedId } : undefined };
  },
  isEmbeddedLaunch: false,
  isEmergencyLaunch: false,
  UpdateCheckResultNotAvailableReason: { NO_UPDATE_AVAILABLE_ON_SERVER: 'noUpdateAvailableOnServer' },
  setUpdateRequestHeadersOverride: updates.setUpdateRequestHeadersOverride,
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
  reloadAsync: updates.reloadAsync,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => settings.values[key] ?? null,
  setSetting: settings.setSetting,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { updates: {} } } }));
vi.mock('../../legacy-ota-channel-migration', () => ({
  isBranchSurfingBuild: migration.isBranchSurfingBuild,
}));

import {
  BRANCH_SURFING_UNAVAILABLE_MESSAGE,
  EARLY_UPDATES_OTA_BRANCH,
  adoptRunningOtaPin,
  fetchQaBranches,
  joinEarlyUpdatesTrack,
  leaveForProductionTrack,
  otaBranchKind,
  readOtaPinnedBranch,
  resetOtaPinSessionForTests,
  listPrBranches,
  listQaBranches,
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

  it('can ask for the newest page only', async () => {
    serveBranches([]);
    await fetchQaBranches(undefined, { wholeList: false });
    expect(fetchMock.mock.calls[0][0]).toBe('https://updates.boardsesh.com/branch_lists');
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

describe('adoptRunningOtaPin', () => {
  it.each(['pr-123', 'pr-staging', 'pr-beta'])('records the pin a running %s bundle proves', (branch) => {
    // Only an update stamped for the configured headers can launch, so the
    // running bundle says which pin was in force.
    updates.manifest = { extra: { branch } };
    adoptRunningOtaPin();
    expect(readOtaPinnedBranch()).toBe(branch);
  });

  it('proves nothing on the regular track, and writes nothing', () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    adoptRunningOtaPin();
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it('does not rewrite a record that is already right', () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    updates.manifest = { extra: { branch: 'pr-beta' } };
    adoptRunningOtaPin();
    expect(settings.setSetting).not.toHaveBeenCalled();
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

  it('leaving for a channel that has published nothing is fine: the embedded bundle is that channel', async () => {
    settings.values.otaPinnedBranch = 'pr-beta';
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'noUpdateAvailableOnServer' });

    await expect(leaveForProductionTrack()).resolves.toBe('switched');
    expect(readOtaPinnedBranch()).toBeNull();
  });

  it('refuses on a build that cannot surf, without touching the headers', async () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);
    await expect(joinEarlyUpdatesTrack()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    await expect(leaveForProductionTrack()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
  });
});
