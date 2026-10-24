import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOtaOperationOwnerForTests, runOtaOperation } from '../ota-operation-owner';

type NativeContext = {
  isStartupProcedureRunning: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  isUpdateAvailable: boolean;
  isUpdatePending: boolean;
  restartCount: number;
  sequenceNumber: number;
  downloadProgress: number;
  checkError?: { message: string };
  downloadError?: { message: string };
  downloadedManifest?: { id: string };
  rollback?: { commitTime: string };
};
type StateChangeListener = (event: { context: NativeContext }) => void;

// One shared log, so the order of track / flush / reload is a single assertion.
const calls = vi.hoisted(() => ({ log: [] as string[] }));

// Mirrors expo-updates' UpdatesEmitter: a module-level `latestContext` that the
// native event handler replaces BEFORE it calls the listeners, plus a listener
// set behind `addUpdatesStateChangeListener`. `silentlyAdvance` moves the
// context with no event at all, which is the gap `useUpdates()` falls into.
const updates = vi.hoisted(() => ({
  latestContext: {} as NativeContext,
  listeners: new Set<StateChangeListener>(),
  isEnabled: true,
  isEmbeddedLaunch: true,
  isEmergencyLaunch: false,
  runtimeVersion: 'fingerprint-new' as string | null,
  updateId: 'embedded-update',
  reloadAsync: vi.fn(),
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
}));
const analytics = vi.hoisted(() => ({ track: vi.fn(), flush: vi.fn() }));
const errors = vi.hoisted(() => ({ reportHandledError: vi.fn(), addErrorBreadcrumb: vi.fn() }));
const preferences = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  removePreference: vi.fn(),
}));
const connectivity = vi.hoisted(() => ({
  refreshDeviceState: vi.fn(),
  snapshot: { device: 'online', deviceReachability: 'reachable', offlineMode: false } as {
    device: string;
    deviceReachability: string;
    offlineMode: boolean;
  },
  throwOnRead: false,
}));
const cleanup = vi.hoisted(() => ({ runChannelOverrideCleanupOnce: vi.fn() }));
const platform = vi.hoisted(() => ({ os: 'ios', appState: 'active' }));

vi.mock('expo-updates', () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  get isEmbeddedLaunch() {
    return updates.isEmbeddedLaunch;
  },
  get isEmergencyLaunch() {
    return updates.isEmergencyLaunch;
  },
  get runtimeVersion() {
    return updates.runtimeVersion;
  },
  get updateId() {
    return updates.updateId;
  },
  get latestContext() {
    return updates.latestContext;
  },
  addUpdatesStateChangeListener: (listener: StateChangeListener) => {
    updates.listeners.add(listener);
    return {
      remove() {
        updates.listeners.delete(listener);
      },
    };
  },
  reloadAsync: updates.reloadAsync,
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  AppState: {
    get currentState() {
      return platform.appState;
    },
  },
}));

vi.mock('../anonymous-ota-health', () => ({
  reportAnonymousOtaLaunch: (properties: unknown) => {
    analytics.track('OTA Launch Update', properties);
    return analytics.flush();
  },
}));
vi.mock('../error-reporting', () => ({
  reportHandledError: errors.reportHandledError,
  addErrorBreadcrumb: errors.addErrorBreadcrumb,
}));
vi.mock('../preference-store', () => ({
  getPreference: preferences.getPreference,
  setPreference: preferences.setPreference,
  removePreference: preferences.removePreference,
}));
vi.mock('../connectivity/connectivity-store', () => ({
  refreshDeviceState: connectivity.refreshDeviceState,
  getConnectivitySnapshot: () => {
    if (connectivity.throwOnRead) throw new Error('connectivity store not bound');
    return connectivity.snapshot;
  },
}));
vi.mock('../ota-channel-override-cleanup-run', () => ({
  runChannelOverrideCleanupOnce: cleanup.runChannelOverrideCleanupOnce,
}));
vi.mock('../qa/qa-surf', async () => {
  const { readOtaHeaderRevision } = await import('../ota-operation-owner');
  const capture = () => {
    const { downloadedManifest, rollback } = updates.latestContext;
    if (downloadedManifest)
      return {
        headerRevision: readOtaHeaderRevision(),
        pin: null,
        target: { kind: 'update' as const, id: downloadedManifest.id },
      };
    if (rollback)
      return {
        headerRevision: readOtaHeaderRevision(),
        pin: null,
        target: { kind: 'rollback' as const, commitTime: rollback.commitTime },
      };
    return null;
  };
  return {
    waitForOtaUpdatesIdle: async () => {},
    fetchOwnedOtaUpdate: async () => {
      const fetched = (await updates.fetchUpdateAsync()) as {
        isNew: boolean;
        manifest?: { id: string };
        isRollBackToEmbedded?: boolean;
      };
      if (fetched.isNew && fetched.manifest) {
        updates.latestContext = {
          ...updates.latestContext,
          isUpdatePending: true,
          downloadedManifest: fetched.manifest,
        };
      }
      if (fetched.isRollBackToEmbedded) {
        updates.latestContext = {
          ...updates.latestContext,
          isUpdatePending: true,
          rollback: { commitTime: 'rollback-time' },
        };
      }
      return fetched;
    },
    captureOtaReloadReceipt: capture,
    isOtaReloadReceiptCurrent: (receipt: ReturnType<typeof capture>) =>
      JSON.stringify(receipt) === JSON.stringify(capture()),
  };
});

