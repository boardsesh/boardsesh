import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLD_START_UPDATE_CAP_MS,
  FIRST_LAUNCH_UPDATE_CAP_MS,
  LAUNCH_UPDATE_CHECK_CAP_MS,
  LAUNCH_UPDATE_FLUSH_TIMEOUT_MS,
  LAUNCH_UPDATE_MARKER_WRITE_TIMEOUT_MS,
  LAUNCH_UPDATE_PLACEHOLDER_DELAY_MS,
  LAUNCH_UPDATE_PREPARATION_TIMEOUT_MS,
  LAUNCH_UPDATE_RELOAD_GRACE_MS,
  OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY,
  OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY,
  decideLaunchUpdateStep,
  isKnownFailedUpdate,
  isLaunchUpdateGateEligible,
  isPendingUpdateNew,
  resolveReloadTargetId,
  launchUpdateCapMs,
  launchUpdateStateFromContext,
  prepareLaunchUpdateGate,
  resolveLaunchUpdateProfile,
  resolveLaunchUpdateTrigger,
  runExplicitUpdateCheck,
  settleLaunchUpdate,
  shouldMarkFirstLaunchHandled,
  type LaunchUpdateDecisionInput,
  type LaunchUpdateOutcome,
  type LaunchUpdatePreparationDeps,
  type LaunchUpdateProfileInput,
  type LaunchUpdateSettleDeps,
  type LaunchUpdateState,
} from '../launch-update-gate';

const RUNTIME = 'fingerprint-new';
const RUNNING_UPDATE_ID = 'running-update';

const ELIGIBLE = {
  isWeb: false,
  development: false,
  updatesEnabled: true,
  isEmergencyLaunch: false,
  launchedInBackground: false,
  restartCount: 0,
};

function profileInput(overrides: Partial<LaunchUpdateProfileInput> = {}): LaunchUpdateProfileInput {
  return { isEmbeddedLaunch: true, runtimeVersion: RUNTIME, handledRuntimeVersion: null, ...overrides };
}

// The launch-time startup procedure mid-flight: checking done, download running.
const DOWNLOADING: LaunchUpdateState = {
  isStartupProcedureRunning: true,
  isChecking: false,
  isDownloading: true,
  isUpdateAvailable: true,
  isUpdatePending: false,
  hasCheckError: false,
  hasDownloadError: false,
  pendingIsRollback: false,
  pendingUpdateId: undefined,
};

// The manifest request has gone out and has not answered yet.
const CHECKING: LaunchUpdateState = {
  ...DOWNLOADING,
  isDownloading: false,
  isChecking: true,
  isUpdateAvailable: false,
};
const IDLE: LaunchUpdateState = {
  ...DOWNLOADING,
  isStartupProcedureRunning: false,
  isDownloading: false,
  isUpdateAvailable: false,
};
const PENDING: LaunchUpdateState = {
  ...IDLE,
  isUpdateAvailable: true,
  isUpdatePending: true,
  pendingUpdateId: 'next-update',
};
const RELOAD = { step: 'reload', outcome: 'updated', phase: 'download', targetUpdateId: 'next-update' };

function decide(overrides: Partial<LaunchUpdateDecisionInput> = {}) {
  return decideLaunchUpdateStep({
    updates: DOWNLOADING,
    checkCapExpired: false,
    capExpired: false,
    deviceOffline: false,
    runningUpdateId: RUNNING_UPDATE_ID,
    isEmbeddedLaunch: true,
    explicitCheck: 'not_needed',
    reloadAllowed: true,
    lastReloadTargetId: null,
    explicitFetchedUpdateId: null,
    ...overrides,
  });
}

describe('constants', () => {
  it('pins the caps, the splash window and the marker key', () => {
    expect(FIRST_LAUNCH_UPDATE_CAP_MS).toBe(15_000);
    expect(COLD_START_UPDATE_CAP_MS).toBe(10_000);
    expect(LAUNCH_UPDATE_CHECK_CAP_MS).toBe(4_000);
    expect(LAUNCH_UPDATE_PLACEHOLDER_DELAY_MS).toBe(2_000);
    expect(LAUNCH_UPDATE_PREPARATION_TIMEOUT_MS).toBe(1_500);
    expect(LAUNCH_UPDATE_MARKER_WRITE_TIMEOUT_MS).toBe(700);
    expect(LAUNCH_UPDATE_FLUSH_TIMEOUT_MS).toBe(700);
    expect(LAUNCH_UPDATE_RELOAD_GRACE_MS).toBe(5_000);
    expect(OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY).toBe('ota_first_launch_update_runtime_v1');
    expect(OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY).toBe('ota_launch_update_last_reload_target_v1');
  });
});

