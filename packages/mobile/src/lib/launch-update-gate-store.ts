// Runs the launch update gate once per JS runtime and publishes its state.
//
// A module-level store rather than component state, for three reasons the gate
// cannot get from a hook:
// - Per runtime, not per mount. The root layout can remount inside one runtime
//   (the router's error boundary retry, Android recreating the activity over a
//   live process). A second mount must see the first one's verdict, never start
//   a second gate, and never reload after an earlier release.
// - No missed events. `Updates.useUpdates()` seeds its state at render and
//   subscribes in a passive effect with no resync, so a state change landing in
//   between is lost and the hook can sit at "startup running" forever. Here the
//   listener is attached synchronously when the gate starts, and every
//   evaluation re-reads the latest context.
// - It stops listening. Once the gate resolves it drops its expo-updates
//   subscription and its timers, so the root layout is not re-rendered by OTA
//   state changes for the rest of the session.
//
// The rules themselves live in `launch-update-gate.ts`, which stays pure.
import { AppState, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { reportAnonymousOtaLaunch } from './anonymous-ota-health';
import { getConnectivitySnapshot, refreshDeviceState } from './connectivity/connectivity-store';
import { addErrorBreadcrumb, reportHandledError } from './error-reporting';
import {
  COLD_START_UPDATE_CAP_MS,
  LAUNCH_UPDATE_CHECK_CAP_MS,
  LAUNCH_UPDATE_PLACEHOLDER_DELAY_MS,
  OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY,
  OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY,
  decideLaunchUpdateStep,
  isLaunchUpdateGateEligible,
  launchUpdateStateFromContext,
  prepareLaunchUpdateGate,
  runExplicitUpdateCheck,
  settleLaunchUpdate,
  type ExplicitUpdateCheckStatus,
  type LaunchUpdateOutcome,
  type LaunchUpdatePhase,
  type LaunchUpdatePreparation,
  type LaunchUpdateTerminalDecision,
  type LaunchUpdateTrigger,
} from './launch-update-gate';
import { runChannelOverrideCleanupOnce } from './ota-channel-override-cleanup-run';
import { buildOtaLaunchUpdateProperties } from './ota-telemetry';
import { getPreference, removePreference, setPreference } from './preference-store';

export type LaunchUpdateGateFlags = {
  /** The gate is out of the way: nothing to wait for, or it released. Never goes back to false. */
  resolved: boolean;
  /**
   * Paint the progress placeholder. True once the wait outlasts the splash
   * window, and it stays true until the gate has resolved AND auth is ready, so
   * the hand-over never exposes the pre-auth tree.
   */
  showPlaceholder: boolean;
};

/**
 * Test seam. Vitest substitutes `__DEV__` textually with `true`, so a literal
 * check here could never be exercised as a production launch.
 */
export type LaunchUpdateGateEnvironment = { development: boolean };

type GatePreparation = Extract<LaunchUpdatePreparation, { kind: 'gate' }>;
type GatePhase = 'idle' | 'preparing' | 'waiting' | 'settling' | 'resolved';
type NativeContext = typeof Updates.latestContext;

const INITIAL_FLAGS: LaunchUpdateGateFlags = { resolved: false, showPlaceholder: false };

// Everything below is the single run for this runtime.
let gatePhase: GatePhase = 'idle';
let flags: LaunchUpdateGateFlags = INITIAL_FLAGS;
let progress: number | undefined;
// Bumped on every reset, so a promise still in flight from an earlier run (a
// test reset, in practice) cannot move the next one.
let runGeneration = 0;
// performance.now(), not Date.now(): durations must not follow a clock step.
let startedAtMs = 0;
let preparation: GatePreparation | null = null;
let explicitCheck: ExplicitUpdateCheckStatus = 'not_needed';
let explicitFetchedUpdateId: string | null = null;
// Set by the cap timers and by nothing else. The decision takes them as facts.
let checkCapExpired = false;
let capExpired = false;
let authReady = false;
let placeholderTookOver = false;
let newestEventContext: NativeContext | null = null;
let unsubscribeFromUpdates: (() => void) | null = null;
const timers = new Set<ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

/**
 * Only iOS starts this React root without UI (a LiveActivityIntent launch), and
 * it reports that as `background`. Android reports `background` until its
 * activity resumes even on an ordinary launch, so it never counts there.
 *
 * iOS reads `UIApplication.applicationState` when the AppState module is first
 * touched, and an ordinary foreground launch can in principle still be in
 * `background` or `inactive` that early. `inactive` is treated as foreground.
 * A `background` read skips the gate, and leaves a breadcrumb so a foreground
 * launch misread this way is visible rather than silent.
 */
function wasLaunchedInBackground(): boolean {
  return Platform.OS === 'ios' && AppState.currentState === 'background';
}

/** The newest context we know of: the module's live one, or a later event's. */
function readLatestContext(): NativeContext {
  const moduleContext = Updates.latestContext;
  if (newestEventContext !== null && newestEventContext.sequenceNumber > moduleContext.sequenceNumber) {
    return newestEventContext;
  }
  return moduleContext;
}

function publish(): void {
  const resolved = gatePhase === 'resolved';
  const showPlaceholder = placeholderTookOver && !(resolved && authReady);
  let nextProgress: number | undefined;
  if (!resolved && gatePhase !== 'idle') {
    const context = readLatestContext();
    if (context.isDownloading && typeof context.downloadProgress === 'number') {
      nextProgress = Math.min(1, Math.max(0, context.downloadProgress));
    }
  }

  const flagsChanged = flags.resolved !== resolved || flags.showPlaceholder !== showPlaceholder;
  const progressChanged = progress !== nextProgress;
  if (!flagsChanged && !progressChanged) return;
  // Reference-stable between changes: useSyncExternalStore compares by identity.
  if (flagsChanged) flags = { resolved, showPlaceholder };
  progress = nextProgress;
  for (const listener of listeners) listener();
}

function schedule(callback: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delayMs);
  timers.add(timer);
}