// Imported after the mocks (vi.mock is hoisted above imports).
import {
  getLaunchUpdateFirstLaunch,
  getLaunchUpdateGateFlags,
  getLaunchUpdateProgress,
  getLaunchUpdateStage,
  notifyLaunchUpdateAuthReady,
  notifyLaunchUpdatePlaceholderPainted,
  resetLaunchUpdateGateForTests,
  startLaunchUpdateGate,
  subscribeLaunchUpdateGate,
} from '../launch-update-gate-store';
import { beginDatabaseInitAttempt, resetDatabaseInitActivityForTests } from '../../db/init-activity';
import {
  getJsRestartCount,
  isLaunchReloadPossible,
  isLaunchReloadRequested,
  resetLaunchReloadWindowForTests,
} from '../launch-reload-window';

const PRODUCTION = { development: false };
const MARKER_KEY = 'ota_first_launch_update_runtime_v1';
const RELOAD_TARGET_KEY = 'ota_launch_update_last_reload_target_v1';
const OUTLIVED_GRACE_KEY = 'ota_launch_update_reload_outlived_grace_v1';

const CHECKING: NativeContext = {
  isStartupProcedureRunning: true,
  isChecking: true,
  isDownloading: false,
  isUpdateAvailable: false,
  isUpdatePending: false,
  restartCount: 0,
  sequenceNumber: 2,
  downloadProgress: 0,
};
const DOWNLOADING: NativeContext = { ...CHECKING, isChecking: false, isUpdateAvailable: true, isDownloading: true };
const IDLE: NativeContext = { ...CHECKING, isStartupProcedureRunning: false, isChecking: false };
const PENDING: NativeContext = {
  ...IDLE,
  isUpdateAvailable: true,
  isUpdatePending: true,
  downloadedManifest: { id: 'next-update' },
};

/** A native state-change event, delivered the way UpdatesEmitter delivers it. */
function emit(next: Partial<NativeContext>) {
  updates.latestContext = {
    ...updates.latestContext,
    ...next,
    sequenceNumber: updates.latestContext.sequenceNumber + 1,
  };
  for (const listener of updates.listeners) listener({ context: updates.latestContext });
}

/** The native state moved on and no listener heard about it. */
function silentlyAdvance(next: Partial<NativeContext>) {
  updates.latestContext = {
    ...updates.latestContext,
    ...next,
    sequenceNumber: updates.latestContext.sequenceNumber + 1,
  };
}

async function advance(milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

/** Start a gated launch with auth already resolved and the reads settled. */
async function startGate({ authReady = true }: { authReady?: boolean } = {}) {
  startLaunchUpdateGate(PRODUCTION);
  if (authReady) notifyLaunchUpdateAuthReady();
  await advance(0);
}

function launchUpdateEvents() {
  return analytics.track.mock.calls
    .filter(([name]) => name === 'OTA Launch Update')
    .map(([, properties]) => properties);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetOtaOperationOwnerForTests();
  resetLaunchUpdateGateForTests();
  resetDatabaseInitActivityForTests();
  resetLaunchReloadWindowForTests();
  calls.log = [];
  updates.latestContext = DOWNLOADING;
  updates.listeners.clear();
  updates.isEnabled = true;
  updates.isEmbeddedLaunch = true;
  updates.isEmergencyLaunch = false;
  updates.runtimeVersion = 'fingerprint-new';
  updates.updateId = 'embedded-update';
  updates.reloadAsync.mockReset().mockImplementation(async () => {
    calls.log.push('reload');
  });
  updates.checkForUpdateAsync.mockReset().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false });
  updates.fetchUpdateAsync
    .mockReset()
    .mockResolvedValue({ isNew: true, isRollBackToEmbedded: false, manifest: { id: 'fetched-update' } });
  analytics.track.mockReset().mockImplementation((name: string, properties: { outcome?: string }) => {
    calls.log.push(`track:${name}:${properties.outcome ?? ''}`);
  });
  analytics.flush.mockReset().mockImplementation(async () => {
    calls.log.push('flush');
  });
  errors.reportHandledError.mockReset();
  errors.addErrorBreadcrumb.mockReset();
  preferences.stored = new Map();
  preferences.getPreference.mockReset().mockImplementation(async (key: string) => preferences.stored.get(key) ?? null);
  preferences.setPreference.mockReset().mockImplementation(async (key: string, value: unknown) => {
    preferences.stored.set(key, value);
    calls.log.push(`set:${key}`);
  });
  preferences.removePreference.mockReset().mockImplementation(async (key: string) => {
    preferences.stored.delete(key);
  });
  connectivity.refreshDeviceState.mockReset().mockResolvedValue(undefined);
  connectivity.snapshot = { device: 'online', deviceReachability: 'reachable', offlineMode: false };
  connectivity.throwOnRead = false;
  cleanup.runChannelOverrideCleanupOnce.mockReset().mockResolvedValue({ staleOverrideActive: false });
  platform.os = 'ios';
  platform.appState = 'active';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launches the gate does not cover', () => {
  it('is resolved at once in a dev build, and touches nothing', async () => {
    startLaunchUpdateGate({ development: true });

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
    await advance(20_000);
    expect(preferences.getPreference).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(updates.listeners.size).toBe(0);
  });

  it.each([
    ['updates are disabled', () => (updates.isEnabled = false)],
    ['expo-updates emergency-launched', () => (updates.isEmergencyLaunch = true)],
    ['iOS started the process in the background', () => (platform.appState = 'background')],
    ['this runtime came from a reload', () => (updates.latestContext = { ...PENDING, restartCount: 1 })],
  ])('is resolved at once when %s', async (_label, arrange) => {
    arrange();
    startLaunchUpdateGate(PRODUCTION);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    await advance(20_000);
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(false);
    expect(analytics.track).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('leaves a breadcrumb when a background read is what skipped the gate', () => {
    platform.appState = 'background';
    startLaunchUpdateGate(PRODUCTION);

    expect(errors.addErrorBreadcrumb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ category: 'ota', message: 'launch update gate skipped: background launch' }),
    );
  });

  it('leaves no breadcrumb when the launch was never eligible anyway', () => {
    platform.appState = 'background';
    startLaunchUpdateGate({ development: true });

    expect(errors.addErrorBreadcrumb).not.toHaveBeenCalled();
  });

  it('treats an inactive iOS read as a foreground launch', () => {
    platform.appState = 'inactive';
    startLaunchUpdateGate(PRODUCTION);

    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
  });

  it('never gates the browser target, though expo-updates reports itself enabled there', async () => {
    platform.os = 'web';
    updates.runtimeVersion = '';
    updates.isEmbeddedLaunch = false;
    updates.latestContext = { ...IDLE, sequenceNumber: 0 };

    startLaunchUpdateGate(PRODUCTION);

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(updates.listeners.size).toBe(0);
    await advance(20_000);
    expect(analytics.track).not.toHaveBeenCalled();
    expect(preferences.getPreference).not.toHaveBeenCalled();
    expect(cleanup.runChannelOverrideCleanupOnce).not.toHaveBeenCalled();
  });

  it('still gates an Android launch that reads background before its activity resumes', () => {
    platform.os = 'android';
    platform.appState = 'background';
    startLaunchUpdateGate(PRODUCTION);

    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    expect(errors.addErrorBreadcrumb).not.toHaveBeenCalled();
  });
});

