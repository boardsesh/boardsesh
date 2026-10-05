// What a phone LAUNCHES after each thing this app does to its OTA branch pin.
//
// The unit tests beside this one check calls. This one checks consequences,
// against a small model of the two expo-updates rules the whole design rests on
// (read from expo-updates 57: `LauncherSelectionPolicyFilterAware`,
// `LoaderSelectionPolicyFilterAware`, `AppLoader`):
//
//   1. A cold start launches only an update whose stamped request headers EQUAL
//      the headers configured now. Nothing matching means an emergency launch of
//      the embedded bundle (after blocking on a download, when online).
//   2. A download stamps the update with the headers in force, and an update id
//      already on disk is NOT restamped.
//
// The model is not expo-updates, and a device has the last word (the PR lists
// what to check on one). It is here so the assumption is written down next to
// the code that depends on it, and so every sequence below is run against it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Headers = Record<string, string>;
type ServerUpdate = { id: string; commitTime: number; branch: string | null };

const BUILD_HEADERS: Headers = {
  'expo-channel-name': 'production',
  'expo-app-id': 'app-id',
  'xprem-branch': '',
};

function stampOf(headers: Headers): string {
  return JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
}

const device = vi.hoisted(() => ({
  /** The request-header override; null is the build's own headers. */
  override: null as Record<string, string> | null,
  /** Update id → the header stamp it was downloaded under, and its age. */
  disk: new Map<string, { stamp: string; commitTime: number; branch: string | null }>(),
  runningId: 'embedded',
  emergencyLaunch: false,
  downloadedId: undefined as string | undefined,
  online: true,
  reloads: 0,
  /** Branch name → its newest update. `production` is the channel's own branch. */
  server: new Map<string, { id: string; commitTime: number; branch: string | null }>(),
  settings: {} as Record<string, unknown>,
}));

function configuredHeaders(): Headers {
  return device.override ?? BUILD_HEADERS;
}

/** The server falls back to the channel's own branch for a branch it does not have. */
function serverHead(): ServerUpdate | undefined {
  const requested = configuredHeaders()['xprem-branch'];
  return (requested ? device.server.get(requested) : undefined) ?? device.server.get('production');
}

/** Rule 2's other half: the loader policy that decides whether a served update is "available". */
function shouldLoad(head: ServerUpdate): boolean {
  const launched = device.disk.get(device.runningId);
  if (!launched) return true;
  if (launched.stamp !== stampOf(configuredHeaders())) return true;
  return head.commitTime > launched.commitTime;
}

/** Rule 1. */
function coldStart(): string {
  const configured = stampOf(configuredHeaders());
  const launchable = [...device.disk.entries()]
    .filter(([, update]) => update.stamp === configured)
    .sort(([, left], [, right]) => right.commitTime - left.commitTime);
  device.emergencyLaunch = launchable.length === 0;
  device.runningId = launchable[0]?.[0] ?? 'embedded';
  device.downloadedId = undefined;
  return device.emergencyLaunch ? 'EMERGENCY' : device.runningId;
}

vi.mock('expo-updates', () => ({
  isEnabled: true,
  channel: 'production',
  runtimeVersion: 'fingerprint',
  UpdateCheckResultNotAvailableReason: { NO_UPDATE_AVAILABLE_ON_SERVER: 'noUpdateAvailableOnServer' },
  get updateId() {
    return device.runningId;
  },
  get isEmbeddedLaunch() {
    return device.runningId === 'embedded';
  },
  get isEmergencyLaunch() {
    return device.emergencyLaunch;
  },
  get manifest() {
    return { extra: { branch: device.disk.get(device.runningId)?.branch ?? null } };
  },
  get latestContext() {
    return { downloadedManifest: device.downloadedId ? { id: device.downloadedId } : undefined };
  },
  setUpdateRequestHeadersOverride: (headers: Record<string, string> | null) => {
    device.override = headers;
  },
  checkForUpdateAsync: async () => {
    if (!device.online) throw new Error('Failed to check for update');
    const head = serverHead();
    if (!head) return { isAvailable: false, reason: 'noUpdateAvailableOnServer' };
    return shouldLoad(head)
      ? { isAvailable: true, manifest: { id: head.id } }
      : { isAvailable: false, reason: 'updateRejectedBySelectionPolicy' };
  },
  fetchUpdateAsync: async () => {
    if (!device.online) throw new Error('Failed to download update');
    const head = serverHead();
    if (!head || !shouldLoad(head)) return { isNew: false };
    // Rule 2: only a NEW id is stamped. One already on disk comes back as a
    // success with the stamp it already had.
    if (!device.disk.has(head.id)) {
      device.disk.set(head.id, {
        stamp: stampOf(configuredHeaders()),
        commitTime: head.commitTime,
        branch: head.branch,
      });
    }
    device.downloadedId = head.id;
    return { isNew: true, manifest: { id: head.id } };
  },
  reloadAsync: async () => {
    device.reloads += 1;
  },
}));
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      updates: { url: 'https://updates.boardsesh.com/manifest', requestHeaders: BUILD_HEADERS },
    },
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../../legacy-ota-channel-migration', () => ({ isBranchSurfingBuild: () => true }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => device.settings[key] ?? (key === 'earlyUpdates' ? false : null),
  setSetting: (key: string, value: unknown) => {
    device.settings[key] = value;
  },
}));
vi.mock('../../analytics', () => ({ track: vi.fn() }));

