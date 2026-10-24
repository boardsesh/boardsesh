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
  LAUNCH_UPDATE_RELOAD_GRACE_MS,
  LAUNCH_UPDATE_RELOAD_OUTSTANDING_MARGIN_MS,
  LAUNCH_UPDATE_RELOAD_START_WINDOW_MS,
  OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY,
  OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY,
  OTA_LAUNCH_UPDATE_RELOAD_OUTLIVED_GRACE_KEY,
  decideLaunchUpdateStep,
  isLaunchUpdateGateEligible,
  launchUpdateStateFromContext,
  prepareLaunchUpdateGate,
  resolveLaunchUpdateStage,
  runExplicitUpdateCheck,
  settleLaunchUpdate,
  shouldTakeOverFromSplash,
  type ExplicitUpdateCheckStatus,
  type LaunchUpdateOutcome,
  type LaunchUpdatePhase,
  type LaunchUpdatePreparation,
  type LaunchUpdateStage,
  type LaunchUpdateTerminalDecision,
  type LaunchUpdateTrigger,
} from './launch-update-gate';
import { runChannelOverrideCleanupOnce } from './ota-channel-override-cleanup-run';
import { buildOtaLaunchUpdateProperties } from './ota-telemetry';
import { getPreference, removePreference, setPreference } from './preference-store';
import { readOtaHeaderRevision, runOtaOperation } from './ota-operation-owner';
import { setJsRestartCount, setLaunchReloadPossible, setLaunchReloadRequested } from './launch-reload-window';
import { isDatabaseInitAttemptRunning, subscribeDatabaseInitAttempt } from '../db/init-activity';
import {
  captureOtaReloadReceipt,
  fetchOwnedOtaUpdate,
  isOtaReloadReceiptCurrent,
  waitForOtaUpdatesIdle,
} from './qa/qa-surf';

export type LaunchUpdateGateFlags = {
  /** The gate is out of the way: nothing to wait for, or it released. Never goes back to false. */
  resolved: boolean;
  /**
   * Paint the progress placeholder. True once the placeholder takes over from
   * the splash (see `shouldTakeOverFromSplash`), and it stays true until the
   * gate has resolved AND auth is ready, so the hand-over never exposes the
   * pre-auth tree.
   */
  showPlaceholder: boolean;
  /**
   * The placeholder has laid out, so the native splash can hide without
   * exposing an empty window. It can mount late: it sits inside the i18n
   * provider, which renders nothing until its stored locale is read. Never goes
   * back to false.
   */
  placeholderPainted: boolean;
};

/**
 * Test seam. Vitest substitutes `__DEV__` textually with `true`, so a literal
 * check here could never be exercised as a production launch.
 */
export type LaunchUpdateGateEnvironment = { development: boolean };

type GatePreparation = Extract<LaunchUpdatePreparation, { kind: 'gate' }>;
type GatePhase = 'idle' | 'preparing' | 'waiting' | 'settling' | 'resolved';
type NativeContext = typeof Updates.latestContext;

const INITIAL_FLAGS: LaunchUpdateGateFlags = { resolved: false, showPlaceholder: false, placeholderPainted: false };

// Everything below is the single run for this runtime.
let gatePhase: GatePhase = 'idle';
let flags: LaunchUpdateGateFlags = INITIAL_FLAGS;
let progress: number | undefined;
let stage: LaunchUpdateStage = 'checking';
let firstLaunch = false;
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
let splashWindowElapsed = false;
let placeholderTookOver = false;
let placeholderPainted = false;
// The terminal decision is a reload, so the placeholder says "installing".
let settlingReload = false;
// Set by the reload-window timer: past this a reload decided earlier is dropped.
let reloadWindowClosed = false;
let newestEventContext: NativeContext | null = null;
let explicitCheckController: AbortController | null = null;
let unsubscribeFromUpdates: (() => void) | null = null;
let unsubscribeFromDatabaseInit: (() => void) | null = null;
// Ends the extra hold on SQLite writers after a reload that outlived its grace.
// Not in `timers`: `resolveGate()` clears those, and this one has to outlive it.
let reloadOutstandingTimer: ReturnType<typeof setTimeout> | null = null;
// Whether the previous gated runtime asked for a reload and was still alive after
// the grace. Read once at gate start for the outcome event; null until the read
// lands, which is milliseconds against the preparation reads it runs beside.
let previousReloadOutlivedGrace: boolean | null = null;
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

