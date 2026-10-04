// The launch update gate (#6006): on a cold start, hold the launch UI for a
// bounded time while expo-updates' own launch-time download finishes, then
// reload onto the new bundle before anyone can start signing in.
//
// Why it exists. Native `launchWaitMs` is 0 and `checkOnLaunch` is ALWAYS, so
// every launch runs the bundle already on the device and downloads the next one
// in the background. A new store binary's first launch therefore runs the JS
// embedded at build time. What used to move it forward was a side effect: the
// retired-channel cleanup ended in an ungated `reloadAsync()`, which
// expo-updates queued behind the launch download, so the reload landed whenever
// the download finished, often mid-sign-in. That reload is gone (see
// `ota-channel-override-cleanup.ts`); this is the deliberate replacement.
//
// Everything here is pure or dependency-injected, like `ota-recovery.ts`: no
// React, no expo-updates import. `launch-update-gate-store.ts` supplies the
// platform and runs it once per JS runtime.

/** Full cap for the first launch of a binary (an embedded launch not yet handled). */
export const FIRST_LAUNCH_UPDATE_CAP_MS = 15_000;
/** Full cap for every other eligible cold start. */
export const COLD_START_UPDATE_CAP_MS = 10_000;
/**
 * How long the manifest request gets to answer, on both profiles. Whoever owns
 * the timers arms one at this delay and one at the full cap. The full cap
 * only applies once a download is under way. On gym wifi with a dead upstream
 * the device reads as online and the manifest request just hangs (expo-updates
 * times it out after 60 s on iOS), which would otherwise hold every cold start
 * for the full cap with nothing to download.
 */
export const LAUNCH_UPDATE_CHECK_CAP_MS = 4_000;
/** The native splash covers the wait this long before the placeholder takes over. */
export const LAUNCH_UPDATE_PLACEHOLDER_DELAY_MS = 2_000;
/**
 * Budget for the pre-wait reads (markers, device state, override cleanup). They
 * are local and normally take milliseconds; this only exists so a native module
 * that never answers cannot hold the launch.
 */
export const LAUNCH_UPDATE_PREPARATION_TIMEOUT_MS = 1_500;
/** Budget for persisting the gate's markers before a reload. */
export const LAUNCH_UPDATE_MARKER_WRITE_TIMEOUT_MS = 700;
/** Budget for sending the outcome event before a reload tears the runtime down. */
export const LAUNCH_UPDATE_FLUSH_TIMEOUT_MS = 700;
/**
 * Counted from the moment `reloadAsync()` is called. If this runtime is still
 * alive after it, the reload did not happen and the app opens instead.
 */
export const LAUNCH_UPDATE_RELOAD_GRACE_MS = 5_000;

/**
 * Preference holding the runtime version whose first launch was already gated.
 * Keyed by runtime version so a store update to a new fingerprint is gated once
 * too, not only a fresh install.
 */
export const OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY = 'ota_first_launch_update_runtime_v1';
/**
 * Preference holding the id of the update the gate last reloaded for. See
 * `isKnownFailedUpdate` for the loop it breaks.
 */
export const OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY = 'ota_launch_update_last_reload_target_v1';

/**
 * How a gated launch is treated. A launch the gate does not cover at all has no
 * profile: `isLaunchUpdateGateEligible` answers false and nothing else runs.
 */
export type LaunchUpdateProfile = 'first_launch' | 'cold_start';
export type LaunchUpdateTrigger = 'fresh_install' | 'binary_update' | 'cold_start';
export type LaunchUpdateOutcome =
  | 'updated'
  | 'timed_out'
  | 'failed'
  | 'offline'
  | 'nothing_newer'
  | 'skipped_failed_update';
/**
 * What expo-updates was doing when the gate ended: still waiting on the
 * manifest (`check`), downloading or holding a downloaded update (`download`),
 * or neither (`none`).
 */
export type LaunchUpdatePhase = 'check' | 'download' | 'none';