describe('a gated launch', () => {
  it('holds the launch, then tracks, flushes, persists and reloads once the update is downloaded', async () => {
    await startGate();
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);

    emit({ ...PENDING });
    await advance(0);

    expect(calls.log[0]).toBe('track:OTA Launch Update:updated');
    expect(calls.log.at(-1)).toBe('reload');
    expect(calls.log.slice(1, -1).toSorted()).toEqual(['flush', `set:${MARKER_KEY}`, `set:${RELOAD_TARGET_KEY}`]);
    expect(launchUpdateEvents()[0]).toMatchObject({
      outcome: 'updated',
      phase_at_release: 'download',
      trigger: 'fresh_install',
      cap_ms: 15_000,
      ota_runtime_version: 'fingerprint-new',
      ota_is_embedded: true,
    });
    expect(preferences.stored.get(MARKER_KEY)).toBe('fingerprint-new');
    expect(preferences.stored.get(RELOAD_TARGET_KEY)).toBe('next-update');
    // The app is restarting: the launch stays held rather than flashing the UI.
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
  });

  it('fires the event exactly once, however many times the state changes afterwards', async () => {
    await startGate();

    emit({ ...PENDING });
    await advance(0);
    emit({ downloadedManifest: { id: 'even-newer-update' } });
    emit({});
    await advance(20_000);

    expect(launchUpdateEvents()).toHaveLength(1);
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
  });

  it('keeps the splash over a cold start that is only checking for 2 s, then shows the placeholder', async () => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = CHECKING;
    await startGate();

    await advance(1_999);
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(false);

    await advance(1);
    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: false, showPlaceholder: true, placeholderPainted: false });
    expect(getLaunchUpdateStage()).toBe('checking');
    expect(getLaunchUpdateFirstLaunch()).toBe(false);
  });

  it('shows a fresh install the placeholder the moment its reads are done, before the server answers', async () => {
    updates.latestContext = CHECKING;
    startLaunchUpdateGate(PRODUCTION);
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(false);

    await advance(0);

    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(true);
    expect(getLaunchUpdateStage()).toBe('checking');
    expect(getLaunchUpdateFirstLaunch()).toBe(true);
  });

  it('shows a fresh install the placeholder at 1.5 s when its reads take the whole budget', async () => {
    updates.latestContext = CHECKING;
    connectivity.refreshDeviceState.mockReturnValue(new Promise<never>(() => {}));
    await startGate();

    await advance(1_499);
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(false);
    await advance(1);

    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(true);
  });

  it('shows a cold start the placeholder the moment its download starts, with the progress', async () => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = CHECKING;
    await startGate();
    await advance(600);
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(false);

    emit({ ...DOWNLOADING });

    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(true);
    expect(getLaunchUpdateStage()).toBe('installing');
    expect(getLaunchUpdateProgress()).toBe(0);
    emit({ downloadProgress: 0.42 });
    expect(getLaunchUpdateProgress()).toBe(0.42);
  });

  it('never shows the placeholder to a cold start that hears nothing newer inside the splash window', async () => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = CHECKING;
    const shown: boolean[] = [];
    subscribeLaunchUpdateGate(() => shown.push(getLaunchUpdateGateFlags().showPlaceholder));
    // Auth still pending, so a placeholder raised at any point would stay up.
    await startGate({ authReady: false });
    await advance(400);

    emit({ ...IDLE });
    await advance(10_000);

    expect(shown).not.toContain(true);
    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'nothing_newer', trigger: 'cold_start' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never raises the placeholder before its reads say the launch is offline', async () => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    connectivity.snapshot.offlineMode = true;
    startLaunchUpdateGate(PRODUCTION);
    // A download event lands while the reads are still out.
    emit({ downloadProgress: 0.1 });
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(false);

    await advance(0);

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
    expect(getLaunchUpdateStage()).toBe('checking');
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'offline' });
  });

  it('tells listeners when the copy moves to installing, though no progress has been reported', async () => {
    updates.latestContext = CHECKING;
    await startGate();
    const flagsBefore = getLaunchUpdateGateFlags();
    const onChange = vi.fn();
    subscribeLaunchUpdateGate(onChange);

    // The manifest answered with an update; the download has not reported yet.
    emit({ ...CHECKING, isChecking: false, isUpdateAvailable: true });

    expect(getLaunchUpdateStage()).toBe('installing');
    expect(getLaunchUpdateProgress()).toBeUndefined();
    expect(onChange).toHaveBeenCalledOnce();
    // The root layout reads only the flags, so it does not re-render for copy.
    expect(getLaunchUpdateGateFlags()).toBe(flagsBefore);
  });

  it('keeps saying installing once it has, through a stalled download and into the auth wait', async () => {
    updates.reloadAsync.mockReturnValue(new Promise<void>(() => {}));
    await startGate({ authReady: false });
    expect(getLaunchUpdateStage()).toBe('installing');

    // The download stalls and the climber's auth never settles: released.
    emit({ ...CHECKING, isChecking: false, isDownloading: false, isUpdateAvailable: false });
    await advance(15_000);

    expect(getLaunchUpdateGateFlags()).toMatchObject({ resolved: true, showPlaceholder: true });
    expect(getLaunchUpdateStage()).toBe('installing');
  });

  it('says installing while the reload it decided on is under way', async () => {
    updates.latestContext = CHECKING;
    updates.reloadAsync.mockReturnValue(new Promise<void>(() => {}));
    await startGate();

    // The download landed with no event of its own. The next event, with
    // nothing new in it, wakes the gate, and it settles on the reload while
    // its published copy still says "checking".
    silentlyAdvance({ ...PENDING });
    emit({});
    await advance(0);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(getLaunchUpdateStage()).toBe('installing');
    expect(getLaunchUpdateGateFlags().showPlaceholder).toBe(true);
  });

  it('marks the placeholder painted once, and only then lets the splash hide over it', async () => {
    updates.latestContext = CHECKING;
    await startGate();
    const onChange = vi.fn();
    subscribeLaunchUpdateGate(onChange);
    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: false, showPlaceholder: true, placeholderPainted: false });

    notifyLaunchUpdatePlaceholderPainted();
    notifyLaunchUpdatePlaceholderPainted();

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: false, showPlaceholder: true, placeholderPainted: true });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('keeps the flags object stable across progress events, so only the placeholder re-renders', async () => {
    await startGate();
    await advance(2_000);
    const flagsBefore = getLaunchUpdateGateFlags();
    const onChange = vi.fn();
    subscribeLaunchUpdateGate(onChange);

    emit({ downloadProgress: 0.1 });
    emit({ downloadProgress: 0.2 });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(getLaunchUpdateGateFlags()).toBe(flagsBefore);
  });

  it('reports no progress while there is no download to measure', async () => {
    updates.latestContext = CHECKING;
    await startGate();
    await advance(2_000);

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: false, showPlaceholder: true, placeholderPainted: false });
    expect(getLaunchUpdateProgress()).toBeUndefined();
  });

  it('releases at 4 s when the manifest request has not answered', async () => {
    updates.latestContext = CHECKING;
    await startGate();

    await advance(3_999);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    await advance(1);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'timed_out', phase_at_release: 'check', cap_ms: 15_000 }),
    ]);
  });

  it('releases at the first-launch cap once downloading, and never reloads afterwards', async () => {
    await startGate();

    await advance(14_999);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    await advance(1);

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
    expect(getLaunchUpdateProgress()).toBeUndefined();
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'timed_out', phase_at_release: 'download', cap_ms: 15_000 }),
    ]);

    // The download finishes in the background. It applies on the next launch.
    emit({ ...PENDING });
    await advance(60_000);

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toHaveLength(1);
  });

  it('stops listening to expo-updates and drops its timers once it has resolved', async () => {
    await startGate();
    expect(updates.listeners.size).toBe(1);

    await advance(15_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives an ordinary cold start 5 s and writes no first-launch marker', async () => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    await startGate();
    expect(getLaunchUpdateFirstLaunch()).toBe(false);

    await advance(4_999);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    await advance(1);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({
      outcome: 'timed_out',
      trigger: 'cold_start',
      cap_ms: 5_000,
      ota_is_embedded: false,
    });
    expect(preferences.setPreference).not.toHaveBeenCalled();
  });

  it('names a first launch on a new runtime a binary update', async () => {
    preferences.stored.set(MARKER_KEY, 'fingerprint-old');
    updates.latestContext = IDLE;
    await startGate();

    expect(launchUpdateEvents()[0]).toMatchObject({
      outcome: 'nothing_newer',
      phase_at_release: 'none',
      trigger: 'binary_update',
      cap_ms: 5_000,
    });
    expect(preferences.stored.get(MARKER_KEY)).toBe('fingerprint-new');
  });

  it('gives a store update the short wait and still moves the marker on', async () => {
    preferences.stored.set(MARKER_KEY, 'fingerprint-old');
    await startGate();
    expect(getLaunchUpdateFirstLaunch()).toBe(false);

    await advance(4_999);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    await advance(1);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'timed_out', trigger: 'binary_update', cap_ms: 5_000 });
    expect(preferences.stored.get(MARKER_KEY)).toBe('fingerprint-new');
  });

  it.each([
    ['the device is offline', () => (connectivity.snapshot.device = 'offline')],
    ['the network has no route out', () => (connectivity.snapshot.deviceReachability = 'unreachable')],
    ['the climber switched Offline mode on', () => (connectivity.snapshot.offlineMode = true)],
  ])('releases at once and leaves the marker unwritten when %s', async (_label, arrange) => {
    arrange();
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()).toEqual([expect.objectContaining({ outcome: 'offline', phase_at_release: 'none' })]);
    expect(preferences.setPreference).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('releases as failed on a launch-time download error', async () => {
    await startGate();

    emit({ ...IDLE, downloadError: { message: 'asset download failed' } });
    await advance(0);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'failed' });
  });

  it('does not reload when the pending update is the one already running', async () => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = { ...PENDING, downloadedManifest: { id: 'running-update' } };
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'nothing_newer' });
  });
});

