import { onlineManager } from '@tanstack/react-query';
import { nextProbeDelayMs, probeBackend, type ProbeVerdict } from './backend-reachability';

// Declared next to the probe that produces it (so `backend-reachability` needs
// no import from here and the two files can never form a cycle), re-exported
// here because every consumer reads it off a snapshot.
export type { ProbeVerdict };

/**
 * The connectivity state machine (issue #4862).
 *
 * Until this existed the app had exactly ONE connectivity signal — React
 * Query's `onlineManager`, seeded from NetInfo's `isConnected` — and a dead
 * backend reads "online" on that signal all day. So an outage looked like a
 * broken app: spinners that never settle, "something went wrong" toasts, a
 * Sentry issue per query, and nothing anywhere that said the server was down.
 *
 * This module owns the answer to three separate questions that the old single
 * boolean conflated:
 *
 *   device   — does this phone have a network attached (NetInfo `isConnected`)?
 *   device   — does that network reach the internet (NetInfo
 *   reachability   `isInternetReachable`)? Gym wifi with a dead upstream is
 *                  `isConnected: true` all the way down.
 *   backend  — does OUR server answer? Confirmed by request outcomes, and by a
 *              `GET /health/db` probe on a backoff ladder while it does not.
 *
 * PURE TypeScript on purpose: no react-native, no NetInfo, no analytics. Every
 * piece of I/O — the clock, timers, the probe, the device read, the online
 * sink, the telemetry sink — is injected, which is what makes the whole matrix
 * of transitions testable with a fake clock instead of a phone. The platform
 * seams are bound exactly once, from `start-connectivity.ts`.
 */

export type ConnectivityReason = 'offline_mode' | 'device_offline' | 'backend_unreachable';

export type DeviceState = 'online' | 'offline' | 'unknown';
export type DeviceReachability = 'reachable' | 'unreachable' | 'unknown';
export type BackendState = 'reachable' | 'unreachable' | 'unknown';

/** Where a change to offline mode came from. Carried for telemetry only. */
export type OfflineModeSource = 'more' | 'banner' | 'sign_out';

/**
 * What moved the machine. Read as the CHANNEL, not the polarity: `failure` is
 * the request-outcome channel (`reportBackendOutcome`), so a recovery confirmed
 * by a request that finally succeeded also arrives with `failure`.
 */
export type ConnectivityTransitionTrigger =
  | 'failure'
  | 'timer'
  | 'foreground'
  | 'netinfo'
  | 'retry'
  | 'offline_mode_off'
  | 'dev_override'
  | 'seed';

export type ConnectivitySnapshot = {
  device: DeviceState;
  deviceReachability: DeviceReachability;
  backend: BackendState;
  backendVerdict: ProbeVerdict | null;
  probing: boolean;
  offlineMode: boolean;
  detectionEnabled: boolean;
  devForcedUnreachable: boolean;
  consecutiveTransportFailures: number;
  unreachableSince: number | null;
  lastRecoveredAt: number | null;
  effectiveOffline: boolean;
  reason: ConnectivityReason | null;
};

/**
 * How a real request to the backend ended. `success` means the server answered
 * at all — a 400 or a 401 is a success here, because the question is
 * reachability, not whether the caller liked the answer.
 */
export type BackendOutcome = { kind: 'success' } | { kind: 'failure'; error?: unknown; status?: number | null };

export type ConnectivityTransitionEvent = {
  from: BackendState;
  to: BackendState;
  verdict: ProbeVerdict | null;
  reason: ConnectivityReason | null;
  trigger: ConnectivityTransitionTrigger;
  unreachableForMs: number | null;
  snapshot: ConnectivitySnapshot;
};

export type ConnectivityStoreDeps = {
  now: () => number;
  /** Schedules `callback`; the returned function cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
  /** One `/health/db` round trip. Must resolve a verdict rather than throw. */
  probe: () => Promise<ProbeVerdict>;
  readDeviceState: () => Promise<{ device: DeviceState; deviceReachability: DeviceReachability }>;
  /** Jitter source for the probe backoff. */
  random: () => number;
  /** The ONE place React Query's `onlineManager.setOnline` is called. */
  onOnlineChange: (online: boolean) => void;
  onTransition?: (event: ConnectivityTransitionEvent) => void;
};

