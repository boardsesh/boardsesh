// What a phone LAUNCHES after each thing this app does to its OTA branch pin.
//
// The unit tests beside this one check calls. This one checks consequences,
// against a model of expo-updates 57 written from its sources. Every rule below
// names where it was read; `ios/EXUpdates/...` and
// `android/src/main/java/expo/modules/updates/...` are shortened.
//
//   1. LAUNCH. A cold start launches only an update whose stamped request
//      headers EQUAL the headers configured now, newest first
//      (LauncherSelectionPolicyFilterAware, both platforms).
//   2. STAMP. A download stamps the update with the headers in force; an update
//      id already on disk is NOT restamped, and the fetch still reports
//      `isNew: true` (iOS AppLoader.startLoading, Android Loader.processUpdate).
//   3. LOAD. A served update is "available" when the launched update's stamp no
//      longer matches the configured headers, whatever its commit time;
//      otherwise only when it is newer (LoaderSelectionPolicyFilterAware).
//   4. EMBEDDED. With nothing launchable (or an embedded bundle newer than what
//      is), the embedded row is inserted if it is not on disk. Android stamps it
//      with the headers BAKED into the build (EmbeddedUpdate.kt); iOS stamps it
//      with the headers in force at insertion (UpdatesDatabase.addUpdate).
//   5. REAPER. After launch, updates older than the launched one are deleted,
//      but for one. Android keeps the newest of them and never deletes the
//      embedded row; iOS keeps the LAST one it iterated (both arms of its
//      `if let … else` assign) and has no embedded exemption
//      (ReaperSelectionPolicyFilterAware, each platform).
//   6. STARTUP. With nothing launchable the launch blocks on a download, and
//      with nothing after that it emergency-launches the embedded bundle.
//      Otherwise the check and download run in the background after launch
//      (AppLoaderTask / LoaderTask).
//
// The model is not expo-updates, and a device has the last word (the PR lists
// what to check on one). It is here so the assumptions are written down next to
// the code that depends on them, and so every sequence is run against them on
// both platforms.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Headers = Record<string, string>;
type Platform = 'ios' | 'android';
type DiskRow = { stamp: string; commitTime: number; branch: string | null; embedded: boolean };
type ServerUpdate = { id: string; commitTime: number; branch: string | null };

const BUILD_HEADERS: Headers = {
  'expo-channel-name': 'production',
  'expo-app-id': 'app-id',
  'xprem-branch': '',
};

function stampOf(headers: Headers): string {
  return JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
}

const BAKED_STAMP = stampOf(BUILD_HEADERS);

const device = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'android',
  /** The request-header override; null is the build's own headers. */
  override: null as Record<string, string> | null,
  /** Update id → row. Insertion order matters to the iOS reaper. */
  disk: new Map<string, { stamp: string; commitTime: number; branch: string | null; embedded: boolean }>(),
  /** The bundle built into the installed binary. */
  embedded: { id: 'embedded-1', commitTime: 0 },
  runningId: 'embedded-1',
  emergencyLaunch: false,
  /** The last cold start had to wait for a download before it could show anything. */
  launchBlockedOnDownload: false,
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

/** Rule 3. */
function shouldLoad(head: ServerUpdate, launched: DiskRow | undefined): boolean {
  if (!launched) return true;
  if (launched.stamp !== stampOf(configuredHeaders())) return true;
  return head.commitTime > launched.commitTime;
}

/** Rule 1. */
function newestLaunchable(): [string, DiskRow] | undefined {
  const configured = stampOf(configuredHeaders());
  return [...device.disk.entries()]
    .filter(([, row]) => row.stamp === configured)
    .sort(([, left], [, right]) => right.commitTime - left.commitTime)[0];
}

/** Rule 2. */
function download(head: ServerUpdate): void {
  if (device.disk.has(head.id)) return;
  device.disk.set(head.id, {
    stamp: stampOf(configuredHeaders()),
    commitTime: head.commitTime,
    branch: head.branch,
    embedded: false,
  });
}

/** Rule 5. */
function reap(launchedId: string): void {
  const launched = device.disk.get(launchedId);
  if (!launched) return;
  const older = [...device.disk.entries()].filter(([, row]) => row.commitTime < launched.commitTime);
  const survivor =
    device.platform === 'android'
      ? [...older].sort(([, left], [, right]) => right.commitTime - left.commitTime)[0]
      : older[older.length - 1];
  for (const [id, row] of older) {
    if (id === survivor?.[0]) continue;
    if (device.platform === 'android' && row.embedded) continue;
    device.disk.delete(id);
  }
}