describe('a wall clock that moves during the wait', () => {
  it('still releases at the check cap when Date.now() steps backwards', async () => {
    updates.latestContext = CHECKING;
    await startGate();

    await advance(2_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await advance(2_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'timed_out', phase_at_release: 'check' }),
    ]);
  });

  it('still releases at the full cap when Date.now() steps backwards mid-download', async () => {
    await startGate();

    await advance(8_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await advance(7_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    const [event] = launchUpdateEvents();
    expect(event).toMatchObject({ outcome: 'timed_out', phase_at_release: 'download' });
    // Measured on a monotonic clock, so the step does not show up in it.
    expect(event.duration_ms).toBe(15_000);
  });

  it('does not release early when Date.now() jumps forwards', async () => {
    await startGate();

    vi.setSystemTime(Date.now() + 3_600_000);
    emit({ downloadProgress: 0.3 });
    await advance(1_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    expect(launchUpdateEvents()).toHaveLength(0);
  });
});

describe('state changes the listener never hears', () => {
  it('reads the startup state at gate start, not from a later subscription', async () => {
    // Everything finished before the gate began: there will be no event at all.
    updates.latestContext = IDLE;
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'nothing_newer' });
  });

  it('picks up a change that landed with no event the next time anything wakes it', async () => {
    updates.latestContext = CHECKING;
    await startGate({ authReady: false });

    // checkCompleteUnavailable + endStartup, with no listener called.
    silentlyAdvance({ ...IDLE });
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);

    notifyLaunchUpdateAuthReady();
    await advance(0);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'nothing_newer' });
  });

  it('picks up a silent change on a cap tick even when nothing else happens', async () => {
    updates.latestContext = CHECKING;
    await startGate();

    silentlyAdvance({ ...PENDING });
    await advance(4_000);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'updated' });
  });

  it('ignores an event older than the context it already holds', async () => {
    updates.latestContext = { ...PENDING, sequenceNumber: 9 };
    await startGate({ authReady: false });

    // A stale, out-of-order event claiming the download is still running.
    for (const listener of updates.listeners) listener({ context: { ...DOWNLOADING, sequenceNumber: 3 } });
    notifyLaunchUpdateAuthReady();
    await advance(0);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
  });
});