export type ConnectivityStoreHandle = {
  getSnapshot: () => ConnectivitySnapshot;
  subscribe: (listener: () => void) => () => void;
  setDeviceState: (
    device: DeviceState,
    deviceReachability: DeviceReachability,
    trigger: ConnectivityTransitionTrigger,
  ) => void;
  reportBackendOutcome: (outcome: BackendOutcome) => void;
  retryNow: () => Promise<BackendState>;
  confirmBackendAvailability: () => Promise<boolean>;
  setAppActive: (active: boolean) => void;
  setOfflineMode: (enabled: boolean, source: OfflineModeSource) => void;
  setDetectionEnabled: (enabled: boolean) => void;
  setDevForcedUnreachable: (forced: boolean) => void;
  dispose: () => void;
};

// At most one failure-triggered probe per 10s while the backend still reads
// reachable. A single dead screen can fire a dozen queries; without this, the
// first blip would put a dozen health probes on the wire at once.
const FAILURE_PROBE_MIN_INTERVAL_MS = 10_000;

type MutableState = {
  device: DeviceState;
  deviceReachability: DeviceReachability;
  backend: BackendState;
  backendVerdict: ProbeVerdict | null;
  probing: boolean;
  offlineMode: boolean;
  detectionEnabled: boolean;
  devForcedUnreachable: boolean;
  consecutiveTransportFailures: number;
  unreachableSince: number | null;
  lastRecoveredAt: number | null;
};

/**
 * `unknown` reads as ONLINE on both axes. That is deliberate and matches what
 * the app did before this module existed: a cold start knows nothing, and
 * refusing to talk to the server until NetInfo answers would strand the first
 * fetch of every launch behind a native module.
 */
function deriveEffectiveOffline(state: MutableState): boolean {
  if (state.offlineMode) return true;
  if (state.device === 'offline') return true;
  const backendCounts = state.detectionEnabled || state.devForcedUnreachable;
  return backendCounts && state.backend === 'unreachable';
}

/**
 * WHO is down, in the order the user cares about. The two backend carve-outs
 * both exist so we never accuse our own server of an outage the phone caused:
 * a captive portal answered instead of us, and a probe that reached nothing at
 * all on an uplink NetInfo already calls dead is the uplink's fault.
 */
function deriveReason(state: MutableState): ConnectivityReason | null {
  if (state.offlineMode) return 'offline_mode';
  if (state.device === 'offline') return 'device_offline';
  const backendCounts = state.detectionEnabled || state.devForcedUnreachable;
  if (!backendCounts || state.backend !== 'unreachable') return null;
  if (state.backendVerdict === 'captive_portal') return 'device_offline';
  if (state.backendVerdict === 'transport' && state.deviceReachability !== 'reachable') return 'device_offline';
  return 'backend_unreachable';
}

function deriveSnapshot(state: MutableState): ConnectivitySnapshot {
  return {
    device: state.device,
    deviceReachability: state.deviceReachability,
    backend: state.backend,
    backendVerdict: state.backendVerdict,
    probing: state.probing,
    offlineMode: state.offlineMode,
    detectionEnabled: state.detectionEnabled,
    devForcedUnreachable: state.devForcedUnreachable,
    consecutiveTransportFailures: state.consecutiveTransportFailures,
    unreachableSince: state.unreachableSince,
    lastRecoveredAt: state.lastRecoveredAt,
    effectiveOffline: deriveEffectiveOffline(state),
    reason: deriveReason(state),
  };
}