/**
 * Only moves forward: once the placeholder says "installing" it never goes back
 * to "checking", which would read as the app starting over. It is worked out
 * only while the gate waits, and frozen once the gate has a verdict, so the
 * copy does not change under a placeholder held up by the auth wait. Not while
 * preparing either: until the reads are done the gate cannot know that this
 * launch is offline or that its download belongs to a retired channel.
 */
function resolveStage(context: NativeContext): LaunchUpdateStage {
  if (stage === 'installing' || settlingReload) return 'installing';
  if (gatePhase !== 'waiting') return stage;
  return resolveLaunchUpdateStage({
    updates: launchUpdateStateFromContext(context),
    explicitCheck,
    runningUpdateId: Updates.updateId,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  });
}

function publish(): void {
  const resolved = gatePhase === 'resolved';
  let nextProgress: number | undefined;
  let nextStage = stage;
  if (!resolved && gatePhase !== 'idle') {
    const context = readLatestContext();
    if (context.isDownloading && typeof context.downloadProgress === 'number') {
      nextProgress = Math.min(1, Math.max(0, context.downloadProgress));
    }
    nextStage = resolveStage(context);
    // A release already decided never raises the placeholder: the app is about
    // to open, so the splash covers the last few milliseconds instead. Nor does
    // a launch still preparing, which may turn out to release at once (offline,
    // a failed update); the reads take milliseconds, and the 2 s window still
    // applies if they run long.
    const stillWaiting = gatePhase === 'waiting' || settlingReload;
    if (
      stillWaiting &&
      shouldTakeOverFromSplash({ profile: preparation?.profile ?? null, stage: nextStage, splashWindowElapsed })
    ) {
      placeholderTookOver = true;
    }
  }
  const nextFirstLaunch = preparation?.profile === 'first_launch';
  const showPlaceholder = placeholderTookOver && !(resolved && authReady);

  const flagsChanged =
    flags.resolved !== resolved ||
    flags.showPlaceholder !== showPlaceholder ||
    flags.placeholderPainted !== placeholderPainted;
  const statusChanged = progress !== nextProgress || stage !== nextStage || firstLaunch !== nextFirstLaunch;
  if (!flagsChanged && !statusChanged) return;
  // Reference-stable between changes: useSyncExternalStore compares by identity.
  if (flagsChanged) flags = { resolved, showPlaceholder, placeholderPainted };
  progress = nextProgress;
  stage = nextStage;
  firstLaunch = nextFirstLaunch;
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
  // From here the gate never reloads this runtime, so writers may start (#6689).
  setLaunchReloadPossible(false);
  unsubscribeFromDatabaseInit?.();
  unsubscribeFromDatabaseInit = null;
  // The native request itself cannot be cancelled. Abort its JS continuation:
  // a check arriving after release must not start a new download or reload.
  explicitCheckController?.abort();
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
      // Whatever was in flight, no reload is coming from this run any more.
      setLaunchReloadRequested(false);
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
      previousReloadOutlivedGrace,
    }),
  );
}