/** Facts known synchronously at gate start, before any storage read. */
export type LaunchUpdateEligibilityInput = {
  /**
   * The Expo browser target. expo-updates' web module reports itself enabled
   * with an empty runtime version and never has anything to download.
   */
  isWeb: boolean;
  development: boolean;
  updatesEnabled: boolean;
  isEmergencyLaunch: boolean;
  /** The process was started without UI (an iOS LiveActivityIntent launch). */
  launchedInBackground: boolean;
  /**
   * JS restarts since the process started (the state machine's `restartCount`).
   * Above zero this runtime is the RESULT of a reload, not a cold start.
   */
  restartCount: number;
};

/**
 * Whether this launch is gated at all. False means the gate is resolved from
 * the start and never reads storage, tracks, or reloads.
 *
 * `restartCount > 0` is the first reload-loop guard: the gate can
 * reload at most once per process, because the runtime it reloads into is never
 * eligible. It also keeps a QA branch surf or a crash-screen recovery reload
 * from being gated a second time.
 */
export function isLaunchUpdateGateEligible({
  isWeb,
  development,
  updatesEnabled,
  isEmergencyLaunch,
  launchedInBackground,
  restartCount,
}: LaunchUpdateEligibilityInput): boolean {
  if (isWeb || development || !updatesEnabled) return false;
  // An emergency launch means expo-updates fell back to the embedded bundle
  // because a downloaded one would not start. Reloading onto the newest stored
  // update could walk straight back into it.
  if (isEmergencyLaunch) return false;
  if (launchedInBackground) return false;
  return restartCount === 0;
}

export type LaunchUpdateProfileInput = {
  isEmbeddedLaunch: boolean;
  runtimeVersion: string | null | undefined;
  /** The stored marker: the runtime version whose first launch was handled. */
  handledRuntimeVersion: string | null;
};

/** The profile of a launch that is already known to be eligible. */
export function resolveLaunchUpdateProfile({
  isEmbeddedLaunch,
  runtimeVersion,
  handledRuntimeVersion,
}: LaunchUpdateProfileInput): LaunchUpdateProfile {
  // Without a runtime version there is nothing to key the marker on, so the
  // launch takes the unmarked profile rather than being gated at 15 s forever.
  if (isEmbeddedLaunch && runtimeVersion && runtimeVersion !== handledRuntimeVersion) return 'first_launch';
  return 'cold_start';
}

export function resolveLaunchUpdateTrigger(
  profile: LaunchUpdateProfile,
  handledRuntimeVersion: string | null,
): LaunchUpdateTrigger {
  if (profile === 'cold_start') return 'cold_start';
  return handledRuntimeVersion === null ? 'fresh_install' : 'binary_update';
}

export function launchUpdateCapMs(profile: LaunchUpdateProfile): number {
  return profile === 'first_launch' ? FIRST_LAUNCH_UPDATE_CAP_MS : COLD_START_UPDATE_CAP_MS;
}

/**
 * The marker is written on every first-launch outcome except `offline`. Offline
 * costs one NetInfo read, so trying again on the next launch is free; every
 * other outcome has spent its one long wait.
 */
export function shouldMarkFirstLaunchHandled(profile: LaunchUpdateProfile, outcome: LaunchUpdateOutcome): boolean {
  return profile === 'first_launch' && outcome !== 'offline';
}

/** The slice of the expo-updates state machine the decision reads. */
export type LaunchUpdateState = {
  isStartupProcedureRunning: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  /** The manifest answered with something to download. */
  isUpdateAvailable: boolean;
  isUpdatePending: boolean;
  hasCheckError: boolean;
  hasDownloadError: boolean;
  /** The pending update is a directive back to the embedded bundle. */
  pendingIsRollback: boolean;
  /** Id of the downloaded update, undefined when nothing has been downloaded. */
  pendingUpdateId: string | undefined;
};

/** The native state machine context, as far as the gate reads it. */
export type LaunchUpdateNativeContext = {
  isStartupProcedureRunning: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  isUpdateAvailable: boolean;
  isUpdatePending: boolean;
  checkError?: unknown;
  downloadError?: unknown;
  downloadedManifest?: { id?: string } | null;
  rollback?: unknown;
};

/**
 * Same mapping `useUpdates()` applies to the native context (`downloadedUpdate`
 * is the downloaded manifest, else a rollback directive), without the hook.
 */