const fetchMock = vi.fn();

function publish(branch: string, id: string, commitTime: number): void {
  device.server.set(branch, { id, commitTime, branch: branch === 'production' ? null : branch });
}

function serveBranchList(...names: string[]): void {
  fetchMock.mockImplementation(async () => {
    if (!device.online) throw new TypeError('Network request failed');
    return new Response(
      JSON.stringify({ total: names.length, branches: names.map((name) => ({ name, lastUpdateAt: '2026-10-05' })) }),
      { status: 200 },
    );
  });
}

const ENVIRONMENT = { surfingBuild: true, surfingReady: true, flagsResolved: true, flag: 'on' } as const;

/**
 * A new JS session over the same device: the modules are re-evaluated the way
 * a relaunch re-evaluates them, since qa-surf reads the launch-time pin once.
 */
async function openApp() {
  const launched = coldStart();
  vi.resetModules();
  const surf = await import('../qa-surf');
  const earlyUpdates = await import('../early-updates');
  surf.adoptRunningOtaPin();
  return { launched, surf, earlyUpdates };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  device.override = null;
  device.disk = new Map([['embedded', { stamp: stampOf(BUILD_HEADERS), commitTime: 0, branch: null }]]);
  device.runningId = 'embedded';
  device.emergencyLaunch = false;
  device.downloadedId = undefined;
  device.online = true;
  device.reloads = 0;
  device.server = new Map();
  device.settings = {};
  // A phone on the regular track, running the current stable update.
  publish('production', 'stable-1', 10);
  device.disk.set('stable-1', { stamp: stampOf(BUILD_HEADERS), commitTime: 10, branch: null });
  publish('pr-beta', 'beta-1', 20);
  serveBranchList('pr-beta', 'pr-123');
});

describe('the launcher rule', () => {
  it('launches the newest update stamped for the configured headers', async () => {
    const { launched } = await openApp();
    expect(launched).toBe('stable-1');
  });

  it('launches nothing on disk after a pin-only header write', async () => {
    // What the first version of "Get updates early" did: write the override and
    // wait for the next launch. Every update on disk carries the old stamp, so
    // the next cold start has nothing it may launch.
    await openApp();
    device.override = { ...BUILD_HEADERS, 'xprem-branch': 'pr-beta' };

    expect(coldStart()).toBe('EMERGENCY');
  });

  it('does not restamp an update that is already on disk', async () => {
    // The server does not have the branch, so it answers with the channel's own
    // update: the one already running, under the old stamp. "Downloaded", and
    // still not launchable. Pinned like this, EVERY cold start is an emergency.
    await openApp();
    device.server.delete('pr-beta');
    device.override = { ...BUILD_HEADERS, 'xprem-branch': 'pr-beta' };

    const { fetchUpdateAsync } = await import('expo-updates');
    expect(await fetchUpdateAsync()).toMatchObject({ isNew: true, manifest: { id: 'stable-1' } });
    expect(coldStart()).toBe('EMERGENCY');
  });
});