describe('resolveLaunchUpdateProfile', () => {
  it('gates the first launch of a binary: embedded and not yet handled', () => {
    expect(resolveLaunchUpdateProfile(profileInput())).toBe('first_launch');
  });

  it('gates an embedded launch again after a store update moved the runtime version', () => {
    expect(resolveLaunchUpdateProfile(profileInput({ handledRuntimeVersion: 'fingerprint-old' }))).toBe('first_launch');
  });

  it('treats an embedded launch whose runtime is already handled as an ordinary cold start', () => {
    expect(resolveLaunchUpdateProfile(profileInput({ handledRuntimeVersion: RUNTIME }))).toBe('cold_start');
  });

  it('treats a launch on a downloaded update as an ordinary cold start', () => {
    expect(resolveLaunchUpdateProfile(profileInput({ isEmbeddedLaunch: false }))).toBe('cold_start');
  });

  it('falls back to cold_start when there is no runtime version to key the marker on', () => {
    expect(resolveLaunchUpdateProfile(profileInput({ runtimeVersion: null }))).toBe('cold_start');
  });
});

describe('isLaunchUpdateGateEligible', () => {
  it.each([
    ['the browser target', { isWeb: true }],
    ['a dev build', { development: true }],
    ['updates disabled', { updatesEnabled: false }],
    ['an emergency launch', { isEmergencyLaunch: true }],
    ['a background launch', { launchedInBackground: true }],
    ['the runtime a reload produced', { restartCount: 1 }],
  ])('does not gate %s', (_label, overrides) => {
    expect(isLaunchUpdateGateEligible({ ...ELIGIBLE, ...overrides })).toBe(false);
  });

  it('gates a production cold start in the foreground', () => {
    expect(isLaunchUpdateGateEligible(ELIGIBLE)).toBe(true);
  });
});

describe('trigger and cap per profile', () => {
  it('names a first launch with no marker at all a fresh install', () => {
    expect(resolveLaunchUpdateTrigger('first_launch', null)).toBe('fresh_install');
  });

  it('names a first launch with another runtime marked a binary update', () => {
    expect(resolveLaunchUpdateTrigger('first_launch', 'fingerprint-old')).toBe('binary_update');
  });

  it('names every other gated launch a cold start', () => {
    expect(resolveLaunchUpdateTrigger('cold_start', RUNTIME)).toBe('cold_start');
    expect(resolveLaunchUpdateTrigger('cold_start', null)).toBe('cold_start');
  });

  it('gives a first launch 15 s and a cold start 10 s', () => {
    expect(launchUpdateCapMs('first_launch')).toBe(15_000);
    expect(launchUpdateCapMs('cold_start')).toBe(10_000);
  });
});

describe('shouldMarkFirstLaunchHandled', () => {
  it.each<LaunchUpdateOutcome>(['updated', 'timed_out', 'failed', 'nothing_newer', 'skipped_failed_update'])(
    'marks a first launch that ended %s',
    (outcome) => {
      expect(shouldMarkFirstLaunchHandled('first_launch', outcome)).toBe(true);
    },
  );

  it('leaves an offline first launch unmarked so the next launch tries again', () => {
    expect(shouldMarkFirstLaunchHandled('first_launch', 'offline')).toBe(false);
  });

  it.each<LaunchUpdateOutcome>(['updated', 'timed_out', 'failed', 'offline', 'nothing_newer'])(
    'never marks a cold start (%s)',
    (outcome) => {
      expect(shouldMarkFirstLaunchHandled('cold_start', outcome)).toBe(false);
    },
  );
});

describe('launchUpdateStateFromContext', () => {
  const context = {
    isStartupProcedureRunning: true,
    isChecking: false,
    isDownloading: true,
    isUpdateAvailable: true,
    isUpdatePending: false,
  };

  it('maps the native context the way useUpdates() does', () => {
    expect(launchUpdateStateFromContext(context)).toEqual(DOWNLOADING);
    expect(
      launchUpdateStateFromContext({ ...context, isUpdatePending: true, downloadedManifest: { id: 'next-update' } }),
    ).toMatchObject({ isUpdatePending: true, pendingUpdateId: 'next-update', pendingIsRollback: false });
  });

  it('treats a downloaded manifest without an id as no known update', () => {
    for (const downloadedManifest of [{}, { id: '' }]) {
      expect(launchUpdateStateFromContext({ ...context, isUpdatePending: true, downloadedManifest })).toMatchObject({
        pendingUpdateId: undefined,
        pendingIsRollback: false,
      });
    }
  });

  it('reads a rollback directive only when no manifest was downloaded', () => {
    const rollback = { commitTime: '2026-10-01T00:00:00.000Z' };
    expect(launchUpdateStateFromContext({ ...context, rollback })).toMatchObject({
      pendingIsRollback: true,
      pendingUpdateId: undefined,
    });
    expect(
      launchUpdateStateFromContext({ ...context, rollback, downloadedManifest: { id: 'next-update' } }),
    ).toMatchObject({ pendingIsRollback: false, pendingUpdateId: 'next-update' });
  });

  it('flags errors', () => {
    expect(launchUpdateStateFromContext({ ...context, checkError: { message: 'no route' } }).hasCheckError).toBe(true);
    expect(launchUpdateStateFromContext({ ...context, downloadError: new Error('disk') }).hasDownloadError).toBe(true);
  });
});