export function launchUpdateStateFromContext(context: LaunchUpdateNativeContext): LaunchUpdateState {
  const downloadedManifest = context.downloadedManifest ?? undefined;
  const pendingIsRollback = downloadedManifest === undefined && context.rollback != null;
  return {
    isStartupProcedureRunning: context.isStartupProcedureRunning,
    isChecking: context.isChecking,
    isDownloading: context.isDownloading,
    isUpdateAvailable: context.isUpdateAvailable,
    isUpdatePending: context.isUpdatePending,
    hasCheckError: context.checkError != null,
    hasDownloadError: context.downloadError != null,
    pendingIsRollback,
    pendingUpdateId: downloadedManifest === undefined ? undefined : (downloadedManifest.id ?? ''),
  };
}

/**
 * Progress of the one explicit check a stale-override launch needs.
 * - `not_needed`: the launch-time request went out with the right headers.
 * - `required`: it did not; ask again once the startup procedure has finished.
 * - `running`: the explicit check or its download is in flight.
 * - `fetched`: it downloaded something to reload onto.
 * - `nothing`: the server had nothing newer under the clean headers.
 * - `failed`: the check or the download threw.
 */
export type ExplicitUpdateCheckStatus = 'not_needed' | 'required' | 'running' | 'fetched' | 'nothing' | 'failed';

export type LaunchUpdateDecisionInput = {
  updates: LaunchUpdateState;
  /**
   * The check cap's timer has fired. A fact handed in by whoever owns the
   * timer, never re-derived from a clock here: a timer and a wall clock can
   * disagree (a clock step, or Android's monotonic timers), and a decision that
   * recomputed "has the cap passed" could answer no on the one tick that was
   * meant to end the wait, with nothing left to ask again.
   */
  checkCapExpired: boolean;
  /** The profile's full cap timer has fired. */
  capExpired: boolean;
  deviceOffline: boolean;
  runningUpdateId: string | null | undefined;
  isEmbeddedLaunch: boolean;
  explicitCheck: ExplicitUpdateCheckStatus;
  /**
   * False until auth has resolved. The launch-time token refresh is single-use
   * on the server: a reload between the server rotating the refresh token and
   * the app storing the new pair signs the climber out.
   */
  reloadAllowed: boolean;
  /** The update the gate reloaded for on an earlier cold start, if it is not the one running. */
  lastReloadTargetId: string | null;
  /** Id of the update the explicit check downloaded, when its result named one. */
  explicitFetchedUpdateId: string | null;
};

export type LaunchUpdateDecision =
  | { step: 'wait' }
  // Start the explicit check now. Only ever answered while `explicitCheck` is
  // `required`, so the caller starts it at most once.
  | { step: 'check' }
  | {
      step: 'reload';
      outcome: 'updated';
      phase: LaunchUpdatePhase;
      /** The update being reloaded onto, null for a rollback or an id not yet reported. */
      targetUpdateId: string | null;
    }
  | { step: 'release'; outcome: Exclude<LaunchUpdateOutcome, 'updated'>; phase: LaunchUpdatePhase };

export type LaunchUpdateTerminalDecision = Exclude<LaunchUpdateDecision, { step: 'wait' } | { step: 'check' }>;

/**
 * The second reload-loop guard: only a pending update that is not the
 * one already running is worth a reload. After a reload expo-updates resets its
 * state machine, so `isUpdatePending` is false in the new runtime and a later
 * cold start that launches the newest stored update gets "no update available"
 * from the launch check. This covers the case where that reasoning is wrong for
 * a reason we cannot see from here: a pending update whose id matches the
 * running one would otherwise reload every cold start, forever.
 */
export function isPendingUpdateNew(
  updates: Pick<LaunchUpdateState, 'isUpdatePending' | 'pendingIsRollback' | 'pendingUpdateId'>,
  runningUpdateId: string | null | undefined,
  isEmbeddedLaunch: boolean,
): boolean {
  if (!updates.isUpdatePending) return false;
  // A rollback directive means "run the embedded bundle". Already there.
  if (updates.pendingIsRollback) return !isEmbeddedLaunch;
  // Pending with nothing downloaded is a state expo-updates should not produce.
  // Not provably new, so it applies on the next launch instead.
  if (updates.pendingUpdateId === undefined) return false;
  return updates.pendingUpdateId !== runningUpdateId;
}