function resolveGate(): void {
  if (gatePhase === 'resolved') return;
  gatePhase = 'resolved';
  unsubscribeFromUpdates?.();
  unsubscribeFromUpdates = null;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  publish();
}

/** Report without letting the reporter itself become the failure. */
function reportGateError(error: unknown, op: string): void {
  try {
    reportHandledError(error, { tags: { source: 'ota', op: `launch-update-${op}` } });
  } catch {
    // Nothing left to tell. Opening the app matters more than this report.
  }
}

/**
 * Last link of every async chain: whatever went wrong, the app opens. The gate
 * resolves FIRST, so a reporter that throws cannot leave the launch held.
 */
function failOpen(op: string, generation: number) {
  return (error: unknown): void => {
    if (generation !== runGeneration) return;
    try {
      resolveGate();
    } finally {
      reportGateError(error, op);
    }
  };
}

function elapsedMs(): number {
  return performance.now() - startedAtMs;
}

let launchReport: Promise<void> = Promise.resolve();

function trackLaunchUpdate(
  outcome: LaunchUpdateOutcome,
  phase: LaunchUpdatePhase,
  trigger: LaunchUpdateTrigger,
  capMs: number,
): void {
  launchReport = reportAnonymousOtaLaunch(
    buildOtaLaunchUpdateProperties({
      outcome,
      phase,
      durationMs: elapsedMs(),
      trigger,
      capMs,
      runtimeVersion: Updates.runtimeVersion,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    }),
  );
}