describe('decideLaunchUpdateStep', () => {
  it('waits while the launch-time download is still running', () => {
    expect(decide()).toEqual({ step: 'wait' });
  });

  it('waits while the launch-time check is still running', () => {
    expect(decide({ updates: CHECKING })).toEqual({ step: 'wait' });
  });

  it('releases an offline device at once, whatever else is true', () => {
    expect(decide({ deviceOffline: true })).toEqual({ step: 'release', outcome: 'offline', phase: 'none' });
    expect(decide({ deviceOffline: true, updates: PENDING })).toEqual({
      step: 'release',
      outcome: 'offline',
      phase: 'none',
    });
  });

  it('reloads onto a downloaded update, naming the target', () => {
    expect(decide({ updates: PENDING })).toEqual(RELOAD);
  });

  it('reloads onto an update that became pending in the same tick the cap was reached', () => {
    expect(decide({ updates: PENDING, checkCapExpired: true, capExpired: true })).toEqual(RELOAD);
  });

  it('releases as failed on a check error', () => {
    expect(decide({ updates: { ...IDLE, hasCheckError: true } })).toEqual({
      step: 'release',
      outcome: 'failed',
      phase: 'none',
    });
  });

  it('releases as failed on a download error', () => {
    expect(decide({ updates: { ...IDLE, hasDownloadError: true } })).toMatchObject({
      step: 'release',
      outcome: 'failed',
    });
  });

  it('releases as nothing_newer once the startup procedure finished with nothing pending', () => {
    expect(decide({ updates: IDLE })).toEqual({ step: 'release', outcome: 'nothing_newer', phase: 'none' });
  });
});