/**
 * A third loop guard, for an update that will not start.
 *
 * expo-updates' launch-time loader does not look at `failed_launch_count`: a
 * stored update that crashed on its first launch is handed back as "downloaded"
 * on every cold start. Its id differs from the running one, so the gate would
 * reload, the relaunch would skip it (launchable updates exclude a failed one),
 * and the same old bundle would start again. One wasted reload per cold start,
 * each reported as `updated`.
 *
 * So the gate remembers the id it last reloaded for. Seeing that same id
 * pending on a later cold start, while something else is running, means the
 * reload did not take. The marker is cleared when the target is the running
 * update, and overwritten by the next reload.
 */
export function isKnownFailedUpdate(reloadTargetId: string | null, lastReloadTargetId: string | null): boolean {
  return lastReloadTargetId !== null && reloadTargetId === lastReloadTargetId;
}

/**
 * The update a reload would land on, null for a rollback or when no id is
 * known. The explicit check's own result is the fallback: its promise can
 * resolve before the state machine's event has delivered the downloaded id.
 */
export function resolveReloadTargetId(
  updates: Pick<LaunchUpdateState, 'pendingIsRollback' | 'pendingUpdateId'>,
  explicitFetchedUpdateId: string | null,
): string | null {
  if (updates.pendingIsRollback) return null;
  return updates.pendingUpdateId ?? explicitFetchedUpdateId;
}

function isExplicitCheckOutstanding(explicitCheck: ExplicitUpdateCheckStatus): boolean {
  return explicitCheck === 'required' || explicitCheck === 'running';
}

/** Which of the two waits the launch is in. Decides which cap applies. */
export function resolveLaunchUpdatePhase(
  updates: LaunchUpdateState,
  explicitCheck: ExplicitUpdateCheckStatus,
  pendingIsNew: boolean,
): LaunchUpdatePhase {
  if (isExplicitCheckOutstanding(explicitCheck)) {
    // What the launch-time request found belongs to a retired channel, so only
    // a download actually in flight counts as the download phase.
    return updates.isDownloading ? 'download' : 'check';
  }
  if (updates.isDownloading || pendingIsNew || explicitCheck === 'fetched') return 'download';
  // The manifest answered with an update and the download is about to start.
  if (updates.isUpdateAvailable && updates.isStartupProcedureRunning) return 'download';
  if (updates.isStartupProcedureRunning || updates.isChecking) return 'check';
  return 'none';
}

/**
 * One evaluation of the gate. Pure and total: the caller re-runs it whenever
 * the expo-updates state changes, the explicit check moves, auth resolves, or a
 * cap timer fires. It reads no clock: the two caps arrive as facts.
 *
 * A `release` is final. The caller must never act on a later `reload` in the
 * same runtime: the download keeps going in the background and applies on the
 * next launch, which is exactly what keeps a reload from landing mid-sign-in.
 */