// #6689. The schema migrations run as write transactions, and on Android a
// reload does not close the old runtime's connections: a reload landing inside
// one would leave the write lock held until the process dies, and the next
// runtime could never migrate. The gate holds its reload while a setup attempt
// runs, and nothing that writes may start while a reload is still possible.
describe('waiting for the database', () => {
  it('does not reload while a database setup attempt is running, then reloads once it ends', async () => {
    updates.latestContext = PENDING;
    const endAttempt = beginDatabaseInitAttempt();
    await startGate();
    await advance(3_000);

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toHaveLength(0);

    endAttempt();
    await advance(0);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'updated' });
  });

  it('releases without reloading when the setup attempt outlasts the cap', async () => {
    updates.latestContext = PENDING;
    const endAttempt = beginDatabaseInitAttempt();
    await startGate();

    await advance(15_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'timed_out', phase_at_release: 'download' }),
    ]);

    endAttempt();
    await advance(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('keeps the reload window open while the gate can reload, and closes it when the gate resolves', async () => {
    updates.latestContext = DOWNLOADING;
    await startGate();
    expect(isLaunchReloadPossible()).toBe(true);

    emit({ ...IDLE });
    await advance(0);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(isLaunchReloadPossible()).toBe(false);
  });

  it('keeps the window open through a reload it has asked for', async () => {
    updates.latestContext = PENDING;
    await startGate();

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(isLaunchReloadPossible()).toBe(true);
  });

  // REVIEW-A (#6710 review). The superseded restart: the init chain ends one
  // attempt and begins the next in the same tick. The end wakes the gate, which
  // decides to reload; a reload must not then land inside the next attempt.
  it('does not reload into a setup attempt that began in the same tick the last one ended', async () => {
    updates.latestContext = PENDING;
    const endFirst = beginDatabaseInitAttempt();
    await startGate();

    endFirst();
    const endSecond = beginDatabaseInitAttempt();
    await advance(2_000);

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(errors.reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'A database setup attempt was running at restart.' }),
      { tags: { source: 'ota', op: 'launch-update-reload' } },
    );
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(isLaunchReloadRequested()).toBe(false);
    endSecond();
  });

  // REVIEW-B (#6710 review). A retry that starts while the reload is flushing its
  // event: the decision saw nothing running, but the reload itself must not.
  it('does not reload into a setup attempt that began while the reload was flushing', async () => {
    analytics.flush.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 650);
        }),
    );
    updates.latestContext = PENDING;
    await startGate();
    expect(isLaunchReloadRequested()).toBe(true);

    await advance(500);
    const endRetry = beginDatabaseInitAttempt();
    await advance(1_000);

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    endRetry();
  });

  it('asks for the reload the moment it decides, before the flush', async () => {
    analytics.flush.mockReset().mockReturnValue(new Promise<void>(() => {}));
    updates.latestContext = PENDING;
    await startGate();

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(isLaunchReloadRequested()).toBe(true);
  });

  it('withdraws the request at once when the reload is rejected', async () => {
    updates.reloadAsync.mockReset().mockRejectedValue(new Error('no reference to the JS runtime'));
    updates.latestContext = PENDING;
    await startGate();
    await advance(0);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(isLaunchReloadRequested()).toBe(false);
    expect(isLaunchReloadPossible()).toBe(false);
  });

  // The grace path opens the app with the reload still outstanding. On Android a
  // queued relaunch can land after it, so writers wait a further bounded margin.
  it('keeps writers waiting for 10 s after a reload outlives the grace, and says so next launch', async () => {
    updates.latestContext = PENDING;
    await startGate();

    await advance(5_000);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(isLaunchReloadRequested()).toBe(true);
    expect(isLaunchReloadPossible()).toBe(true);
    expect(preferences.stored.get(OUTLIVED_GRACE_KEY)).toBe(true);

    await advance(9_999);
    expect(isLaunchReloadRequested()).toBe(true);
    await advance(1);
    expect(isLaunchReloadRequested()).toBe(false);
    expect(isLaunchReloadPossible()).toBe(false);

    // The next cold start reports it once, then forgets it.
    resetLaunchUpdateGateForTests();
    updates.latestContext = { ...IDLE, restartCount: 0 };
    preferences.stored.set(MARKER_KEY, 'fingerprint-new');
    analytics.track.mockClear();
    await startGate();
    await advance(0);
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'nothing_newer', previous_reload_outlived_grace: true }),
    ]);
    expect(preferences.stored.has(OUTLIVED_GRACE_KEY)).toBe(false);
  });

  it('reports a launch after an ordinary one as not having outlived a grace', async () => {
    updates.latestContext = IDLE;
    await startGate();
    await advance(0);

    expect(launchUpdateEvents()).toEqual([expect.objectContaining({ previous_reload_outlived_grace: false })]);
  });

  it('never opens the window for a launch it does not cover, and records the restart count', () => {
    updates.latestContext = { ...PENDING, restartCount: 1 };
    startLaunchUpdateGate(PRODUCTION);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(isLaunchReloadPossible()).toBe(false);
    expect(getJsRestartCount()).toBe(1);
  });
});