function settle(decision: LaunchUpdateTerminalDecision, prepared: GatePreparation): void {
  // One terminal action per runtime. From here no state change can reload.
  gatePhase = 'settling';
  settlingReload = decision.step === 'reload';
  // Synchronously, before anything awaits: from this moment the database init
  // chain starts no new setup attempt, and writers keep waiting even if the gate
  // resolves on the grace path (#6689).
  if (settlingReload) setLaunchReloadRequested(true);
  const generation = runGeneration;
  // A reload still has its flush and marker writes to do, so it may start
  // until the cap plus the start window. Without the window a download
  // finishing just before the cap would report `updated` and then be dropped.
  // Anchored to the cap, never to the decision: a JS thread that stalled past
  // the cap must not buy a late reload a fresh window.
  const reloadDeadlineMs = prepared.capMs + LAUNCH_UPDATE_RELOAD_START_WINDOW_MS;
  if (settlingReload) {
    schedule(
      () => {
        reloadWindowClosed = true;
      },
      Math.max(0, reloadDeadlineMs - elapsedMs()),
    );
  }
  const headerRevision = readOtaHeaderRevision();
  const receipt = decision.step === 'reload' ? captureOtaReloadReceipt() : null;
  const rollbackCommitTime = readLatestContext().rollback?.commitTime;
  void settleLaunchUpdate(decision, {
    trigger: prepared.trigger,
    runtimeVersion: Updates.runtimeVersion,
    reportOutcome: (outcome, phase) => trackLaunchUpdate(outcome, phase, prepared.trigger, prepared.capMs),
    flushOutcome: async () => {
      await launchReport;
    },
    markRuntimeHandled: (runtimeVersion) => setPreference(OTA_FIRST_LAUNCH_UPDATE_RUNTIME_KEY, runtimeVersion),
    recordReloadTarget: (updateId) => setPreference(OTA_LAUNCH_UPDATE_LAST_RELOAD_TARGET_KEY, updateId),
    reload: () => Updates.reloadAsync(),
    reloadWithStartSignal: (onStarted) =>
      runOtaOperation(
        async (lease) => {
          lease.assertActive();
          const current = captureOtaReloadReceipt();
          const matchesTarget =
            decision.step === 'reload' &&
            current !== null &&
            (decision.targetUpdateId !== null
              ? current.target.kind === 'update' && current.target.id === decision.targetUpdateId
              : current.target.kind === 'rollback' && current.target.commitTime === rollbackCommitTime);
          if (
            generation !== runGeneration ||
            gatePhase !== 'settling' ||
            reloadWindowClosed ||
            headerRevision !== readOtaHeaderRevision() ||
            !matchesTarget ||
            (receipt !== null && !isOtaReloadReceiptCurrent(receipt))
          ) {
            throw new Error('The launch update target changed before restart.');
          }
          await lease.reload(() => {
            // The decision saw no setup attempt running and the init chain starts
            // none while a reload is requested, so this should never fire. If it
            // does, a reload now would strand the migration's write lock (#6689).
            if (isDatabaseInitAttemptRunning()) {
              throw new Error('A database setup attempt was running at restart.');
            }
            onStarted();
            return Updates.reloadAsync();
          });
        },
        { timeoutMs: Math.max(0, Math.min(LAUNCH_UPDATE_RELOAD_GRACE_MS, reloadDeadlineMs - elapsedMs())) },
      ),
    onHandledError: reportGateError,
  }).then(
    (outcome) => {
      if (generation !== runGeneration) return;
      if (decision.step === 'reload') {
        if (outcome === 'updated') holdWritesAfterGrace();
        else setLaunchReloadRequested(false);
      }
      resolveGate();
    },
    failOpen('settle', generation),
  );
}

/** Reads, and clears, the marker `holdWritesAfterGrace` leaves for the next gated launch. */
function readPreviousReloadOutlivedGrace(generation: number): void {
  try {
    void getPreference<boolean>(OTA_LAUNCH_UPDATE_RELOAD_OUTLIVED_GRACE_KEY).then(
      (outlived) => {
        if (generation !== runGeneration) return;
        previousReloadOutlivedGrace = outlived === true;
        if (outlived === true) void removePreference(OTA_LAUNCH_UPDATE_RELOAD_OUTLIVED_GRACE_KEY).catch(() => {});
      },
      () => {},
    );
  } catch {
    // Telemetry only: the gate runs the same without it.
  }
}

/**
 * The reload was asked for and this runtime is still here after the grace. The
 * app opens, but on Android the relaunch can still be queued behind
 * expo-updates' own work, and a write transaction it lands on would keep the
 * lock for the rest of the process (#6689). So writers wait a bounded margin
 * more, and the next gated launch reports that this happened.
 */