function snapshotsEqual(left: ConnectivitySnapshot, right: ConnectivitySnapshot): boolean {
  return (
    left.device === right.device &&
    left.deviceReachability === right.deviceReachability &&
    left.backend === right.backend &&
    left.backendVerdict === right.backendVerdict &&
    left.probing === right.probing &&
    left.offlineMode === right.offlineMode &&
    left.detectionEnabled === right.detectionEnabled &&
    left.devForcedUnreachable === right.devForcedUnreachable &&
    left.consecutiveTransportFailures === right.consecutiveTransportFailures &&
    left.unreachableSince === right.unreachableSince &&
    left.lastRecoveredAt === right.lastRecoveredAt &&
    left.effectiveOffline === right.effectiveOffline &&
    left.reason === right.reason
  );
}

export function createConnectivityStore(deps: ConnectivityStoreDeps): ConnectivityStoreHandle {
  const state: MutableState = {
    device: 'unknown',
    deviceReachability: 'unknown',
    backend: 'unknown',
    backendVerdict: null,
    probing: false,
    offlineMode: false,
    detectionEnabled: true,
    devForcedUnreachable: false,
    consecutiveTransportFailures: 0,
    unreachableSince: null,
    lastRecoveredAt: null,
  };

  const listeners = new Set<() => void>();
  let currentSnapshot = deriveSnapshot(state);
  let cancelProbeTimerCallback: (() => void) | null = null;
  let inFlightProbe: Promise<BackendState> | null = null;
  let probeAttempt = 0;
  let lastFailureProbeAt: number | null = null;
  let appActive = true;
  let disposed = false;

  function publish(): void {
    const next = deriveSnapshot(state);
    if (snapshotsEqual(next, currentSnapshot)) return;
    const onlineChanged = next.effectiveOffline !== currentSnapshot.effectiveOffline;
    currentSnapshot = next;
    // React Query first: a component re-rendered by the listeners below may read
    // `onlineManager.isOnline()` on that very render, and it must not see the
    // value we are in the middle of replacing.
    if (onlineChanged) {
      try {
        deps.onOnlineChange(!next.effectiveOffline);
      } catch (error) {
        if (__DEV__) console.warn('[connectivity] online sink threw', error);
      }
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        // One bad subscriber must not wedge connectivity for every other one.
        if (__DEV__) console.warn('[connectivity] subscriber threw', error);
      }
    }
  }

  function emitTransition(
    from: BackendState,
    to: BackendState,
    verdict: ProbeVerdict | null,
    trigger: ConnectivityTransitionTrigger,
    unreachableForMs: number | null,
  ): void {
    try {
      deps.onTransition?.({
        from,
        to,
        verdict,
        reason: currentSnapshot.reason,
        trigger,
        unreachableForMs,
        snapshot: currentSnapshot,
      });
    } catch (error) {
      if (__DEV__) console.warn('[connectivity] transition sink threw', error);
    }
  }

  function cancelProbeTimer(): void {
    if (!cancelProbeTimerCallback) return;
    cancelProbeTimerCallback();
    cancelProbeTimerCallback = null;
  }

  function scheduleNextProbe(): void {
    cancelProbeTimer();
    if (disposed) return;
    // Pinned by the dev override: a probe cannot change the answer, so running
    // one forever would be pure noise on the wire.
    if (state.devForcedUnreachable) return;
    if (state.backend !== 'unreachable') return;
    // A backgrounded app, a phone with no network, an explicit offline mode, or
    // the kill switch: nothing to poll for, and polling would burn battery in a
    // pocket.
    if (!appActive || state.device === 'offline' || state.offlineMode || !state.detectionEnabled) return;

    try {
      const delayMs = nextProbeDelayMs(probeAttempt, deps.random);
      probeAttempt += 1;
      cancelProbeTimerCallback = deps.schedule(() => {
        cancelProbeTimerCallback = null;
        void runProbe('timer');
      }, delayMs);
    } catch (error) {
      // A throwing scheduler must not escape as an unhandled rejection: most
      // paths reach here through `void runProbe(...)`, which has nobody to catch
      // for it. We lose this rung; the next request failure, foreground or
      // reconnect re-arms the ladder.
      cancelProbeTimerCallback = null;
      if (__DEV__) console.warn('[connectivity] probe scheduler threw', error);
    }
  }

  function markBackendReachable(verdict: ProbeVerdict | null, trigger: ConnectivityTransitionTrigger): void {
    const previousBackend = state.backend;
    const outageStartedAt = previousBackend === 'unreachable' ? state.unreachableSince : null;
    const unreachableForMs = outageStartedAt === null ? null : deps.now() - outageStartedAt;

    state.backend = 'reachable';
    state.backendVerdict = verdict;
    state.consecutiveTransportFailures = 0;
    state.unreachableSince = null;
    probeAttempt = 0;
    cancelProbeTimer();
    if (previousBackend === 'unreachable') state.lastRecoveredAt = deps.now();

    publish();
    // Only a real RECOVERY is an edge worth reporting. `unknown → reachable` is
    // the SEED: it fires on the first successful request of every launch, on
    // every device, so emitting it would bury the outage series under one event
    // per user per launch — and it carries no information, because nothing had
    // gone wrong to recover from.
    if (previousBackend === 'unreachable') {
      emitTransition(previousBackend, 'reachable', verdict, trigger, unreachableForMs);
    }
  }

  function markBackendUnreachable(verdict: ProbeVerdict, trigger: ConnectivityTransitionTrigger): void {
    const previousBackend = state.backend;
    if (previousBackend !== 'unreachable') state.unreachableSince = deps.now();
    state.backend = 'unreachable';
    state.backendVerdict = verdict;

    publish();
    if (previousBackend !== 'unreachable') {
      emitTransition(previousBackend, 'unreachable', verdict, trigger, null);
    }
    scheduleNextProbe();
  }

  async function applyProbeVerdict(verdict: ProbeVerdict, trigger: ConnectivityTransitionTrigger): Promise<void> {
    // Whatever happens below, this probe is over: leaving `probing` true on an
    // early return would strand a "checking…" spinner for the rest of the launch.
    const abandonProbe = (): void => {
      state.probing = false;
      if (!disposed) publish();
    };

    // Pinned by the dev override, or the kill switch flipped while this probe
    // was in flight. Landing the verdict now would take the app offline on a
    // conclusion one of them just forbade — and would leave that stale verdict
    // sitting on the state for the moment the switch goes back on.
    if (disposed || state.devForcedUnreachable || !state.detectionEnabled) {
      abandonProbe();
      return;
    }

    if (verdict === 'transport') {
      // Nothing answered, which is equally "the server is gone" and "this phone
      // has no working uplink". Only the device can break that tie, so re-read
      // it before anyone gets blamed — `deriveReason` turns a dead uplink into
      // `device_offline` rather than a backend outage.
      try {
        const device = await deps.readDeviceState();
        state.device = device.device;
        state.deviceReachability = device.deviceReachability;
      } catch {
        // A failed read is not new information; keep the last known state.
      }
      // Both guards can flip during that read — it is the one await left here.
      if (disposed || !state.detectionEnabled) {
        abandonProbe();
        return;
      }
    }

    if (verdict === 'captive_portal') {
      // Something answered under our URL and it was not us. That is a hijacked
      // uplink, and NetInfo's own probe often has not noticed yet.
      state.deviceReachability = 'unreachable';
    }

    state.probing = false;

    // A server that answered is a server that is up, whatever it answered.
    if (verdict === 'healthy' || verdict === 'answered_non_health') {
      markBackendReachable(verdict, trigger);
      return;
    }
    markBackendUnreachable(verdict, trigger);
  }

  function runProbe(trigger: ConnectivityTransitionTrigger): Promise<BackendState> {
    const existing = inFlightProbe;
    if (existing) return existing;
    if (disposed) return Promise.resolve(state.backend);

    cancelProbeTimer();
    state.probing = true;
    publish();

    const probe = (async (): Promise<BackendState> => {
      let verdict: ProbeVerdict;
      try {
        verdict = await deps.probe();
      } catch {
        // `probeBackend` resolves every failure as a verdict, but an injected
        // double may not — and a probe that could not even run is the same fact
        // as one nothing answered.
        verdict = 'transport';
      }
      try {
        await applyProbeVerdict(verdict, trigger);
      } finally {
        // Only one probe is ever in flight (this function returns the existing
        // one instead of starting a second), so this can clear unconditionally.
        inFlightProbe = null;
      }
      return state.backend;
    })();

    inFlightProbe = probe;
    return probe;
  }

  function setDeviceState(
    device: DeviceState,
    deviceReachability: DeviceReachability,
    trigger: ConnectivityTransitionTrigger,
  ): void {
    if (disposed) return;
    const previousDevice = state.device;
    const previousReachability = state.deviceReachability;
    state.device = device;
    state.deviceReachability = deviceReachability;
    publish();

    if (device === 'offline') {
      // No uplink: the probe would fail for a reason that says nothing about
      // the server, so stop asking until there is one.
      cancelProbeTimer();
      return;
    }

    const cameBack = previousDevice === 'offline';
    const upstreamStartedAnswering = previousReachability !== 'reachable' && deviceReachability === 'reachable';
    if (state.backend === 'unreachable' && (cameBack || upstreamStartedAnswering)) {
      // The phone's side just changed for the better. Ask now rather than
      // waiting out a ladder that was timed for a server outage.
      probeAttempt = 0;
      void runProbe(trigger);
      return;
    }

    const upstreamWentDead = previousReachability !== 'unreachable' && deviceReachability === 'unreachable';
    if (state.backend !== 'unreachable' && upstreamWentDead) {
      // Captive portal, or a link whose upstream just died. Find out which side
      // is actually broken instead of waiting for a user request to discover it.
      void runProbe(trigger);
      return;
    }

    // Re-arm a ladder that a spell offline cancelled. Guarded so it can never
    // double-schedule on top of a live timer or a probe already in flight.
    if (state.backend === 'unreachable' && cancelProbeTimerCallback === null && inFlightProbe === null) {
      scheduleNextProbe();
    }
  }

  function reportBackendOutcome(outcome: BackendOutcome): void {
    if (disposed) return;
    // Pinned by the dev override: real traffic must not lift the simulation.
    if (state.devForcedUnreachable) return;

    if (outcome.kind === 'success') {
      // A request the server actually answered is the cheapest recovery signal
      // there is — no probe needed. Keeping the existing verdict when we were
      // already reachable is what stops every successful request from churning
      // the snapshot (and re-rendering every subscriber).
      markBackendReachable(state.backend === 'reachable' ? state.backendVerdict : null, 'failure');
      return;
    }

    state.consecutiveTransportFailures += 1;
    publish();

    if (state.offlineMode || state.device === 'offline' || !state.detectionEnabled) return;
    // A known outage already owns the next probe through its backoff ladder.
    // Letting each failing request start its own would replace the ladder with a
    // stampede, exactly when the server can least afford one.
    if (state.backend === 'unreachable') return;

    const now = deps.now();
    if (
      state.backend === 'reachable' &&
      lastFailureProbeAt !== null &&
      now - lastFailureProbeAt < FAILURE_PROBE_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastFailureProbeAt = now;
    void runProbe('failure');
  }

  function retryNow(): Promise<BackendState> {
    if (disposed || state.devForcedUnreachable) return Promise.resolve(state.backend);
    // A deliberate tap resets the ladder: the climber is telling us to stop
    // waiting, and the next automatic attempt should be the short rung again.
    probeAttempt = 0;
    return runProbe('retry');
  }

  async function confirmBackendAvailability(): Promise<boolean> {
    // Read through a closure so the answer reflects the snapshot AFTER an
    // awaited probe — TypeScript would otherwise narrow `state.backend` on the
    // early-return guard below and hold that narrowing across the await.
    const backendUsable = (): boolean => state.backend !== 'unreachable';
    if (disposed || state.devForcedUnreachable) return backendUsable();

    const existing = inFlightProbe;
    if (existing) {
      await existing;
      return backendUsable();
    }
    // A known outage already owns the next probe; a device with no uplink or a
    // climber in offline mode has nothing to confirm. Answer from what we know
    // rather than putting a probe behind every queued mutation.
    if (state.backend === 'unreachable' || state.device === 'offline' || state.offlineMode) {
      return backendUsable();
    }

    await runProbe('retry');
    return backendUsable();
  }

  function setAppActive(active: boolean): void {
    if (disposed || appActive === active) return;
    appActive = active;
    if (!active) {
      cancelProbeTimer();
      return;
    }
    if (state.backend === 'unreachable' && !state.offlineMode && state.device !== 'offline') {
      // Foregrounding is the moment a climber is looking at the screen, so it is
      // worth one immediate probe and a fresh ladder rather than the tail delay
      // the app was suspended on.
      probeAttempt = 0;
      void runProbe('foreground');
    }
  }

  // `_source` is carried by the type (not used here) so the toggle's telemetry
  // and PR-B's persistence both read it off ONE call, rather than every caller
  // remembering to emit its own event.
  function setOfflineMode(enabled: boolean, _source: OfflineModeSource): void {
    if (disposed || state.offlineMode === enabled) return;
    state.offlineMode = enabled;
    if (!enabled) {
      // Leaving offline mode: nothing we believed about the server while nobody
      // was talking to it is worth keeping, so start from "unknown" and ask.
      // Reset before publishing so subscribers never see the intermediate frame
      // where the toggle is off but a stale outage still reads offline.
      state.backend = 'unknown';
      state.backendVerdict = null;
      state.unreachableSince = null;
      probeAttempt = 0;
    }
    publish();
    if (enabled) {
      cancelProbeTimer();
      return;
    }
    // Guarded like the ladder itself: with no uplink, or with detection killed,
    // there is nothing a probe could tell us.
    if (state.device !== 'offline' && state.detectionEnabled) void runProbe('offline_mode_off');
  }

  function setDetectionEnabled(enabled: boolean): void {
    if (disposed || state.detectionEnabled === enabled) return;
    state.detectionEnabled = enabled;
    // Reset on BOTH edges. Off is the kill switch: everything the probes
    // concluded goes with it, so the app behaves exactly as it did before this
    // module existed. On is the same reset for the opposite reason — anything
    // still on the state was concluded while nobody was allowed to act on it
    // (a probe already in flight can still land), and adopting a stale outage
    // would take the app offline the instant the switch came back.
    state.backend = 'unknown';
    state.backendVerdict = null;
    state.unreachableSince = null;
    state.consecutiveTransportFailures = 0;
    probeAttempt = 0;
    cancelProbeTimer();
    publish();
  }

  function setDevForcedUnreachable(forced: boolean): void {
    if (disposed || state.devForcedUnreachable === forced) return;
    state.devForcedUnreachable = forced;

    if (forced) {
      const previousBackend = state.backend;
      if (previousBackend !== 'unreachable') state.unreachableSince = deps.now();
      state.backend = 'unreachable';
      state.backendVerdict = 'db_down';
      cancelProbeTimer();
      publish();
      if (previousBackend !== 'unreachable') {
        emitTransition(previousBackend, 'unreachable', 'db_down', 'dev_override', null);
      }
      return;
    }

    // Released: the simulated outage told us nothing about the real server.
    state.backend = 'unknown';
    state.backendVerdict = null;
    state.unreachableSince = null;
    probeAttempt = 0;
    publish();
    void runProbe('dev_override');
  }

  return {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDeviceState,
    reportBackendOutcome,
    retryNow,
    confirmBackendAvailability,
    setAppActive,
    setOfflineMode,
    setDetectionEnabled,
    setDevForcedUnreachable,
    dispose: () => {
      disposed = true;
      cancelProbeTimer();
      inFlightProbe = null;
      listeners.clear();
    },
  };
}