describe('the check cap and the download cap', () => {
  const CHECK_CAP = { checkCapExpired: true };
  const FULL_CAP = { checkCapExpired: true, capExpired: true };

  it('ends the wait for the manifest when the check cap fires', () => {
    expect(decide({ updates: CHECKING })).toEqual({ step: 'wait' });
    expect(decide({ updates: CHECKING, ...CHECK_CAP })).toEqual({
      step: 'release',
      outcome: 'timed_out',
      phase: 'check',
    });
  });

  it('counts a startup procedure that has not started its check yet as the check phase', () => {
    const notYetChecking = { ...CHECKING, isChecking: false };
    expect(decide({ updates: notYetChecking, ...CHECK_CAP })).toMatchObject({ outcome: 'timed_out', phase: 'check' });
  });

  it('lets a download run past the check cap and ends it at the full cap', () => {
    expect(decide(CHECK_CAP)).toEqual({ step: 'wait' });
    expect(decide(FULL_CAP)).toEqual({ step: 'release', outcome: 'timed_out', phase: 'download' });
  });

  it('does not time out in the gap between the manifest answering and the download starting', () => {
    const manifestAnswered = { ...DOWNLOADING, isDownloading: false };
    expect(decide({ updates: manifestAnswered, ...CHECK_CAP })).toEqual({ step: 'wait' });
  });

  it('takes the caps as facts and reads no clock', () => {
    // Whatever the wall clock says, a fired cap ends the wait and an unfired
    // one does not. This is what keeps a clock step from stranding the gate.
    const clock = vi.spyOn(Date, 'now');
    decide({ updates: CHECKING, ...CHECK_CAP });
    decide(FULL_CAP);
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it('pairs each profile with its cap, and both with the 4 s check cap', () => {
    expect(launchUpdateCapMs('first_launch')).toBe(FIRST_LAUNCH_UPDATE_CAP_MS);
    expect(launchUpdateCapMs('cold_start')).toBe(COLD_START_UPDATE_CAP_MS);
    expect(LAUNCH_UPDATE_CHECK_CAP_MS).toBeLessThan(COLD_START_UPDATE_CAP_MS);
  });
});

describe('waiting for auth before a reload', () => {
  it('holds a downloaded update until auth has resolved', () => {
    expect(decide({ updates: PENDING, reloadAllowed: false })).toEqual({ step: 'wait' });
    expect(decide({ updates: PENDING, reloadAllowed: true })).toEqual(RELOAD);
  });

  it('does not apply the check cap to a downloaded update that is waiting on auth', () => {
    expect(decide({ updates: PENDING, reloadAllowed: false, checkCapExpired: true })).toEqual({ step: 'wait' });
  });

  it('releases without reloading when auth has not resolved by the cap', () => {
    expect(decide({ updates: PENDING, reloadAllowed: false, checkCapExpired: true, capExpired: true })).toEqual({
      step: 'release',
      outcome: 'timed_out',
      phase: 'download',
    });
  });

  it('does not hold a release for auth', () => {
    expect(decide({ updates: IDLE, reloadAllowed: false })).toMatchObject({ outcome: 'nothing_newer' });
  });
});

describe('the reload-loop guards', () => {
  it('does not reload when the pending update is the one already running', () => {
    const pendingIsRunning = { ...PENDING, pendingUpdateId: RUNNING_UPDATE_ID };

    expect(isPendingUpdateNew(pendingIsRunning, RUNNING_UPDATE_ID, false)).toBe(false);
    expect(decide({ updates: pendingIsRunning, isEmbeddedLaunch: false })).toMatchObject({
      step: 'release',
      outcome: 'nothing_newer',
    });
  });

  it('does not reload on a rollback directive while the embedded bundle is already running', () => {
    const rollback = { ...IDLE, isUpdatePending: true, pendingIsRollback: true };

    expect(isPendingUpdateNew(rollback, RUNNING_UPDATE_ID, true)).toBe(false);
    expect(decide({ updates: rollback, isEmbeddedLaunch: true })).toMatchObject({ outcome: 'nothing_newer' });
  });

  it('reloads on a rollback directive while a downloaded update is running, with no target to remember', () => {
    const rollback = { ...IDLE, isUpdatePending: true, pendingIsRollback: true };

    expect(decide({ updates: rollback, isEmbeddedLaunch: false })).toEqual({ ...RELOAD, targetUpdateId: null });
  });

  it('does not reload on a pending flag with no downloaded update behind it', () => {
    expect(isPendingUpdateNew({ ...IDLE, isUpdatePending: true }, RUNNING_UPDATE_ID, false)).toBe(false);
  });

  it('never gates the runtime a reload produced, so one process reloads at most once', () => {
    expect(isLaunchUpdateGateEligible({ ...ELIGIBLE, restartCount: 1 })).toBe(false);
  });

  it('does not reload again for an update an earlier reload failed to start', () => {
    expect(isKnownFailedUpdate('next-update', 'next-update')).toBe(true);
    expect(decide({ updates: PENDING, lastReloadTargetId: 'next-update' })).toEqual({
      step: 'release',
      outcome: 'skipped_failed_update',
      phase: 'download',
    });
  });

  it('still reloads for a different update than the one that failed', () => {
    expect(isKnownFailedUpdate('next-update', 'older-failed-update')).toBe(false);
    expect(decide({ updates: PENDING, lastReloadTargetId: 'older-failed-update' })).toEqual(RELOAD);
  });

  it('never reads a rollback directive as a failed update', () => {
    const rollback = { pendingIsRollback: true, pendingUpdateId: undefined };
    expect(resolveReloadTargetId(rollback, 'next-update')).toBeNull();
    expect(isKnownFailedUpdate(null, 'next-update')).toBe(false);
    expect(isKnownFailedUpdate(null, null)).toBe(false);
  });
});

describe('the stale-override explicit check', () => {
  it('waits for the startup procedure before asking again', () => {
    expect(decide({ explicitCheck: 'required' })).toEqual({ step: 'wait' });
  });

  it('asks again once the startup procedure is idle', () => {
    expect(decide({ explicitCheck: 'required', updates: IDLE })).toEqual({ step: 'check' });
  });

  it('holds a launch-time pending update until the explicit check has answered', () => {
    expect(decide({ explicitCheck: 'required', updates: { ...PENDING, isStartupProcedureRunning: true } })).toEqual({
      step: 'wait',
    });
    expect(decide({ explicitCheck: 'running', updates: PENDING })).toEqual({ step: 'wait' });
  });

  it('does not read the retired channel error as a failure', () => {
    expect(decide({ explicitCheck: 'required', updates: { ...IDLE, hasCheckError: true } })).toEqual({ step: 'check' });
    expect(decide({ explicitCheck: 'nothing', updates: { ...IDLE, hasCheckError: true } })).toMatchObject({
      step: 'release',
      outcome: 'nothing_newer',
    });
  });

  it('reloads when the explicit check fetched something', () => {
    // Deliberately idle with nothing pending: the fetch promise can resolve
    // before the isUpdatePending event arrives, so there is no id to name yet.
    expect(decide({ explicitCheck: 'fetched', updates: IDLE })).toEqual({ ...RELOAD, targetUpdateId: null });
  });

  it('names the reload target from the fetch result when the state has not caught up', () => {
    expect(decide({ explicitCheck: 'fetched', updates: IDLE, explicitFetchedUpdateId: 'fetched-update' })).toEqual({
      ...RELOAD,
      targetUpdateId: 'fetched-update',
    });
  });

  it('prefers the id the state machine reports once it has one', () => {
    expect(resolveReloadTargetId(PENDING, 'fetched-update')).toBe('next-update');
  });

  it('skips an explicitly fetched update an earlier reload failed to start, before the state names it', () => {
    expect(
      decide({
        explicitCheck: 'fetched',
        updates: IDLE,
        explicitFetchedUpdateId: 'fetched-update',
        lastReloadTargetId: 'fetched-update',
      }),
    ).toMatchObject({ step: 'release', outcome: 'skipped_failed_update' });
  });

  it('uses a launch-time pending update once the clean channel has answered with nothing', () => {
    // expo-updates would launch it on the next cold start anyway, and the
    // reload is what refreshes this runtime's channel constant.
    expect(decide({ explicitCheck: 'nothing', updates: PENDING })).toEqual(RELOAD);
  });

  it('releases as failed when the explicit check threw', () => {
    expect(decide({ explicitCheck: 'failed', updates: IDLE })).toMatchObject({ step: 'release', outcome: 'failed' });
  });

  it('stays inside the check cap while nothing is downloading', () => {
    expect(decide({ checkCapExpired: true, explicitCheck: 'required', updates: IDLE })).toEqual({
      step: 'release',
      outcome: 'timed_out',
      phase: 'check',
    });
    // The retired channel's pending update does not buy the longer cap.
    expect(decide({ checkCapExpired: true, explicitCheck: 'running', updates: PENDING })).toEqual({
      step: 'release',
      outcome: 'timed_out',
      phase: 'check',
    });
  });

  it('gets the full cap while the explicit download is in flight', () => {
    const fetching = { ...IDLE, isDownloading: true };
    expect(decide({ explicitCheck: 'running', updates: fetching, checkCapExpired: true })).toEqual({ step: 'wait' });
    expect(decide({ explicitCheck: 'running', updates: fetching, checkCapExpired: true, capExpired: true })).toEqual({
      step: 'release',
      outcome: 'timed_out',
      phase: 'download',
    });
  });
});

describe('runExplicitUpdateCheck', () => {
  function checkDeps(
    check: { isAvailable: boolean; isRollBackToEmbedded: boolean },
    fetched: { isNew: boolean; isRollBackToEmbedded: boolean; manifest?: { id?: string } } = {
      isNew: true,
      isRollBackToEmbedded: false,
      manifest: { id: 'fetched-update' },
    },
  ) {
    return {
      checkForUpdate: vi.fn().mockResolvedValue(check),
      fetchUpdate: vi.fn().mockResolvedValue(fetched),
      isEmbeddedLaunch: true,
    };
  }

  it('checks, then fetches what the check found', async () => {
    const deps = checkDeps({ isAvailable: true, isRollBackToEmbedded: false });

    await expect(runExplicitUpdateCheck(deps)).resolves.toEqual({ status: 'fetched', updateId: 'fetched-update' });
    expect(deps.fetchUpdate).toHaveBeenCalledOnce();
  });

  it('does not fetch when the server has nothing newer', async () => {
    const deps = checkDeps({ isAvailable: false, isRollBackToEmbedded: false });

    await expect(runExplicitUpdateCheck(deps)).resolves.toEqual({ status: 'nothing' });
    expect(deps.fetchUpdate).not.toHaveBeenCalled();
  });

  it('treats a rollback directive as nothing while the embedded bundle is running', async () => {
    const deps = checkDeps(
      { isAvailable: false, isRollBackToEmbedded: true },
      { isNew: false, isRollBackToEmbedded: true },
    );

    await expect(runExplicitUpdateCheck(deps)).resolves.toEqual({ status: 'nothing' });
    await expect(runExplicitUpdateCheck({ ...deps, isEmbeddedLaunch: false })).resolves.toEqual({
      status: 'fetched',
      updateId: null,
    });
  });

  it('resolves failed, with the error, when the check or the fetch throws', async () => {
    const checkFailure = new Error('manifest request failed');
    const failingCheck = { ...checkDeps({ isAvailable: true, isRollBackToEmbedded: false }) };
    failingCheck.checkForUpdate.mockRejectedValueOnce(checkFailure);
    await expect(runExplicitUpdateCheck(failingCheck)).resolves.toEqual({ status: 'failed', error: checkFailure });

    const fetchFailure = new Error('asset download failed');
    const failingFetch = checkDeps({ isAvailable: true, isRollBackToEmbedded: false });
    failingFetch.fetchUpdate.mockRejectedValueOnce(fetchFailure);
    await expect(runExplicitUpdateCheck(failingFetch)).resolves.toEqual({ status: 'failed', error: fetchFailure });
  });
});

describe('prepareLaunchUpdateGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function preparationDeps(overrides: Partial<LaunchUpdatePreparationDeps> = {}): LaunchUpdatePreparationDeps {
    return {
      ...ELIGIBLE,
      isEmbeddedLaunch: true,
      runtimeVersion: RUNTIME,
      runningUpdateId: RUNNING_UPDATE_ID,
      readHandledRuntimeVersion: vi.fn().mockResolvedValue(null),
      readLastReloadTargetId: vi.fn().mockResolvedValue(null),
      clearLastReloadTarget: vi.fn().mockResolvedValue(undefined),
      refreshDeviceState: vi.fn().mockResolvedValue(undefined),
      isDeviceOffline: vi.fn().mockReturnValue(false),
      resolveStaleOverride: vi.fn().mockResolvedValue(false),
      ...overrides,
    };
  }

  it('skips without reading anything when the launch is not eligible', async () => {
    const deps = preparationDeps({ development: true });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toEqual({ kind: 'skip' });
    expect(deps.readHandledRuntimeVersion).not.toHaveBeenCalled();
    expect(deps.refreshDeviceState).not.toHaveBeenCalled();
    expect(deps.resolveStaleOverride).not.toHaveBeenCalled();
  });

  it('prepares a fresh install: first launch, 15 s, no marker', async () => {
    await expect(prepareLaunchUpdateGate(preparationDeps())).resolves.toEqual({
      kind: 'gate',
      profile: 'first_launch',
      trigger: 'fresh_install',
      capMs: 15_000,
      deviceOffline: false,
      explicitCheckRequired: false,
      lastReloadTargetId: null,
    });
  });

  it('prepares a store update: first launch again, as a binary update', async () => {
    const deps = preparationDeps({ readHandledRuntimeVersion: vi.fn().mockResolvedValue('fingerprint-old') });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({
      profile: 'first_launch',
      trigger: 'binary_update',
      capMs: 15_000,
    });
  });

  it('prepares an ordinary cold start: 10 s, cold_start trigger', async () => {
    const deps = preparationDeps({ isEmbeddedLaunch: false });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({
      profile: 'cold_start',
      trigger: 'cold_start',
      capMs: 10_000,
    });
  });

  it('reads the device AFTER refreshing it, so a boot-time unknown is not mistaken for online', async () => {
    const order: string[] = [];
    const deps = preparationDeps({
      refreshDeviceState: vi.fn(async () => {
        order.push('refresh');
      }),
      isDeviceOffline: vi.fn(() => {
        order.push('read');
        return true;
      }),
    });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ deviceOffline: true });
    expect(order).toEqual(['refresh', 'read']);
  });

  it('counts a device read that never answers as online, inside its budget', async () => {
    const deps = preparationDeps({ refreshDeviceState: vi.fn(() => new Promise<void>(() => {})) });

    const preparation = prepareLaunchUpdateGate(deps);
    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_PREPARATION_TIMEOUT_MS);

    await expect(preparation).resolves.toMatchObject({ kind: 'gate', deviceOffline: false });
    expect(deps.isDeviceOffline).not.toHaveBeenCalled();
  });

  it('counts a device probe that throws as online instead of hanging', async () => {
    const deps = preparationDeps({
      isDeviceOffline: vi.fn(() => {
        throw new Error('connectivity store not bound');
      }),
    });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ kind: 'gate', deviceOffline: false });
  });

  it('hands over the update an earlier reload was for while something else is running', async () => {
    const deps = preparationDeps({ readLastReloadTargetId: vi.fn().mockResolvedValue('failed-update') });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ lastReloadTargetId: 'failed-update' });
    expect(deps.clearLastReloadTarget).not.toHaveBeenCalled();
  });

  it('clears the reload target once it is the running update: the reload took', async () => {
    const deps = preparationDeps({ readLastReloadTargetId: vi.fn().mockResolvedValue(RUNNING_UPDATE_ID) });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ lastReloadTargetId: null });
    expect(deps.clearLastReloadTarget).toHaveBeenCalledOnce();
  });

  it('carries on without failed-update memory when that read fails', async () => {
    const deps = preparationDeps({ readLastReloadTargetId: vi.fn().mockRejectedValue(new Error('unreadable')) });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ kind: 'gate', lastReloadTargetId: null });
  });

  it('releases on a storage read failure instead of guessing a profile', async () => {
    const failure = new Error('backing file unreadable before first unlock');
    const deps = preparationDeps({ readHandledRuntimeVersion: vi.fn().mockRejectedValue(failure) });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toEqual({ kind: 'storage_failed', error: failure });
  });

  it('releases when the storage read never answers', async () => {
    const deps = preparationDeps({ readHandledRuntimeVersion: vi.fn(() => new Promise<string | null>(() => {})) });

    const preparation = prepareLaunchUpdateGate(deps);
    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_PREPARATION_TIMEOUT_MS);

    await expect(preparation).resolves.toMatchObject({ kind: 'storage_failed' });
  });

  it('asks for the explicit check when the launch request used a retired override', async () => {
    const deps = preparationDeps({ resolveStaleOverride: vi.fn().mockResolvedValue(true) });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ kind: 'gate', explicitCheckRequired: true });
  });

  it('carries on without the explicit check when the override cleanup failed', async () => {
    const deps = preparationDeps({ resolveStaleOverride: vi.fn().mockRejectedValue(new Error('native clear failed')) });

    await expect(prepareLaunchUpdateGate(deps)).resolves.toMatchObject({ kind: 'gate', explicitCheckRequired: false });
  });
});