function holdWritesAfterGrace(): void {
  if (reloadOutstandingTimer !== null) clearTimeout(reloadOutstandingTimer);
  reloadOutstandingTimer = setTimeout(() => {
    reloadOutstandingTimer = null;
    setLaunchReloadRequested(false);
  }, LAUNCH_UPDATE_RELOAD_OUTSTANDING_MARGIN_MS);
  void setPreference(OTA_LAUNCH_UPDATE_RELOAD_OUTLIVED_GRACE_KEY, true).catch(() => {});
}

function startExplicitCheck(): void {
  explicitCheck = 'running';
  const generation = runGeneration;
  explicitCheckController = new AbortController();
  void runOtaOperation(
    async (lease) => {
      await waitForOtaUpdatesIdle(lease);
      return runExplicitUpdateCheck({
        checkForUpdate: () => lease.native(() => Updates.checkForUpdateAsync()),
        fetchUpdate: () => lease.native(fetchOwnedOtaUpdate),
        isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      });
    },
    { signal: explicitCheckController.signal },
  )
    .then((result) => {
      if (generation !== runGeneration || gatePhase !== 'waiting') return;
      if (result.status === 'failed') reportGateError(result.error, 'explicit-check');
      if (result.status === 'fetched') explicitFetchedUpdateId = result.updateId;
      explicitCheck = result.status;
      evaluate();
    })
    .catch((error: unknown) => {
      if (generation === runGeneration && gatePhase === 'waiting') failOpen('explicit-check', generation)(error);
    });
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
      reloadAllowed: authReady && !isDatabaseInitAttemptRunning(),
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
  setJsRestartCount(eligibility.restartCount);
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
  // Until the gate resolves it may reload this runtime, and on Android a reload
  // leaves any open SQLite write transaction holding the lock for the rest of the
  // process (#6689). Writers outside React wait on this; the offline engine waits
  // on `useLaunchReady()`, which needs the gate resolved too.
  setLaunchReloadPossible(true);
  readPreviousReloadOutlivedGrace(generation);
  // A setup attempt finishing is what lets a held reload go ahead.
  unsubscribeFromDatabaseInit = subscribeDatabaseInitAttempt(evaluate);
  const subscription = Updates.addUpdatesStateChangeListener((event) => {
    newestEventContext = event.context;
    evaluate();
  });
  unsubscribeFromUpdates = () => subscription.remove();

  // A cold start still waiting on the server hands over from the native splash
  // here. A fresh install, or a launch with a download under way, already has.
  schedule(() => {
    splashWindowElapsed = true;
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

/** The placeholder has laid out, so the native splash can hide over it. */
export function notifyLaunchUpdatePlaceholderPainted(): void {
  if (placeholderPainted) return;
  placeholderPainted = true;
  publish();
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

export function getLaunchUpdateStage(): LaunchUpdateStage {
  return stage;
}

/** This launch is a fresh install's first, the one long wait. */
export function getLaunchUpdateFirstLaunch(): boolean {
  return firstLaunch;
}

/** Test seam: put the module back to its pre-launch state. */
export function resetLaunchUpdateGateForTests(): void {
  explicitCheckController?.abort();
  explicitCheckController = null;
  unsubscribeFromUpdates?.();
  unsubscribeFromUpdates = null;
  unsubscribeFromDatabaseInit?.();
  unsubscribeFromDatabaseInit = null;
  if (reloadOutstandingTimer !== null) clearTimeout(reloadOutstandingTimer);
  reloadOutstandingTimer = null;
  previousReloadOutlivedGrace = null;
  setLaunchReloadPossible(false);
  setLaunchReloadRequested(false);
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  listeners.clear();
  runGeneration += 1;
  gatePhase = 'idle';
  flags = INITIAL_FLAGS;
  progress = undefined;
  stage = 'checking';
  firstLaunch = false;
  startedAtMs = 0;
  preparation = null;
  explicitCheck = 'not_needed';
  explicitFetchedUpdateId = null;
  checkCapExpired = false;
  capExpired = false;
  authReady = false;
  splashWindowElapsed = false;
  placeholderTookOver = false;
  placeholderPainted = false;
  settlingReload = false;
  reloadWindowClosed = false;
  newestEventContext = null;
}