describe('joining early updates', () => {
  it('online: the next cold start launches the early update, never mid-session', async () => {
    const { earlyUpdates } = await openApp();

    expect(await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('joined');

    expect(device.reloads).toBe(0);
    expect(device.settings.otaPinnedBranch).toBe('pr-beta');
    expect(coldStart()).toBe('beta-1');
  });

  it('then relaunching offline still launches the early update', async () => {
    const { earlyUpdates } = await openApp();
    await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);

    device.online = false;
    const relaunch = await openApp();

    expect(relaunch.launched).toBe('beta-1');
    // Pinned and stamped: nothing left to do, so nothing is requested.
    fetchMock.mockClear();
    expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offline: keeps the choice, leaves the pin alone, and joins at a later launch', async () => {
    const { earlyUpdates } = await openApp();
    device.online = false;

    expect(await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('deferred');

    expect(device.settings.earlyUpdates).toBe(true);
    expect(device.override).toBeNull();
    expect(coldStart()).toBe('stable-1');

    device.online = true;
    const relaunch = await openApp();
    expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('joined');
    expect(coldStart()).toBe('beta-1');
  });

  it('the server does not offer the branch: waiting, with no pin', async () => {
    const { earlyUpdates } = await openApp();
    serveBranchList('pr-123');

    expect(await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('waiting');

    expect(device.override).toBeNull();
    expect(device.settings.otaPinnedBranch ?? null).toBeNull();
    expect(coldStart()).toBe('stable-1');
  });

  it('the list offers the branch but the server serves the running update: pin put back', async () => {
    // The list and the manifest disagreeing, or the branch deleted in between.
    const { earlyUpdates } = await openApp();
    device.server.delete('pr-beta');

    expect(await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('waiting');

    expect(device.override).toBeNull();
    expect(coldStart()).toBe('stable-1');
  });

  it('the download fails half way: pin put back', async () => {
    const { surf } = await openApp();
    const updates = await import('expo-updates');
    vi.spyOn(updates, 'fetchUpdateAsync').mockRejectedValueOnce(new Error('Failed to download update'));

    await expect(surf.joinEarlyUpdatesTrack()).rejects.toThrow('Failed to download update');

    expect(device.override).toBeNull();
    expect(coldStart()).toBe('stable-1');
  });

  it('follows the branch as it publishes', async () => {
    const { earlyUpdates } = await openApp();
    await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
    await openApp();

    // The launch-time background check, which this app does not drive.
    publish('pr-beta', 'beta-2', 30);
    const { fetchUpdateAsync } = await import('expo-updates');
    await fetchUpdateAsync();

    expect(coldStart()).toBe('beta-2');
  });
});

describe('leaving early updates', () => {
  async function memberOnBeta() {
    const first = await openApp();
    await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
    const session = await openApp();
    expect(session.launched).toBe('beta-1');
    return session;
  }

  it('online: the next cold start is back on the regular track, with no reload', async () => {
    const { earlyUpdates } = await memberOnBeta();

    expect(await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT)).toBe('left');

    expect(device.reloads).toBe(0);
    expect(device.override).toBeNull();
    // An older bundle than the one running, and it still launches: the early
    // update's stamp no longer matches.
    expect(coldStart()).toBe('stable-1');
  });

  it('fetches a regular update it does not have before dropping the pin', async () => {
    const { earlyUpdates } = await memberOnBeta();
    publish('production', 'stable-2', 25);

    await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT);

    expect(coldStart()).toBe('stable-2');
  });

  it('offline: stays pinned and launchable, and leaves at a later launch', async () => {
    const { earlyUpdates } = await memberOnBeta();
    device.online = false;

    expect(await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT)).toBe('deferred');

    expect(device.settings.earlyUpdates).toBe(false);
    expect(device.settings.otaPinnedBranch).toBe('pr-beta');
    const offlineRelaunch = await openApp();
    expect(offlineRelaunch.launched).toBe('beta-1');

    device.online = true;
    expect(await offlineRelaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('left');
    expect(coldStart()).toBe('stable-1');
  });

  it('straight after joining, in the same session', async () => {
    // The regular track's newest update is the one running, so there is nothing
    // to download, and nothing needs to be: it was stamped for no pin.
    const { earlyUpdates } = await openApp();
    await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);

    expect(await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT)).toBe('left');
    expect(coldStart()).toBe('stable-1');
  });

  it('the feature is switched off: a member is moved back and keeps the choice', async () => {
    const { earlyUpdates } = await memberOnBeta();

    expect(await earlyUpdates.syncEarlyUpdates({ ...ENVIRONMENT, flag: 'off' })).toBe('left');

    expect(device.settings.earlyUpdates).toBe(true);
    expect(coldStart()).toBe('stable-1');

    // And back on: the member rejoins without touching the switch.
    const relaunch = await openApp();
    expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('joined');
    expect(coldStart()).toBe('beta-1');
  });

  it('branch surfing is switched off: unpinned safely, choice kept', async () => {
    const { earlyUpdates } = await memberOnBeta();

    await earlyUpdates.noteBranchSurfingOff();

    expect(device.override).toBeNull();
    expect(device.settings.earlyUpdates).toBe(true);
    expect(coldStart()).toBe('stable-1');
  });
});