describe('waiting for auth', () => {
  it('does not reload while the launch-time token refresh could be in flight', async () => {
    updates.latestContext = PENDING;
    await startGate({ authReady: false });
    await advance(3_000);

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toHaveLength(0);

    notifyLaunchUpdateAuthReady();
    await advance(0);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'updated' });
  });

  it('releases without reloading when auth has not resolved by the cap', async () => {
    updates.latestContext = PENDING;
    await startGate({ authReady: false });

    await advance(15_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'timed_out', phase_at_release: 'download' }),
    ]);

    notifyLaunchUpdateAuthReady();
    await advance(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('keeps the placeholder up after the gate resolves until auth is ready', async () => {
    updates.latestContext = CHECKING;
    await startGate({ authReady: false });
    await advance(4_000);

    // Released, but the pre-auth tree must not show through.
    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: true, placeholderPainted: false });

    notifyLaunchUpdateAuthReady();
    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
  });

  it('never shows the placeholder when the gate resolved inside the splash window', async () => {
    updates.latestContext = IDLE;
    await startGate({ authReady: false });
    await advance(10_000);

    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: true, showPlaceholder: false, placeholderPainted: false });
  });
});

describe('an update that would not start', () => {
  beforeEach(() => {
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = PENDING;
  });

  it('does not reload a second time for the update the last reload was for', async () => {
    preferences.stored.set(RELOAD_TARGET_KEY, 'next-update');
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'skipped_failed_update', phase_at_release: 'download' }),
    ]);
    // Still remembered, so the next cold start skips it too.
    expect(preferences.stored.get(RELOAD_TARGET_KEY)).toBe('next-update');
  });

  it('reloads for a newer update and overwrites the remembered target', async () => {
    preferences.stored.set(RELOAD_TARGET_KEY, 'older-failed-update');
    await startGate();

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(preferences.stored.get(RELOAD_TARGET_KEY)).toBe('next-update');
  });

  it('forgets the target once it is the update running', async () => {
    preferences.stored.set(RELOAD_TARGET_KEY, 'running-update');
    updates.latestContext = IDLE;
    await startGate();

    expect(preferences.stored.has(RELOAD_TARGET_KEY)).toBe(false);
  });
});