/** Rules 1, 4, 5 and 6, in the order a launch applies them. */
function coldStart(): string {
  device.downloadedId = undefined;
  device.launchBlockedOnDownload = false;

  // Rule 4.
  let launchable = newestLaunchable();
  const embeddedWanted =
    launchable === undefined ||
    (stampOf(configuredHeaders()) === BAKED_STAMP && device.embedded.commitTime > launchable[1].commitTime);
  if (embeddedWanted && !device.disk.has(device.embedded.id)) {
    device.disk.set(device.embedded.id, {
      stamp: device.platform === 'ios' ? stampOf(configuredHeaders()) : BAKED_STAMP,
      commitTime: device.embedded.commitTime,
      branch: null,
      embedded: true,
    });
    launchable = newestLaunchable();
  }

  // Rule 6: nothing to show, so the splash waits on the network.
  if (launchable === undefined && device.online) {
    const head = serverHead();
    if (head) {
      device.launchBlockedOnDownload = true;
      download(head);
      launchable = newestLaunchable();
    }
  }
  if (launchable === undefined) {
    device.emergencyLaunch = true;
    device.runningId = device.embedded.id;
    return 'EMERGENCY';
  }

  device.emergencyLaunch = false;
  device.runningId = launchable[0];

  // Rule 6: the launch-time check, in the background.
  if (device.online) {
    const head = serverHead();
    if (head && shouldLoad(head, launchable[1])) {
      download(head);
      device.downloadedId = head.id;
    }
  }
  reap(device.runningId);
  return device.runningId;
}

/** A store update: a new binary, so a new runtime, so nothing on disk still counts. */
function installNewBinary(embeddedId: string, commitTime: number): void {
  device.embedded = { id: embeddedId, commitTime };
  device.disk = new Map();
  device.server = new Map();
}