function settle(decision: LaunchUpdateTerminalDecision, prepared: GatePreparation): void {
  // One terminal action per runtime. From here no state change can reload.
  gatePhase = 'settling';
  const generation = runGeneration;
  void settleLaunchUpdate(decision, {
    profile: prepared.profile,
    runtimeVersion: Updates.runtimeVersion,
    reportOutcome: (outcome, phase) => trackLaunchUpdate(outcome, phase, prepared.trigger, prepared.capMs),
    flushOutcome: async () => {
      await launchReport;
    },
    markRuntimeHandled: (runtimeVersion) => setPreference(OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY, runtimeVersion),
    recordReloadTarget: (updateId) => setPreference(OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY, updateId),
    reload: () => Updates.reloadAsync(),
    onHandledError: reportGateError,
  }).then(
    () => {
      if (generation === runGeneration) resolveGate();
    },
    failOpen('settle', generation),
  );
}

function startExplicitCheck(): void {
  explicitCheck = 'running';
  const generation = runGeneration;
  void runExplicitUpdateCheck({
    checkForUpdate: () => Updates.checkForUpdateAsync(),
    fetchUpdate: () => Updates.fetchUpdateAsync(),
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  })
    .then((result) => {
      if (generation !== runGeneration) return;
      if (result.status === 'failed') reportGateError(result.error, 'explicit-check');
      if (result.status === 'fetched') explicitFetchedUpdateId = result.updateId;
      explicitCheck = result.status;
      evaluate();
    })
    .catch(failOpen('explicit-check', generation));
}

function evaluate(): void {
  if (gatePhase !== 'waiting' || preparation === null) {
    publish();
    return;
  }
  try {
    const decision = decideLaunchUpdateStep({
      updates: launchUpdateStateFromContext(readLatestContext()),
      checkCapExpired,
      capExpired,
      deviceOffline: preparation.deviceOffline,
      runningUpdateId: Updates.updateId,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      explicitCheck,
      reloadAllowed: authReady,
      lastReloadTargetId: preparation.lastReloadTargetId,
      explicitFetchedUpdateId,
    });
    if (decision.step === 'check') startExplicitCheck();
    else if (decision.step !== 'wait') settle(decision, preparation);
    publish();
  } catch (error) {
    failOpen('evaluate', runGeneration)(error);
  }
}

/** The device cannot reach the update server, or the climber said not to try. */
function isDeviceOffline(): boolean {
  const connectivity = getConnectivitySnapshot();
  return (
    connectivity.offlineMode || connectivity.device === 'offline' || connectivity.deviceReachability === 'unreachable'
  );
}

function onPrepared(prepared: LaunchUpdatePreparation): void {
  if (prepared.kind === 'gate') {
    preparation = prepared;
    explicitCheck = prepared.explicitCheckRequired ? 'required' : 'not_needed';
    gatePhase = 'waiting';
    // The cap timers are authoritative: each one records that it fired and the
    // decision is told so, rather than working the elapsed time out again from
    // a clock that may have stepped. The clock started with the gate, so the
    // preparation reads came out of the same budget.
    const alreadyElapsedMs = elapsedMs();
    schedule(
      () => {
        checkCapExpired = true;
        evaluate();
      },
      Math.max(0, Math.min(prepared.capMs, LAUNCH_UPDATE_CHECK_CAP_MS) - alreadyElapsedMs),
    );
    schedule(
      () => {
        capExpired = true;
        evaluate();
      },
      Math.max(0, prepared.capMs - alreadyElapsedMs),
    );
    evaluate();
    return;
  }
  if (prepared.kind === 'storage_failed') {
    reportGateError(prepared.error, 'read-marker');
    // The profile is unknowable without the marker, so the event carries the
    // unmarked one.
    trackLaunchUpdate('failed', 'none', 'cold_start', COLD_START_UPDATE_CAP_MS);
  }
  resolveGate();
}

const DEFAULT_ENVIRONMENT: LaunchUpdateGateEnvironment = { development: __DEV__ };

/**
 * Start the gate. Idempotent: only the first call in a runtime does anything,
 * which is what makes a remounted root layout read the existing verdict.
 */