// ── The process-wide singleton ────────────────────────────────────────────────
//
// Consumers (the GraphQL client, the auth interceptor, the offline adapter, the
// analytics super property) import the functions below and nothing else, which
// is what keeps react-native and NetInfo out of their module graphs. The
// platform seams are bound once, by `start-connectivity.ts`.

export type ConnectivityStoreBindings = Partial<ConnectivityStoreDeps> & {
  /** Expo web has no offline-mode surface, so `setOfflineMode` is inert there. */
  offlineModeSupported?: boolean;
};

let bindings: ConnectivityStoreBindings = {};
let singleton: ConnectivityStoreHandle | null = null;

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function defaultOnOnlineChange(online: boolean): void {
  onlineManager.setOnline(online);
}

/**
 * Without a platform binding there is no device to read, and answering
 * "unknown" would ERASE a confirmed-offline device on the transport path. Hand
 * back what we already believe instead.
 */
function defaultReadDeviceState(): Promise<{ device: DeviceState; deviceReachability: DeviceReachability }> {
  const snapshot = singleton?.getSnapshot();
  return Promise.resolve({
    device: snapshot?.device ?? 'unknown',
    deviceReachability: snapshot?.deviceReachability ?? 'unknown',
  });
}

// Late-bound rather than captured: a consumer can read the store at module load,
// before the app root has started it, and the binding must still land on the
// same instance instead of quietly creating a second one.
const lateBoundDeps: ConnectivityStoreDeps = {
  now: () => (bindings.now ? bindings.now() : Date.now()),
  schedule: (callback, delayMs) =>
    bindings.schedule ? bindings.schedule(callback, delayMs) : defaultSchedule(callback, delayMs),
  probe: () => (bindings.probe ? bindings.probe() : probeBackend()),
  readDeviceState: () => (bindings.readDeviceState ? bindings.readDeviceState() : defaultReadDeviceState()),
  random: () => (bindings.random ? bindings.random() : Math.random()),
  onOnlineChange: (online) =>
    bindings.onOnlineChange ? bindings.onOnlineChange(online) : defaultOnOnlineChange(online),
  onTransition: (event) => bindings.onTransition?.(event),
};