vi.mock('expo-updates', () => ({
  isEnabled: true,
  channel: 'production',
  runtimeVersion: 'fingerprint',
  UpdateCheckResultNotAvailableReason: {
    NO_UPDATE_AVAILABLE_ON_SERVER: 'noUpdateAvailableOnServer',
    UPDATE_REJECTED_BY_SELECTION_POLICY: 'updateRejectedBySelectionPolicy',
  },
  get updateId() {
    return device.runningId;
  },
  get isEmbeddedLaunch() {
    return device.runningId === device.embedded.id;
  },
  get isEmergencyLaunch() {
    return device.emergencyLaunch;
  },
  get manifest() {
    return { extra: { branch: device.disk.get(device.runningId)?.branch ?? null } };
  },
  get latestContext() {
    return {
      isStartupProcedureRunning: false,
      isChecking: false,
      isDownloading: false,
      downloadedManifest: device.downloadedId ? { id: device.downloadedId } : undefined,
    };
  },
  addUpdatesStateChangeListener: () => ({ remove: () => {} }),
  setUpdateRequestHeadersOverride: (headers: Record<string, string> | null) => {
    device.override = headers;
  },
  checkForUpdateAsync: async () => {
    if (!device.online) throw new Error('Failed to check for update');
    const head = serverHead();
    if (!head) return { isAvailable: false, reason: 'noUpdateAvailableOnServer' };
    const launched = device.emergencyLaunch ? undefined : device.disk.get(device.runningId);
    return shouldLoad(head, launched)
      ? { isAvailable: true, manifest: { id: head.id } }
      : { isAvailable: false, reason: 'updateRejectedBySelectionPolicy' };
  },
  fetchUpdateAsync: async () => {
    if (!device.online) throw new Error('Failed to download update');
    const head = serverHead();
    const launched = device.emergencyLaunch ? undefined : device.disk.get(device.runningId);
    if (!head || !shouldLoad(head, launched)) return { isNew: false };
    download(head);
    device.downloadedId = head.id;
    // Rule 2: `isNew: true` even when the row was already there.
    return { isNew: true, manifest: { id: head.id } };
  },
  reloadAsync: async () => {
    device.reloads += 1;
  },
}));
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      updates: {
        url: 'https://updates.boardsesh.com/manifest',
        requestHeaders: { 'expo-channel-name': 'production', 'expo-app-id': 'app-id', 'xprem-branch': '' },
      },
    },
  },
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return device.platform;
    },
  },
}));
vi.mock('../../ota-channel-override-cleanup', () => ({ isBranchSurfingBuild: () => true }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => {
    if (key in device.settings) return device.settings[key];
    return key === 'earlyUpdates' || key === 'otaLeaveOwed' ? false : null;
  },
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

function serveSurfingOff(): void {
  fetchMock.mockImplementation(
    async () => new Response('', { status: 404, headers: { 'xprem-branch-surfing': 'off' } }),
  );
}

const PINNED_EARLY = { 'expo-channel-name': 'production', 'expo-app-id': 'app-id', 'xprem-branch': 'pr-beta' };
const ENVIRONMENT = {
  surfingBuild: true,
  surfingReady: true,
  flagsResolved: true,
  flag: 'on',
  flagOffConfirmed: false,
} as const;
const FLAG_OFF = { ...ENVIRONMENT, flag: 'off', flagOffConfirmed: true } as const;

/**
 * A new JS session over the same device: the modules are re-evaluated the way
 * a relaunch re-evaluates them, since qa-surf reads the launch-time pin once.
 * Returns what the launch-time sync would do with it.
 */
async function openApp() {
  const launched = coldStart();
  vi.resetModules();
  const surf = await import('../qa-surf');
  const earlyUpdates = await import('../early-updates');
  surf.adoptRunningOtaPin();
  return { launched, surf, earlyUpdates };
}

describe.each(['ios', 'android'] as const)('on %s', (platform: Platform) => {
  beforeEach(async () => {
    // Spies on the expo-updates stand-in must not carry into the next case.
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    device.platform = platform;
    device.override = null;
    device.embedded = { id: 'embedded-1', commitTime: 0 };
    device.disk = new Map();
    device.runningId = 'embedded-1';
    device.emergencyLaunch = false;
    device.downloadedId = undefined;
    device.online = true;
    device.reloads = 0;
    device.server = new Map();
    device.settings = {};
    // A phone that has been on the regular track for a while: installed, then
    // two stable updates launched, so the reaper has run over the embedded row.
    publish('production', 'stable-1', 10);
    coldStart();
    coldStart();
    publish('production', 'stable-2', 15);
    coldStart();
    expect(coldStart()).toBe('stable-2');
    publish('pr-beta', 'beta-1', 20);
    serveBranchList('pr-beta', 'pr-123');
  });

  describe('the model itself', () => {
    it('keeps the embedded row on Android and reaps it on iOS', () => {
      expect(device.disk.has('embedded-1')).toBe(platform === 'android');
      expect([...device.disk.keys()]).toContain('stable-1');
    });

    it('launches nothing stamped for a pin written without a download', () => {
      // What the first version of "Get updates early" did: write the override
      // and wait for the next launch.
      device.override = PINNED_EARLY;
      device.online = false;

      if (platform === 'android') {
        // The embedded row carries the baked headers: nothing matches.
        expect(coldStart()).toBe('EMERGENCY');
      } else {
        // The embedded row is gone, so it is inserted again under the pin and
        // launched normally: the build's original JS, however old.
        expect(coldStart()).toBe('embedded-1');
        expect(device.emergencyLaunch).toBe(false);
      }
    });

    it('does not restamp an update that is already on disk', async () => {
      // The server does not have the branch, so it answers with the channel's
      // own update: the one already running, under the old stamp. "Downloaded",
      // and still not launchable under the pin.
      await openApp();
      device.server.delete('pr-beta');
      device.override = PINNED_EARLY;

      const { fetchUpdateAsync } = await import('expo-updates');
      expect(await fetchUpdateAsync()).toMatchObject({ isNew: true, manifest: { id: 'stable-2' } });
      expect(device.disk.get('stable-2')?.stamp).toBe(BAKED_STAMP);
    });
  });

  describe('joining early updates', () => {
    it('online: the next cold start launches the early update, never mid-session', async () => {
      const { earlyUpdates } = await openApp();

      expect(await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('joined');

      expect(device.reloads).toBe(0);
      expect(device.settings.otaPinnedBranch).toBe('pr-beta');
      expect(device.settings.otaPinSwitchInFlight).toBeNull();
      expect(coldStart()).toBe('beta-1');
      expect(device.launchBlockedOnDownload).toBe(false);
    });

    it('then relaunching offline still launches the early update, with no request', async () => {
      const { earlyUpdates } = await openApp();
      await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);

      device.online = false;
      const relaunch = await openApp();

      expect(relaunch.launched).toBe('beta-1');
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
      expect(coldStart()).toBe('stable-2');

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
      expect(coldStart()).toBe('stable-2');
    });

    it('the list offers the branch but the server serves the running update: pin put back', async () => {
      // The list and the manifest disagreeing, or the branch deleted in between.
      const { earlyUpdates } = await openApp();
      device.server.delete('pr-beta');

      expect(await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('waiting');

      expect(device.override).toBeNull();
      expect(coldStart()).toBe('stable-2');
    });

    it('the download fails half way: pin put back, journal closed', async () => {
      const { surf } = await openApp();
      const updates = await import('expo-updates');
      vi.spyOn(updates, 'fetchUpdateAsync').mockRejectedValueOnce(new Error('Failed to download update'));

      await expect(surf.joinEarlyUpdatesTrack()).rejects.toThrow('Failed to download update');

      expect(device.override).toBeNull();
      expect(device.settings.otaPinSwitchInFlight).toBeNull();
      expect(coldStart()).toBe('stable-2');
    });

    it('follows the branch as it publishes', async () => {
      const { earlyUpdates } = await openApp();
      await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      publish('pr-beta', 'beta-2', 30);

      // The first launch runs beta-1 and its launch-time check fetches beta-2.
      expect(coldStart()).toBe('beta-1');
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
      expect(coldStart()).toBe('stable-2');
    });

    it('fetches a regular update it does not have before dropping the pin', async () => {
      const { earlyUpdates } = await memberOnBeta();
      publish('production', 'stable-3', 25);

      await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT);

      expect(coldStart()).toBe('stable-3');
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
      expect(coldStart()).toBe('stable-2');
    });

    it('straight after joining, in the same session', async () => {
      // The regular track's newest update is the one running, so there is
      // nothing to download, and nothing needs to be: the check being turned
      // down by the loader policy proves the running bundle matches no pin.
      const { earlyUpdates } = await openApp();
      await earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);

      expect(await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT)).toBe('left');
      expect(coldStart()).toBe('stable-2');
    });

    it('the feature is switched off: a member is moved back and keeps the choice', async () => {
      const { earlyUpdates } = await memberOnBeta();

      expect(await earlyUpdates.syncEarlyUpdates(FLAG_OFF)).toBe('left');

      expect(device.settings.earlyUpdates).toBe(true);
      expect(coldStart()).toBe('stable-2');

      // And back on: the member rejoins without touching the switch.
      const relaunch = await openApp();
      expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('joined');
      expect(coldStart()).toBe('beta-1');
    });

    it('a cached or unconfirmed "off" moves nobody', async () => {
      const { earlyUpdates } = await memberOnBeta();

      expect(await earlyUpdates.syncEarlyUpdates({ ...FLAG_OFF, flagOffConfirmed: false })).toBe('none');
      expect(device.override).toEqual(PINNED_EARLY);
    });

    it('a flag that flaps moves a member at most once per launch', async () => {
      const { earlyUpdates } = await memberOnBeta();

      expect(await earlyUpdates.syncEarlyUpdates(FLAG_OFF)).toBe('left');
      expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('joined');
      // Off again in the same launch: left where it is.
      expect(await earlyUpdates.syncEarlyUpdates(FLAG_OFF)).toBe('none');
      expect(device.settings.otaPinnedBranch).toBe('pr-beta');
    });

    it('cannot leave while the server serves the regular update under the pin, and stops retrying', async () => {
      // The branch disappeared after the member joined. The server now answers
      // their pinned requests with the regular track's update, which lands on
      // disk under the pin's stamp and can never launch without it.
      await memberOnBeta();
      device.server.delete('pr-beta');
      publish('production', 'stable-3', 30);
      await openApp();
      const { launched, earlyUpdates } = await openApp();
      expect(launched).toBe('stable-3');
      expect(device.disk.get('stable-3')?.stamp).not.toBe(BAKED_STAMP);

      expect(await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT)).toBe('blocked');

      // Still pinned, still launching normally, running the regular track's JS.
      expect(device.settings.otaPinnedBranch).toBe('pr-beta');
      expect(device.settings.otaLeaveBlockedUpdateId).toBe('stable-3');
      const relaunch = await openApp();
      expect(relaunch.launched).toBe('stable-3');

      // No write-check-restore cycle while the same update is running.
      const check = vi.spyOn(await import('expo-updates'), 'checkForUpdateAsync');
      expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');
      expect(check).not.toHaveBeenCalled();
      expect(device.override).toEqual(PINNED_EARLY);
    });

    it('the blocked leave completes once the branch is back and the regular track publishes', async () => {
      await memberOnBeta();
      device.server.delete('pr-beta');
      publish('production', 'stable-3', 30);
      await openApp();
      const blocked = await openApp();
      await blocked.earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT);

      // The branch is offered again, so pinned launches fetch IT, and a new
      // regular update is no longer pulled in under the pin first.
      publish('pr-beta', 'beta-2', 40);
      publish('production', 'stable-4', 35);
      await openApp();
      const { launched, earlyUpdates } = await openApp();
      expect(launched).toBe('beta-2');

      expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('left');
      expect(coldStart()).toBe('stable-4');
    });
  });

  describe('branch surfing switched off on the server', () => {
    it('unpins a member safely and keeps the choice', async () => {
      const first = await openApp();
      await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      const { earlyUpdates } = await openApp();

      await earlyUpdates.noteBranchSurfingOff();

      expect(device.override).toBeNull();
      expect(device.settings.earlyUpdates).toBe(true);
      expect(device.settings.otaLeaveOwed ?? false).toBe(false);
      expect(coldStart()).toBe('stable-2');
    });

    it('does not rejoin while surfing stays off', async () => {
      const first = await openApp();
      await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      const session = await openApp();
      await session.earlyUpdates.noteBranchSurfingOff();
      serveSurfingOff();

      const relaunch = await openApp();
      expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('waiting');
      expect(device.override).toBeNull();
    });

    it('records the leave as owed when it cannot be made, and the launch sync retries it', async () => {
      const first = await openApp();
      await first.surf.surfToStaging();
      publish('pr-staging', 'staging-1', 50);
      await first.surf.surfToStaging();
      const tester = await openApp();
      expect(tester.launched).toBe('staging-1');

      device.online = false;
      await tester.earlyUpdates.noteBranchSurfingOff();
      expect(device.settings.otaLeaveOwed).toBe(true);
      expect(device.settings.otaPinnedBranch).toBe('pr-staging');

      device.online = true;
      const relaunch = await openApp();
      expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('left');
      expect(device.settings.otaLeaveOwed).toBe(false);
      expect(coldStart()).toBe('stable-2');
    });

    it('attempts the leave for a pin the record never knew about', async () => {
      // Pinned by a build older than the record, with nothing loaded yet.
      const { earlyUpdates } = await openApp();
      device.override = { ...PINNED_EARLY, 'xprem-branch': 'pr-123' };

      await earlyUpdates.noteBranchSurfingOff();

      expect(device.override).toBeNull();
      expect(coldStart()).toBe('stable-2');
    });
  });

  describe('a switch the app was killed in the middle of', () => {
    it('mid-join, then opened online', async () => {
      // The override and the journal were written; the record never was.
      await openApp();
      device.settings = { earlyUpdates: true, otaPinSwitchInFlight: { to: 'pr-beta' } };
      device.override = PINNED_EARLY;

      const { launched, earlyUpdates } = await openApp();

      if (platform === 'android') {
        // Nothing matched, so the splash waited on the download.
        expect(launched).toBe('beta-1');
        expect(device.launchBlockedOnDownload).toBe(true);
      } else {
        // The embedded bundle, inserted under the pin; the early update follows.
        expect(launched).toBe('embedded-1');
        expect(device.emergencyLaunch).toBe(false);
      }
      // The launch proved the pin, so the record catches up and nothing is redone.
      expect(device.settings.otaPinnedBranch).toBe('pr-beta');
      expect(device.settings.otaPinSwitchInFlight).toBeNull();
      expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');
      expect(coldStart()).toBe('beta-1');
    });

    it('mid-join, then opened offline three times', async () => {
      await openApp();
      device.settings = { earlyUpdates: true, otaPinSwitchInFlight: { to: 'pr-beta' } };
      device.override = PINNED_EARLY;
      device.online = false;

      const first = await openApp();
      if (platform === 'android') {
        expect(first.launched).toBe('EMERGENCY');
        // The pin is dropped at once, download or no download.
        expect(await first.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('deferred');
        expect(device.override).toBeNull();

        const second = await openApp();
        expect(second.launched).toBe('stable-2');
        expect(await second.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('deferred');
        expect((await openApp()).launched).toBe('stable-2');
      } else {
        // No emergency, but the build's original JS until a network arrives.
        expect(first.launched).toBe('embedded-1');
        expect(device.emergencyLaunch).toBe(false);
        expect((await openApp()).launched).toBe('embedded-1');
        expect((await openApp()).launched).toBe('embedded-1');
      }

      device.online = true;
      await openApp();
      const settled = await openApp();
      await settled.earlyUpdates.syncEarlyUpdates(ENVIRONMENT);
      expect(coldStart()).toBe('beta-1');
    });

    it('mid-leave: the phone does not flap back onto early updates', async () => {
      const joining = await openApp();
      await joining.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      await openApp();
      // Killed after the override was cleared: the record still says pr-beta.
      device.settings = { ...device.settings, earlyUpdates: false, otaPinSwitchInFlight: { to: null } };
      device.override = null;

      const { launched, earlyUpdates } = await openApp();

      expect(launched).toBe('stable-2');
      expect(device.settings.otaPinnedBranch).toBeNull();
      expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');
      expect(device.override).toBeNull();
      expect(coldStart()).toBe('stable-2');
    });

    it('a stale record is not written back as a pin when the leave finds nothing newer', async () => {
      // The same kill, on a build without the journal: record pr-beta, no
      // override. The check is turned down by the loader policy, which proves
      // the running bundle launched with no pin.
      const joining = await openApp();
      await joining.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      await openApp();
      device.settings = { ...device.settings, earlyUpdates: false };
      device.override = null;
      coldStart();
      vi.resetModules();
      const earlyUpdates = await import('../early-updates');

      expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('left');
      expect(device.override).toBeNull();
      expect(device.settings.otaPinnedBranch).toBeNull();
    });
  });

  describe('an emergency launch that has nothing to do with branches', () => {
    it('costs a climber who never had a pin no request and no wait', async () => {
      // A crashing update, a corrupted download: any climber can land here.
      const { earlyUpdates } = await openApp();
      device.emergencyLaunch = true;
      const updates = await import('expo-updates');
      const check = vi.spyOn(updates, 'checkForUpdateAsync');
      const fetchUpdate = vi.spyOn(updates, 'fetchUpdateAsync');
      fetchMock.mockClear();

      expect(await earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');

      expect(check).not.toHaveBeenCalled();
      expect(fetchUpdate).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(device.override).toBeNull();
    });
  });

  describe('a store update while pinned', () => {
    async function memberUpdatesTheApp() {
      const first = await openApp();
      await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      await openApp();
      installNewBinary('embedded-2', 100);
    }

    it('first open, online, with early updates published for the new binary', async () => {
      await memberUpdatesTheApp();
      publish('production', 'stable-9', 110);
      publish('pr-beta', 'beta-9', 120);

      const { launched } = await openApp();

      if (platform === 'android') {
        // THE KNOWN COST: the embedded row carries the baked headers, so every
        // release starts with the splash waiting on a full download.
        expect(launched).toBe('beta-9');
        expect(device.launchBlockedOnDownload).toBe(true);
      } else {
        expect(launched).toBe('embedded-2');
        expect(device.launchBlockedOnDownload).toBe(false);
        expect(coldStart()).toBe('beta-9');
      }
    });

    it('first open, offline', async () => {
      await memberUpdatesTheApp();
      device.online = false;

      const { launched, earlyUpdates } = await openApp();

      if (platform === 'android') {
        expect(launched).toBe('EMERGENCY');
        // Repaired without a network, so the next open is an ordinary one.
        await earlyUpdates.syncEarlyUpdates(ENVIRONMENT);
        expect((await openApp()).launched).toBe('embedded-2');
        expect(device.emergencyLaunch).toBe(false);
      } else {
        expect(launched).toBe('embedded-2');
        expect(device.emergencyLaunch).toBe(false);
      }
    });

    it('then switching off before the regular track has anything for the new binary', async () => {
      await memberUpdatesTheApp();
      const { launched, earlyUpdates } = await openApp();

      if (platform === 'android') {
        // Online with nothing published at all: nothing to download either.
        expect(launched).toBe('EMERGENCY');
        return;
      }
      // iOS: the embedded row is stamped for the pin. Dropping the pin now
      // would leave nothing launchable, for good.
      expect(launched).toBe('embedded-2');
      expect(await earlyUpdates.setEarlyUpdatesChoice(false, ENVIRONMENT)).toBe('deferred');
      expect(device.override).toEqual(PINNED_EARLY);
      expect((await openApp()).launched).toBe('embedded-2');
      expect(device.emergencyLaunch).toBe(false);

      // The regular track publishes. This launch's own background check
      // fetches it first, under the pin, so the leave is refused on it: the
      // phone ends up running the regular track's JS, still pinned, launching
      // normally. It is never left with nothing to launch.
      publish('production', 'stable-9', 110);
      const later = await openApp();
      expect(await later.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('blocked');
      const settled = await openApp();
      expect(settled.launched).toBe('stable-9');
      expect(device.emergencyLaunch).toBe(false);
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
      expect(await earlyUpdates.syncEarlyUpdates(FLAG_OFF)).toBe('none');
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

    it('a non-member leaving a preview goes back to production', async () => {
      const first = await openApp();
      await first.surf.surfToPr(123);
      const { earlyUpdates } = await openApp();

      await earlyUpdates.returnToOwnTrack(false);

      expect(device.settings.otaPinnedBranch).toBeNull();
      expect(coldStart()).toBe('stable-2');
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
      const production = device.server.get('production');
      device.server.delete('pr-123');
      device.server.delete('production');
      expect(await surf.surfToPr(123)).toBe('nothing-to-load');
      if (production) device.server.set('production', production);

      expect(await earlyUpdates.returnToOwnTrack(true)).toBe('early-updates-next-launch');

      device.online = false;
      await expect(surf.surfToStaging()).rejects.toThrow();

      expect(device.settings.otaPinnedBranch).toBe('pr-beta');
      expect(device.override).toMatchObject({ 'xprem-branch': 'pr-beta' });
      expect(coldStart()).toBe('beta-1');
    });

    it('a member whose PR merged and whose branch is gone is returned to early updates', async () => {
      const first = await openApp();
      await first.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT);
      await first.surf.surfToPr(123);
      expect((await openApp()).launched).toBe('preview-123');

      // Merged: the branch is deleted, and the regular track moves past it.
      device.server.delete('pr-123');
      publish('production', 'stable-3', 60);
      serveBranchList('pr-beta');
      await openApp();
      const stranded = await openApp();
      // Running the regular track's update under a pin to a branch that no
      // longer exists. No verdict was ever filed, so nothing else will end this.
      expect(stranded.launched).toBe('stable-3');
      expect(device.settings.otaPinnedBranch).toBe('pr-123');

      expect(await stranded.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('joined');

      expect(device.settings.otaPinnedBranch).toBe('pr-beta');
      expect(coldStart()).toBe('beta-1');
    });

    it('a non-member stranded the same way cannot be unpinned, and can still join', async () => {
      const first = await openApp();
      await first.surf.surfToPr(123);
      await openApp();
      device.server.delete('pr-123');
      publish('production', 'stable-3', 60);
      serveBranchList('pr-beta');
      await openApp();
      const stranded = await openApp();
      expect(stranded.launched).toBe('stable-3');

      // The regular update is on disk under the dead pin's stamp.
      expect(await stranded.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('blocked');
      expect(device.settings.otaLeaveBlockedUpdateId).toBe('stable-3');
      // Functionally on the regular track all the same, launching normally.
      const relaunch = await openApp();
      expect(relaunch.launched).toBe('stable-3');
      expect(await relaunch.earlyUpdates.syncEarlyUpdates(ENVIRONMENT)).toBe('none');

      // And switching early updates on works from here.
      expect(await relaunch.earlyUpdates.setEarlyUpdatesChoice(true, ENVIRONMENT)).toBe('joined');
      expect(coldStart()).toBe('beta-1');
    });
  });
});