describe('paths that must not hang', () => {
  it('releases at 1,500 ms as failed when the marker read never settles', async () => {
    preferences.getPreference.mockImplementation((key: string) =>
      key === MARKER_KEY ? new Promise<never>(() => {}) : Promise.resolve(null),
    );
    // A download is pending the whole time: without the marker it must not be used.
    updates.latestContext = PENDING;
    await startGate();

    await advance(1_499);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    expect(launchUpdateEvents()).toHaveLength(0);

    await advance(1);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        phase_at_release: 'none',
        trigger: 'cold_start',
        cap_ms: 5_000,
        duration_ms: 1_500,
      }),
    ]);
    expect(errors.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'ota', op: 'launch-update-read-marker' },
    });
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(preferences.setPreference).not.toHaveBeenCalled();
  });

  it('carries on at 1,500 ms without the explicit check when the cleanup hand-off never settles', async () => {
    cleanup.runChannelOverrideCleanupOnce.mockReturnValue(new Promise<never>(() => {}));
    // Nothing to wait for once the reads are done, so the gate's own verdict
    // lands the moment the hand-off's budget runs out.
    updates.latestContext = IDLE;
    await startGate();

    await advance(1_499);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    expect(launchUpdateEvents()).toHaveLength(0);

    await advance(1);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({
        outcome: 'nothing_newer',
        phase_at_release: 'none',
        trigger: 'fresh_install',
        cap_ms: 15_000,
        duration_ms: 1_500,
      }),
    ]);
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(errors.reportHandledError).not.toHaveBeenCalled();
  });

  it('releases, reports and tracks failed when the marker cannot be read', async () => {
    const failure = new Error('backing file unreadable');
    preferences.getPreference.mockRejectedValue(failure);
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(errors.reportHandledError).toHaveBeenCalledWith(failure, {
      tags: { source: 'ota', op: 'launch-update-read-marker' },
    });
    expect(launchUpdateEvents()).toEqual([
      expect.objectContaining({ outcome: 'failed', phase_at_release: 'none', trigger: 'cold_start', cap_ms: 5_000 }),
    ]);

    emit({ ...PENDING });
    await advance(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('carries on as online when the offline probe throws', async () => {
    connectivity.throwOnRead = true;
    updates.latestContext = IDLE;
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'nothing_newer' });
  });

  it('opens the app when the reporter throws, and still reloads', async () => {
    const failure = new Error('analytics client exploded');
    analytics.track.mockImplementation(() => {
      throw failure;
    });
    updates.latestContext = PENDING;
    await startGate();
    await advance(0);

    expect(errors.reportHandledError).toHaveBeenCalledWith(failure, {
      tags: { source: 'ota', op: 'launch-update-report' },
    });
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
  });

  it('opens the app when the reporter throws on a release', async () => {
    analytics.track.mockImplementation(() => {
      throw new Error('analytics client exploded');
    });
    updates.latestContext = IDLE;
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
  });

  it('opens the app when the error reporter itself throws, on every fail-open path', async () => {
    errors.reportHandledError.mockImplementation(() => {
      throw new Error('error reporter exploded');
    });

    // The marker read fails: reported, then released.
    preferences.getPreference.mockRejectedValue(new Error('backing file unreadable'));
    await startGate();
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);

    // The reload rejects: reported from inside the settle, then released.
    resetLaunchUpdateGateForTests();
    preferences.getPreference.mockImplementation(async () => null);
    updates.reloadAsync.mockReset().mockRejectedValue(new Error('no reference to the JS runtime'));
    updates.latestContext = PENDING;
    await startGate();
    await advance(0);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);

    // The decision itself throws: the fail-open handler has to survive its own report.
    resetLaunchUpdateGateForTests();
    updates.latestContext = DOWNLOADING;
    await startGate();
    Object.defineProperty(updates, 'latestContext', {
      configurable: true,
      get() {
        throw new Error('native context unreadable');
      },
    });
    for (const listener of updates.listeners) listener({ context: { ...PENDING, sequenceNumber: 99 } });
    Object.defineProperty(updates, 'latestContext', { configurable: true, writable: true, value: PENDING });
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
  });

  it('does not throw into the first render when starting the gate throws', () => {
    platform.os = 'ios';
    Object.defineProperty(updates, 'latestContext', {
      configurable: true,
      get() {
        throw new Error('native module missing');
      },
    });

    expect(() => startLaunchUpdateGate(PRODUCTION)).not.toThrow();

    Object.defineProperty(updates, 'latestContext', { configurable: true, writable: true, value: DOWNLOADING });
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(errors.reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'ota', op: 'launch-update-start' },
    });
  });

  it('releases when the reload rejects, and reports it', async () => {
    const failure = new Error('no reference to the JS runtime');
    updates.reloadAsync.mockReset().mockRejectedValue(failure);
    updates.latestContext = PENDING;
    await startGate();
    await advance(0);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(errors.reportHandledError).toHaveBeenCalledWith(failure, {
      tags: { source: 'ota', op: 'launch-update-reload' },
    });
    expect(launchUpdateEvents()).toHaveLength(1);
  });

  it('opens the app 5 s after a reload that never settles', async () => {
    updates.reloadAsync.mockReset().mockReturnValue(new Promise<void>(() => {}));
    updates.latestContext = PENDING;
    await startGate();
    await advance(0);
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);

    await advance(4_999);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    await advance(1);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
  });

  it('opens the app 5 s after a reload that resolved but left this runtime alive', async () => {
    updates.latestContext = PENDING;
    await startGate();

    await advance(5_000);

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
  });

  it('waits out a slow flush for 700 ms, then reloads', async () => {
    analytics.flush.mockReset().mockReturnValue(new Promise<void>(() => {}));
    updates.latestContext = PENDING;
    await startGate();

    await advance(699);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    await advance(1);
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
  });
});

describe('one gate per JS runtime', () => {
  it('does not start a second run, fire a second event, or reload after a release', async () => {
    updates.latestContext = CHECKING;
    await startGate();
    await advance(4_000);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    const flagsAfterFirstRun = getLaunchUpdateGateFlags();

    // The root layout remounts in the same runtime, with an update now pending.
    updates.latestContext = { ...PENDING, sequenceNumber: 50 };
    startLaunchUpdateGate(PRODUCTION);
    await advance(20_000);

    expect(getLaunchUpdateGateFlags()).toBe(flagsAfterFirstRun);
    expect(launchUpdateEvents()).toHaveLength(1);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(updates.listeners.size).toBe(0);
  });

  it('joins a run still in flight instead of starting another', async () => {
    await startGate();
    const readsAfterFirstStart = preferences.getPreference.mock.calls.length;

    startLaunchUpdateGate(PRODUCTION);
    await advance(0);

    expect(preferences.getPreference.mock.calls.length).toBe(readsAfterFirstStart);
    expect(updates.listeners.size).toBe(1);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
  });
});