describe('a broken pin repairs itself', () => {
  it('pinned with nothing stamped (killed mid-switch, or a new binary)', async () => {
    // The state this app never leaves behind on purpose, reached by force.
    device.settings = { earlyUpdates: true, otaPinnedBranch: 'pr-beta' };
    device.override = { 'expo-channel-name': 'production', 'expo-app-id': 'app-id', 'xprem-branch': 'pr-beta' };
    device.online = false;
    const broken = await openApp();
    expect(broken.launched).toBe('EMERGENCY');

    device.online = true;
    expect(await broken.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('left');
    const repaired = await openApp();
    expect(repaired.launched).toBe('stable-1');

    // The choice is still on, so the launch after that joins properly.
    expect(await repaired.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('joined');
    expect(coldStart()).toBe('beta-1');
  });

  it('a phone already running an early update is recorded as pinned without a request', async () => {
    const first = await openApp();
    await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
    // The record lost (written by a build that predates it, say).
    delete device.settings.otaPinnedBranch;

    const { earlyUpdates } = await openApp();
    fetchMock.mockClear();

    expect(device.settings.otaPinnedBranch).toBe('pr-beta');
    expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('previews and early updates share one header', () => {
  beforeEach(() => {
    publish('pr-123', 'preview-123', 40);
  });

  it('a tester on a preview is left alone by the launch sync', async () => {
    const first = await openApp();
    await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
    await first.surf.surfToPr(123);
    expect(device.reloads).toBe(1);

    const { launched, earlyUpdates } = await openApp();
    expect(launched).toBe('preview-123');
    expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');
    // Not even when the feature is switched off: the pin is the tester's.
    expect(await earlyUpdates.syncEarlyUpdates({ ...ENVIRONMENT, flag: 'off' })).toBe('none');
    expect(coldStart()).toBe('preview-123');
  });

  it('a member leaving a preview lands on early updates at the next launch', async () => {
    const first = await openApp();
    await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
    await first.surf.surfToPr(123);
    const { earlyUpdates } = await openApp();

    expect(await earlyUpdates.returnToOwnTrack(true)).toBe('early-updates-next-launch');

    expect(coldStart()).toBe('beta-1');
  });

  it('a member leaving a preview offline stays on the preview', async () => {
    const first = await openApp();
    await first.surf.surfToPr(123);
    const { earlyUpdates } = await openApp();
    device.online = false;

    await expect(earlyUpdates.returnToOwnTrack(true)).rejects.toThrow();

    expect(device.settings.otaPinnedBranch).toBe('pr-123');
    expect(coldStart()).toBe('preview-123');
  });

  it('a member whose branch is not offered leaves a preview for the regular track', async () => {
    const first = await openApp();
    await first.surf.surfToPr(123);
    const { earlyUpdates } = await openApp();
    serveBranchList('pr-123');

    await earlyUpdates.returnToOwnTrack(true);

    expect(device.settings.otaPinnedBranch).toBeNull();
    expect(coldStart()).toBe('stable-1');
  });

  it('a non-member leaving a preview goes back to production', async () => {
    const first = await openApp();
    await first.surf.surfToPr(123);
    const { earlyUpdates } = await openApp();

    await earlyUpdates.returnToOwnTrack(false);

    expect(device.settings.otaPinnedBranch).toBeNull();
    expect(coldStart()).toBe('stable-1');
  });

  it('sequence A: a failed PR surf does not unpin a member', async () => {
    const first = await openApp();
    await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
    const { surf } = await openApp();

    // xprem knows of no pin in this session, so on failure it "restores" none.
    device.online = false;
    await expect(surf.surfToPr(123)).rejects.toThrow();

    expect(device.settings.otaPinnedBranch).toBe('pr-beta');
    expect(device.override).toMatchObject({ 'xprem-branch': 'pr-beta' });
    expect(coldStart()).toBe('beta-1');
  });

  it('sequence B: a failed surf does not put back a preview the tester already left', async () => {
    const { surf, earlyUpdates } = await openApp();
    device.settings.earlyUpdates = true;
    // A PR surf that finds nothing to load: xprem now remembers pr-123.
    device.server.delete('pr-123');
    device.server.delete('production');
    expect(await surf.surfToPr(123)).toBe('nothing-to-load');
    publish('production', 'stable-1', 10);

    expect(await earlyUpdates.returnToOwnTrack(true)).toBe('early-updates-next-launch');

    device.online = false;
    await expect(surf.surfToStaging()).rejects.toThrow();

    expect(device.settings.otaPinnedBranch).toBe('pr-beta');
    expect(device.override).toMatchObject({ 'xprem-branch': 'pr-beta' });
    expect(coldStart()).toBe('beta-1');
  });
});