function store(): ConnectivityStoreHandle {
  if (!singleton) singleton = createConnectivityStore(lateBoundDeps);
  return singleton;
}

/**
 * Binds the platform seams and hands back the singleton. Called exactly once,
 * from `startConnectivityStore()`; the handle is how that module pushes NetInfo
 * and AppState changes in.
 */
export function bindConnectivityStore(platformBindings: ConnectivityStoreBindings): ConnectivityStoreHandle {
  bindings = platformBindings;
  return store();
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  return store().getSnapshot();
}

export function subscribeConnectivity(listener: () => void): () => void {
  return store().subscribe(listener);
}

/** Probe now — the "Try again" tap. Resets the backoff ladder. */
export function retryConnectivityNow(): Promise<BackendState> {
  return store().retryNow();
}

/** Deduped probe; true when the backend is not known to be unreachable after it. */
export function confirmBackendAvailability(): Promise<boolean> {
  return store().confirmBackendAvailability();
}

export function reportBackendOutcome(outcome: BackendOutcome): void {
  store().reportBackendOutcome(outcome);
}

/** Re-read the device from the platform and feed it in. */
export async function refreshDeviceState(): Promise<void> {
  try {
    const device = await lateBoundDeps.readDeviceState();
    store().setDeviceState(device.device, device.deviceReachability, 'netinfo');
  } catch {
    // A failed read is not new information — keep the last known device state.
  }
}

/** The `backend-outage-detection` kill switch (see ConnectivityBridge). */
export function setOutageDetectionEnabled(enabled: boolean): void {
  store().setDetectionEnabled(enabled);
}

/** Tester-only: pin the backend to unreachable to see the degraded UI. */
export function setDevForcedUnreachable(forced: boolean): void {
  store().setDevForcedUnreachable(forced);
}

/** In-memory for PR-A; PR-B persists it. Inert on Expo web, which has no toggle. */
export function setOfflineMode(enabled: boolean, source: OfflineModeSource): void {
  if (bindings.offlineModeSupported === false) return;
  store().setOfflineMode(enabled, source);
}

export function __resetConnectivityStoreForTests(): void {
  singleton?.dispose();
  singleton = null;
  bindings = {};
}