describe('settleLaunchUpdate', () => {
  const RELOAD_DECISION = {
    step: 'reload',
    outcome: 'updated',
    phase: 'download',
    targetUpdateId: 'next-update',
  } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function settleDeps(overrides: Partial<LaunchUpdateSettleDeps> = {}) {
    const calls: string[] = [];
    const deps = {
      profile: 'first_launch' as const,
      runtimeVersion: RUNTIME,
      reportOutcome: vi.fn((outcome: LaunchUpdateOutcome, phase: string) => {
        calls.push(`report:${outcome}:${phase}`);
      }),
      flushOutcome: vi.fn(async () => {
        calls.push('flush');
      }),
      markRuntimeHandled: vi.fn(async (runtimeVersion: string) => {
        calls.push(`mark:${runtimeVersion}`);
      }),
      recordReloadTarget: vi.fn(async (updateId: string) => {
        calls.push(`target:${updateId}`);
      }),
      reload: vi.fn(async () => {
        calls.push('reload');
      }),
      onHandledError: vi.fn(),
      ...overrides,
    };
    return { deps, calls };
  }

  /** A reload that resolved leaves the settle waiting out the grace period. */
  async function settleThroughGrace(settled: Promise<LaunchUpdateOutcome>) {
    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_RELOAD_GRACE_MS);
    return settled;
  }

  it('reports, then persists both markers and flushes, and only then reloads', async () => {
    const { deps, calls } = settleDeps();

    await expect(settleThroughGrace(settleLaunchUpdate(RELOAD_DECISION, deps))).resolves.toBe('updated');
    expect(calls[0]).toBe('report:updated:download');
    expect(calls.at(-1)).toBe('reload');
    expect(calls.slice(1, -1).toSorted()).toEqual(['flush', `mark:${RUNTIME}`, 'target:next-update']);
  });

  it('waits for the flush before reloading, so the event can leave the device', async () => {
    let finishFlush: () => void = () => {};
    const { deps } = settleDeps({
      flushOutcome: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishFlush = resolve;
          }),
      ),
    });

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps);
    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_FLUSH_TIMEOUT_MS - 1);
    expect(deps.reload).not.toHaveBeenCalled();

    finishFlush();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.reload).toHaveBeenCalledOnce();
    await settleThroughGrace(settled);
  });

  it('reloads anyway when the flush never answers, after its 700 ms budget', async () => {
    const { deps } = settleDeps({ flushOutcome: vi.fn(() => new Promise<void>(() => {})) });

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps);
    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_FLUSH_TIMEOUT_MS);

    expect(deps.reload).toHaveBeenCalledOnce();
    expect(deps.onHandledError).not.toHaveBeenCalled();
    await settleThroughGrace(settled);
  });

  it('does not remember a target for a rollback reload', async () => {
    const { deps } = settleDeps();

    await settleThroughGrace(settleLaunchUpdate({ ...RELOAD_DECISION, targetUpdateId: null }, deps));
    expect(deps.recordReloadTarget).not.toHaveBeenCalled();
  });

  it.each(['timed_out', 'failed', 'nothing_newer', 'skipped_failed_update'] as const)(
    'marks the runtime on a first-launch release (%s) and never reloads or flushes',
    async (outcome) => {
      const { deps } = settleDeps();

      await expect(settleLaunchUpdate({ step: 'release', outcome, phase: 'check' }, deps)).resolves.toBe(outcome);
      expect(deps.reportOutcome).toHaveBeenCalledExactlyOnceWith(outcome, 'check');
      expect(deps.markRuntimeHandled).toHaveBeenCalledExactlyOnceWith(RUNTIME);
      expect(deps.reload).not.toHaveBeenCalled();
      expect(deps.flushOutcome).not.toHaveBeenCalled();
      expect(deps.recordReloadTarget).not.toHaveBeenCalled();
    },
  );

  it('does not mark an offline first launch', async () => {
    const { deps } = settleDeps();

    await expect(settleLaunchUpdate({ step: 'release', outcome: 'offline', phase: 'none' }, deps)).resolves.toBe(
      'offline',
    );
    expect(deps.reportOutcome).toHaveBeenCalledExactlyOnceWith('offline', 'none');
    expect(deps.markRuntimeHandled).not.toHaveBeenCalled();
  });

  it('never writes the first-launch marker for a cold start', async () => {
    const { deps } = settleDeps({ profile: 'cold_start' });

    await settleThroughGrace(settleLaunchUpdate(RELOAD_DECISION, deps));
    await settleLaunchUpdate({ step: 'release', outcome: 'timed_out', phase: 'check' }, deps);

    expect(deps.markRuntimeHandled).not.toHaveBeenCalled();
    expect(deps.recordReloadTarget).toHaveBeenCalledExactlyOnceWith('next-update');
  });

  it('releases as failed when the reload rejects, without a second event', async () => {
    const failure = new Error('no reference to the JS runtime');
    const { deps } = settleDeps({ reload: vi.fn().mockRejectedValue(failure) });

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps);
    await vi.advanceTimersByTimeAsync(0);

    await expect(settled).resolves.toBe('failed');
    expect(deps.onHandledError).toHaveBeenCalledExactlyOnceWith(failure, 'reload');
    expect(deps.reportOutcome).toHaveBeenCalledOnce();
  });

  it('releases as failed when the reload throws synchronously', async () => {
    const failure = new Error('native module missing');
    const { deps } = settleDeps({
      reload: vi.fn(() => {
        throw failure;
      }),
    });

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps);
    await vi.advanceTimersByTimeAsync(0);

    await expect(settled).resolves.toBe('failed');
    expect(deps.onHandledError).toHaveBeenCalledExactlyOnceWith(failure, 'reload');
  });

  it('resolves after the grace period when the reload never settles', async () => {
    const { deps } = settleDeps({ reload: vi.fn(() => new Promise<void>(() => {})) });
    let resolved = false;

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps).then((outcome) => {
      resolved = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_RELOAD_GRACE_MS - 1);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBe('updated');
  });

  it('counts the grace period from the reload call, not from its resolution', async () => {
    let finishReload: () => void = () => {};
    const { deps } = settleDeps({
      reload: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishReload = resolve;
          }),
      ),
    });
    let resolved = false;
    const settled = settleLaunchUpdate(RELOAD_DECISION, deps).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(LAUNCH_UPDATE_RELOAD_GRACE_MS - 100);
    finishReload();
    await vi.advanceTimersByTimeAsync(100);

    expect(resolved).toBe(true);
    await settled;
  });

  it('never rejects when the error handler itself throws', async () => {
    const { deps } = settleDeps({
      markRuntimeHandled: vi.fn().mockRejectedValue(new Error('async storage unavailable')),
      reload: vi.fn().mockRejectedValue(new Error('no reference to the JS runtime')),
      reportOutcome: vi.fn(() => {
        throw new Error('analytics client exploded');
      }),
      onHandledError: vi.fn(() => {
        throw new Error('error reporter exploded');
      }),
    });

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps);
    await vi.advanceTimersByTimeAsync(0);

    await expect(settled).resolves.toBe('failed');
    expect(deps.onHandledError).toHaveBeenCalledTimes(3);
  });

  it('survives a reporter that throws: still marks, still reloads', async () => {
    const failure = new Error('analytics client exploded');
    const { deps } = settleDeps({
      reportOutcome: vi.fn(() => {
        throw failure;
      }),
    });

    await expect(settleThroughGrace(settleLaunchUpdate(RELOAD_DECISION, deps))).resolves.toBe('updated');
    expect(deps.onHandledError).toHaveBeenCalledExactlyOnceWith(failure, 'report');
    expect(deps.markRuntimeHandled).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('still reloads when a marker write fails', async () => {
    const failure = new Error('async storage unavailable');
    const { deps } = settleDeps({ markRuntimeHandled: vi.fn().mockRejectedValue(failure) });

    await expect(settleThroughGrace(settleLaunchUpdate(RELOAD_DECISION, deps))).resolves.toBe('updated');
    expect(deps.onHandledError).toHaveBeenCalledExactlyOnceWith(failure, 'mark-first-launch-handled');
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('still reloads when a marker write never answers', async () => {
    const { deps } = settleDeps({
      recordReloadTarget: vi.fn(() => new Promise<void>(() => {})),
      markerWriteTimeoutMs: 500,
    });

    const settled = settleLaunchUpdate(RELOAD_DECISION, deps);
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.reload).toHaveBeenCalledOnce();
    await settleThroughGrace(settled);
  });
});