export function decideLaunchUpdateStep({
  updates,
  checkCapExpired,
  capExpired,
  deviceOffline,
  runningUpdateId,
  isEmbeddedLaunch,
  explicitCheck,
  reloadAllowed,
  lastReloadTargetId,
  explicitFetchedUpdateId,
}: LaunchUpdateDecisionInput): LaunchUpdateDecision {
  if (deviceOffline) return { step: 'release', outcome: 'offline', phase: 'none' };

  const startupIdle = !updates.isStartupProcedureRunning && !updates.isChecking && !updates.isDownloading;
  const pendingIsNew = isPendingUpdateNew(updates, runningUpdateId, isEmbeddedLaunch);
  const phase = resolveLaunchUpdatePhase(updates, explicitCheck, pendingIsNew);
  // The manifest gets the check cap; only a download gets the full one.
  const capReached = capExpired || (phase !== 'download' && checkCapExpired);

  if (isExplicitCheckOutstanding(explicitCheck)) {
    // The launch-time request used a retired override, so its errors and its
    // pending update say nothing about the channel this binary belongs to yet.
    // No verdict until the explicit check has answered, inside the same caps.
    if (capReached) return { step: 'release', outcome: 'timed_out', phase };
    // expo-updates runs its procedures one at a time, so an explicit check
    // issued earlier would only queue behind the startup procedure anyway.
    if (explicitCheck === 'required' && startupIdle) return { step: 'check' };
    return { step: 'wait' };
  }

  // Once the explicit check has answered, a launch-time pending update is used
  // even when the clean channel had nothing: expo-updates launches the newest
  // stored update on the next cold start regardless, and the reload is what
  // gives this install a runtime whose channel constant is the baked one.
  if (explicitCheck === 'fetched' || pendingIsNew) {
    const targetUpdateId = resolveReloadTargetId(updates, explicitFetchedUpdateId);
    if (isKnownFailedUpdate(targetUpdateId, lastReloadTargetId)) {
      return { step: 'release', outcome: 'skipped_failed_update', phase };
    }
    if (!reloadAllowed) {
      return capReached ? { step: 'release', outcome: 'timed_out', phase } : { step: 'wait' };
    }
    return { step: 'reload', outcome: 'updated', phase, targetUpdateId };
  }

  if (explicitCheck === 'failed') return { step: 'release', outcome: 'failed', phase };
  // After a clean explicit check the launch-time errors are the retired
  // channel's, not this one's.
  if (explicitCheck === 'not_needed' && (updates.hasCheckError || updates.hasDownloadError)) {
    return { step: 'release', outcome: 'failed', phase };
  }
  if (startupIdle) return { step: 'release', outcome: 'nothing_newer', phase };
  if (capReached) return { step: 'release', outcome: 'timed_out', phase };
  return { step: 'wait' };
}