export function startLaunchUpdateGate(environment: LaunchUpdateGateEnvironment = DEFAULT_ENVIRONMENT): void {
  if (gatePhase !== 'idle') return;
  // The first root layout render calls this. Whatever throws in here, that
  // render must not: the gate opens and the launch carries on without it.
  try {
    beginLaunchUpdateGate(environment);
  } catch (error) {
    failOpen('start', runGeneration)(error);
  }
}

function beginLaunchUpdateGate(environment: LaunchUpdateGateEnvironment): void {
  const isWeb = Platform.OS === 'web';
  if (isWeb) {
    // The browser target has no OTA. Resolved at once with no timer, listener
    // or event, so a static render starts nothing either.
    resolveGate();
    return;
  }

  const generation = runGeneration;
  startedAtMs = performance.now();

  const launchedInBackground = wasLaunchedInBackground();
  const eligibility = {
    isWeb,
    development: environment.development,
    updatesEnabled: Updates.isEnabled,
    isEmergencyLaunch: Updates.isEmergencyLaunch,
    launchedInBackground,
    restartCount: Updates.isEnabled ? Updates.latestContext.restartCount : 0,
  };
  if (!isLaunchUpdateGateEligible(eligibility)) {
    if (launchedInBackground && isLaunchUpdateGateEligible({ ...eligibility, launchedInBackground: false })) {
      addErrorBreadcrumb({
        category: 'ota',
        message: 'launch update gate skipped: background launch',
        level: 'info',
        data: { appState: AppState.currentState },
      });
    }
    resolveGate();
    return;
  }

  gatePhase = 'preparing';
  const subscription = Updates.addUpdatesStateChangeListener((event) => {
    newestEventContext = event.context;
    evaluate();
  });
  unsubscribeFromUpdates = () => subscription.remove();

  // Hand over from the native splash to the placeholder.
  schedule(() => {
    placeholderTookOver = true;
    publish();
  }, LAUNCH_UPDATE_PLACEHOLDER_DELAY_MS);

  void prepareLaunchUpdateGate({
    ...eligibility,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    runtimeVersion: Updates.runtimeVersion,
    runningUpdateId: Updates.updateId,
    readHandledRuntimeVersion: () => getPreference<string>(OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY),
    readLastReloadTargetId: () => getPreference<string>(OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY),
    clearLastReloadTarget: () => removePreference(OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY),
    refreshDeviceState,
    isDeviceOffline,
    resolveStaleOverride: async () => (await runChannelOverrideCleanupOnce()).staleOverrideActive,
  })
    .then((prepared) => {
      if (generation === runGeneration) onPrepared(prepared);
    })
    .catch(failOpen('prepare', generation));
}

/**
 * Auth has resolved, so its launch-time token refresh is no longer in flight
 * and a reload cannot cut it in half. Safe to call before the gate starts and
 * more than once.
 */
export function notifyLaunchUpdateAuthReady(): void {
  if (authReady) return;
  authReady = true;
  evaluate();
}

export function subscribeLaunchUpdateGate(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getLaunchUpdateGateFlags(): LaunchUpdateGateFlags {
  return flags;
}

/** Download progress from 0 to 1, or undefined when there is none to show. */
export function getLaunchUpdateProgress(): number | undefined {
  return progress;
}

/** Test seam: put the module back to its pre-launch state. */
export function resetLaunchUpdateGateForTests(): void {
  unsubscribeFromUpdates?.();
  unsubscribeFromUpdates = null;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  listeners.clear();
  runGeneration += 1;
  gatePhase = 'idle';
  flags = INITIAL_FLAGS;
  progress = undefined;
  startedAtMs = 0;
  preparation = null;
  explicitCheck = 'not_needed';
  explicitFetchedUpdateId = null;
  checkCapExpired = false;
  capExpired = false;
  authReady = false;
  placeholderTookOver = false;
  newestEventContext = null;
}