describe('a run reset while its reads are in flight', () => {
  it('cannot move the next run', async () => {
    let finishMarkerRead: (value: string | null) => void = () => {};
    preferences.getPreference.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          finishMarkerRead = resolve;
        }),
    );
    updates.latestContext = IDLE;
    startLaunchUpdateGate(PRODUCTION);

    resetLaunchUpdateGateForTests();
    finishMarkerRead(null);
    await advance(0);

    // The abandoned run would have released as nothing_newer. It did nothing.
    expect(getLaunchUpdateGateFlags()).toEqual({ resolved: false, showPlaceholder: false, placeholderPainted: false });
    expect(launchUpdateEvents()).toHaveLength(0);
  });
});

describe('a launch whose manifest request used a retired override', () => {
  beforeEach(() => {
    cleanup.runChannelOverrideCleanupOnce.mockResolvedValue({ staleOverrideActive: true });
  });

  it('waits for the startup procedure, checks again, fetches and reloads', async () => {
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, isRollBackToEmbedded: false });
    updates.latestContext = CHECKING;
    await startGate();
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();

    emit({ ...IDLE, checkError: { message: 'retired channel' } });
    await advance(0);

    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    // This is a fresh install on a Branch Surfing build: the first-launch
    // profile and the retired-override check apply together.
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'updated', trigger: 'fresh_install', cap_ms: 15_000 });
    expect(preferences.stored.get(MARKER_KEY)).toBe('fingerprint-new');
    // The state machine never reported a downloaded id here, so the remembered
    // reload target comes from the fetch result.
    expect(preferences.stored.get(RELOAD_TARGET_KEY)).toBe('fetched-update');
  });

  it('releases as nothing_newer when the clean channel has nothing, ignoring the retired channel error', async () => {
    updates.latestContext = { ...IDLE, checkError: { message: 'retired channel' } };
    await startGate();

    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'nothing_newer' });
  });

  it('does not reload when the explicit check lands after the cap', async () => {
    let finishCheck: (value: { isAvailable: boolean; isRollBackToEmbedded: boolean }) => void = () => {};
    updates.checkForUpdateAsync.mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    );
    updates.latestContext = IDLE;
    await startGate();

    await advance(4_000);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'timed_out', phase_at_release: 'check' });

    finishCheck({ isAvailable: true, isRollBackToEmbedded: false });
    await advance(0);

    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(launchUpdateEvents()).toHaveLength(1);
  });

  it('releases as failed and reports when the explicit check throws', async () => {
    const failure = new Error('manifest request failed');
    updates.checkForUpdateAsync.mockRejectedValue(failure);
    updates.latestContext = IDLE;
    await startGate();

    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(errors.reportHandledError).toHaveBeenCalledWith(failure, {
      tags: { source: 'ota', op: 'launch-update-explicit-check' },
    });
    expect(launchUpdateEvents()[0]).toMatchObject({ outcome: 'failed' });
  });
});

describe('owned launch reloads', () => {
  it('still reloads when a reload decided inside the cap finishes its analytics flush after it', async () => {
    let finishFlush: () => void = () => {};
    analytics.flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      }),
    );
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = DOWNLOADING;
    await startGate();
    await advance(4_600);
    emit({ ...PENDING });
    await advance(600);
    finishFlush();
    await advance(0);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(launchUpdateEvents()).toEqual([expect.objectContaining({ outcome: 'updated', cap_ms: 5_000 })]);
  });

  it('still reloads when the reload is decided on the cap tick and the flush times out', async () => {
    analytics.flush.mockReturnValue(new Promise<void>(() => {}));
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = DOWNLOADING;
    await startGate();
    await advance(4_999);
    // The download finished with no event; the cap tick is what sees it.
    silentlyAdvance({ ...PENDING });
    await advance(1);
    expect(launchUpdateEvents()).toEqual([expect.objectContaining({ outcome: 'updated' })]);

    await advance(700);

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
  });

  it('does not invoke reload once the window after the cap has closed', async () => {
    let finishNative: () => void = () => {};
    const earlier = runOtaOperation((lease) =>
      lease.native(
        () =>
          new Promise<void>((resolve) => {
            finishNative = resolve;
          }),
      ),
    );
    updates.isEmbeddedLaunch = false;
    updates.updateId = 'running-update';
    updates.latestContext = DOWNLOADING;
    await startGate();
    await advance(4_600);
    emit({ ...PENDING });
    // The reload waits behind another native call past the cap + 950 ms window.
    await advance(1_400);
    finishNative();
    await earlier;
    await advance(0);

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
  });

  it('does not reload a replacement pending UUID after waiting for analytics', async () => {
    let finishFlush: () => void = () => {};
    analytics.flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      }),
    );
    updates.latestContext = PENDING;
    await startGate();
    emit({ downloadedManifest: { id: 'replacement-update' } });
    finishFlush();
    await advance(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
  });

  it('expires a queued reload without invoking it after the active native call drains', async () => {
    let finishNative: () => void = () => {};
    const earlier = runOtaOperation((lease) =>
      lease.native(
        () =>
          new Promise<void>((resolve) => {
            finishNative = resolve;
          }),
      ),
    );
    updates.latestContext = PENDING;
    await startGate();
    await advance(5_000);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    finishNative();
    await earlier;
    await advance(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('starts the full reload grace when native reload starts after queue waiting', async () => {
    let finishNative: () => void = () => {};
    const earlier = runOtaOperation((lease) =>
      lease.native(
        () =>
          new Promise<void>((resolve) => {
            finishNative = resolve;
          }),
      ),
    );
    updates.reloadAsync.mockReturnValue(new Promise<void>(() => {}));
    updates.latestContext = PENDING;
    await startGate();
    await advance(4_900);
    finishNative();
    await earlier;
    await advance(0);
    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    await advance(4_999);
    expect(getLaunchUpdateGateFlags().resolved).toBe(false);
    await advance(1);
    expect(getLaunchUpdateGateFlags().resolved).toBe(true);
  });
});