/** Rejects after `timeoutMs`; the timer is cleared whichever side wins. */
export function withLaunchUpdateTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Launch update gate: ${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export type LaunchUpdatePreparationDeps = LaunchUpdateEligibilityInput & {
  isEmbeddedLaunch: boolean;
  runtimeVersion: string | null | undefined;
  runningUpdateId: string | null | undefined;
  readHandledRuntimeVersion: () => Promise<string | null>;
  readLastReloadTargetId: () => Promise<string | null>;
  clearLastReloadTarget: () => Promise<void>;
  /** Re-read the device from the platform. Never rejects in the real binding. */
  refreshDeviceState: () => Promise<void>;
  /** Read AFTER the refresh. `unknown` must answer false: it counts as online. */
  isDeviceOffline: () => boolean;
  /** Resolves true when this launch's manifest request used a retired override. */
  resolveStaleOverride: () => Promise<boolean>;
  timeoutMs?: number;
};

export type LaunchUpdatePreparation =
  | { kind: 'skip' }
  // The marker could not be read. The gate releases at once; the caller reports `error`.
  | { kind: 'storage_failed'; error: unknown }
  | {
      kind: 'gate';
      profile: LaunchUpdateProfile;
      trigger: LaunchUpdateTrigger;
      capMs: number;
      deviceOffline: boolean;
      explicitCheckRequired: boolean;
      lastReloadTargetId: string | null;
    };

/**
 * The reads the gate needs before it can decide anything, all local and all
 * bounded. They run together; the cap clock is already running by now.
 *
 * Failure rules differ on purpose:
 * - The first-launch marker failing (or hanging) releases the gate. Guessing a
 *   profile would either hold every launch at 15 s or skip the first-launch wait.
 * - A device read that hangs or throws counts as online: the caps still bound
 *   the wait.
 * - The override cleanup failing means no explicit check. Its own caller
 *   reports the error; the gate just carries on with the launch-time request.
 * - The reload-target read failing means no failed-update memory this launch.
 */
export async function prepareLaunchUpdateGate(deps: LaunchUpdatePreparationDeps): Promise<LaunchUpdatePreparation> {
  if (!isLaunchUpdateGateEligible(deps)) return { kind: 'skip' };
  const timeoutMs = deps.timeoutMs ?? LAUNCH_UPDATE_PREPARATION_TIMEOUT_MS;

  const markerRead = withLaunchUpdateTimeout(deps.readHandledRuntimeVersion(), timeoutMs, 'marker read').then(
    (handledRuntimeVersion) => ({ ok: true as const, handledRuntimeVersion }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const deviceRead = withLaunchUpdateTimeout(deps.refreshDeviceState(), timeoutMs, 'device read').then(
    () => deps.isDeviceOffline(),
    () => false,
  );
  const safeDeviceRead = deviceRead.catch(() => false);
  const staleOverrideRead = withLaunchUpdateTimeout(deps.resolveStaleOverride(), timeoutMs, 'override cleanup').catch(
    () => false,
  );
  const reloadTargetRead = withLaunchUpdateTimeout(
    deps.readLastReloadTargetId(),
    timeoutMs,
    'reload target read',
  ).catch(() => null);

  const [marker, deviceOffline, explicitCheckRequired, storedReloadTargetId] = await Promise.all([
    markerRead,
    safeDeviceRead,
    staleOverrideRead,
    reloadTargetRead,
  ]);
  if (!marker.ok) return { kind: 'storage_failed', error: marker.error };

  // The update the gate reloaded for is the one running: the reload took.
  let lastReloadTargetId = storedReloadTargetId;
  if (lastReloadTargetId !== null && lastReloadTargetId === deps.runningUpdateId) {
    lastReloadTargetId = null;
    void deps.clearLastReloadTarget().catch(() => {});
  }

  const profile = resolveLaunchUpdateProfile({ ...deps, handledRuntimeVersion: marker.handledRuntimeVersion });
  return {
    kind: 'gate',
    profile,
    trigger: resolveLaunchUpdateTrigger(profile, marker.handledRuntimeVersion),
    capMs: launchUpdateCapMs(profile),
    deviceOffline,
    explicitCheckRequired,
    lastReloadTargetId,
  };
}

export type ExplicitUpdateCheckDeps = {
  checkForUpdate: () => Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>;
  fetchUpdate: () => Promise<{ isNew: boolean; isRollBackToEmbedded: boolean; manifest?: { id?: string } | null }>;
  isEmbeddedLaunch: boolean;
};

export type ExplicitUpdateCheckResult =
  | { status: 'fetched'; updateId: string | null }
  | { status: 'nothing' }
  | { status: 'failed'; error: unknown };

/**
 * The one explicit check a stale-override launch makes, with the clean headers.
 * Answers from the fetch result rather than waiting for `isUpdatePending` to
 * arrive on the event stream: the promise and the state event are separate
 * deliveries, and reading "idle, nothing pending" between them would release
 * the gate one event too early.
 */
export async function runExplicitUpdateCheck({
  checkForUpdate,
  fetchUpdate,
  isEmbeddedLaunch,
}: ExplicitUpdateCheckDeps): Promise<ExplicitUpdateCheckResult> {
  try {
    const check = await checkForUpdate();
    if (!check.isAvailable && !check.isRollBackToEmbedded) return { status: 'nothing' };
    const fetched = await fetchUpdate();
    if (fetched.isNew) return { status: 'fetched', updateId: fetched.manifest?.id ?? null };
    // A rollback directive only changes anything when a downloaded update is running.
    if (fetched.isRollBackToEmbedded && !isEmbeddedLaunch) return { status: 'fetched', updateId: null };
    return { status: 'nothing' };
  } catch (error) {
    return { status: 'failed', error };
  }
}

export type LaunchUpdateSettleOp = 'report' | 'flush' | 'mark-first-launch-handled' | 'record-reload-target' | 'reload';

export type LaunchUpdateSettleDeps = {
  profile: LaunchUpdateProfile;
  runtimeVersion: string | null | undefined;
  /** Emit the outcome event. Called exactly once, before any reload. */
  reportOutcome: (outcome: LaunchUpdateOutcome, phase: LaunchUpdatePhase) => void;
  /** Send what `reportOutcome` queued. Only awaited before a reload. */
  flushOutcome: () => Promise<unknown>;
  markRuntimeHandled: (runtimeVersion: string) => Promise<void>;
  recordReloadTarget: (updateId: string) => Promise<void>;
  reload: () => Promise<void>;
  onHandledError: (error: unknown, op: LaunchUpdateSettleOp) => void;
  markerWriteTimeoutMs?: number;
  flushTimeoutMs?: number;
  reloadGraceMs?: number;
};

/**
 * Carry out a terminal decision: report, persist the markers, then reload if
 * the decision was a reload. It never rejects and always resolves, so the
 * caller can open the app on its resolution whatever happened.
 *
 * Before a reload it waits, for a bounded time, on three things side by side:
 * the event leaving the device (analytics only persists its queue on a
 * debounce, so a reload in the same tick as `track()` loses it), the
 * first-launch marker, and the reload-target marker.
 *
 * The event goes out BEFORE the reload because nothing after `reloadAsync()`
 * reliably runs. That ordering has one cost: if the reload itself fails, the
 * event already says `updated`. The failure is reported as a handled error and
 * the gate releases with `failed`, but no second event is sent, so the event
 * stays exactly-once per gated launch.
 *
 * The reload is bounded from the moment it is called. `reloadAsync()` resolves
 * right before the restart, rejects when the relaunch fails, and on Android can
 * do neither (a cancelled relaunch coroutine calls nothing back). Resolving
 * with `updated` after the grace period therefore means "asked for a reload and
 * this runtime is still here".
 */
export async function settleLaunchUpdate(
  decision: LaunchUpdateTerminalDecision,
  deps: LaunchUpdateSettleDeps,
): Promise<LaunchUpdateOutcome> {
  // The error reporter is the one dependency every failure path calls, so it
  // must not be able to turn a handled failure into a rejection.
  const reportHandled = (error: unknown, op: LaunchUpdateSettleOp): void => {
    try {
      deps.onHandledError(error, op);
    } catch {
      // Nothing left to tell: the gate still has to open the app.
    }
  };

  try {
    deps.reportOutcome(decision.outcome, decision.phase);
  } catch (error) {
    reportHandled(error, 'report');
  }

  const markerWriteTimeoutMs = deps.markerWriteTimeoutMs ?? LAUNCH_UPDATE_MARKER_WRITE_TIMEOUT_MS;
  const boundedWrite = (write: () => Promise<void>, op: LaunchUpdateSettleOp): Promise<void> =>
    withLaunchUpdateTimeout(Promise.resolve().then(write), markerWriteTimeoutMs, op).catch((error: unknown) =>
      reportHandled(error, op),
    );

  const writes: Promise<void>[] = [];
  const { runtimeVersion } = deps;
  if (runtimeVersion && shouldMarkFirstLaunchHandled(deps.profile, decision.outcome)) {
    writes.push(boundedWrite(() => deps.markRuntimeHandled(runtimeVersion), 'mark-first-launch-handled'));
  }

  // On a release nothing waits on the marker, so the app opens without the round trip.
  if (decision.step === 'release') return decision.outcome;

  const { targetUpdateId } = decision;
  if (targetUpdateId !== null) {
    writes.push(boundedWrite(() => deps.recordReloadTarget(targetUpdateId), 'record-reload-target'));
  }
  const flush = withLaunchUpdateTimeout(
    Promise.resolve().then(() => deps.flushOutcome()),
    deps.flushTimeoutMs ?? LAUNCH_UPDATE_FLUSH_TIMEOUT_MS,
    'flush',
    // A slow or failed send is not worth a report: the event is still queued.
  ).catch(() => {});
  await Promise.all([...writes, flush]);

  const reloadGraceMs = deps.reloadGraceMs ?? LAUNCH_UPDATE_RELOAD_GRACE_MS;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceElapsed = new Promise<'grace'>((resolve) => {
    graceTimer = setTimeout(() => resolve('grace'), reloadGraceMs);
  });
  // A resolved reload never wins the race: the restart is on its way, and if it
  // is not, the grace timer is what says so.
  const reloadFailure = Promise.resolve()
    .then(() => deps.reload())
    .then(
      () => new Promise<never>(() => {}),
      (error: unknown) => ({ error }),
    );

  const winner = await Promise.race([reloadFailure, graceElapsed]);
  clearTimeout(graceTimer);
  if (winner === 'grace') return 'updated';
  reportHandled(winner.error, 'reload');
  return 'failed';
}
