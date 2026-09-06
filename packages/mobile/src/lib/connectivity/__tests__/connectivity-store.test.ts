import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindConnectivityStore,
  createConnectivityStore,
  getConnectivitySnapshot,
  setOfflineMode,
  subscribeConnectivity,
  __resetConnectivityStoreForTests,
  type ConnectivityStoreHandle,
  type ConnectivityTransitionEvent,
  type DeviceReachability,
  type DeviceState,
  type ProbeVerdict,
} from '../connectivity-store';

// The machine behind issue #4862. Every seam is injected, so the whole matrix —
// backoff, jitter, blame attribution, the kill switch — is exercised against a
// fake clock rather than a phone.

type Deferred = { promise: Promise<ProbeVerdict>; resolve: (verdict: ProbeVerdict) => void };

function createDeferred(): Deferred {
  let resolve: (verdict: ProbeVerdict) => void = () => undefined;
  const promise = new Promise<ProbeVerdict>((resolveProbe) => {
    resolve = resolveProbe;
  });
  return { promise, resolve };
}

/** Drains the microtask queue by crossing a real macrotask boundary. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type ScheduledTask = { runAt: number; callback: () => void; done: boolean };

function createHarness(options?: { random?: number }) {
  let currentTime = 1_000;
  const tasks: ScheduledTask[] = [];
  const pendingProbes: Deferred[] = [];
  const onlineWrites: boolean[] = [];
  const transitions: ConnectivityTransitionEvent[] = [];
  const deviceReading: { device: DeviceState; deviceReachability: DeviceReachability } = {
    device: 'unknown',
    deviceReachability: 'unknown',
  };

  const probe = vi.fn((): Promise<ProbeVerdict> => {
    const deferred = createDeferred();
    pendingProbes.push(deferred);
    return deferred.promise;
  });
  const readDeviceState = vi.fn(() => Promise.resolve({ ...deviceReading }));

  const store = createConnectivityStore({
    now: () => currentTime,
    schedule: (callback, delayMs) => {
      const task: ScheduledTask = { runAt: currentTime + delayMs, callback, done: false };
      tasks.push(task);
      return () => {
        task.done = true;
      };
    },
    probe,
    readDeviceState,
    random: () => options?.random ?? 0.5,
    onOnlineChange: (online) => {
      onlineWrites.push(online);
    },
    onTransition: (event) => {
      transitions.push(event);
    },
  });

  return {
    store,
    probe,
    readDeviceState,
    onlineWrites,
    transitions,
    deviceReading,
    get time() {
      return currentTime;
    },
    pendingDelays(): number[] {
      return tasks.filter((task) => !task.done).map((task) => task.runAt - currentTime);
    },
    advance(ms: number): void {
      currentTime += ms;
      for (const task of tasks.filter((candidate) => !candidate.done && candidate.runAt <= currentTime)) {
        task.done = true;
        task.callback();
      }
    },
    async answerProbe(verdict: ProbeVerdict): Promise<void> {
      const deferred = pendingProbes.shift();
      if (!deferred) throw new Error('answerProbe called with no probe in flight');
      deferred.resolve(verdict);
      await flush();
      await flush();
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

/** Drive the store into a confirmed backend outage the short way. */
async function forceOutage(harness: Harness, verdict: ProbeVerdict = 'db_down'): Promise<void> {
  harness.store.setDeviceState('online', 'reachable', 'netinfo');
  harness.store.reportBackendOutcome({ kind: 'failure', status: 503 });
  await harness.answerProbe(verdict);
}

describe('connectivity store — derivation', () => {
  // Nothing is known yet, and refusing to talk to the server on a cold start
  // would strand the first fetch of every launch behind a native module.
  it('starts online', () => {
    const harness = createHarness();
    const snapshot = harness.store.getSnapshot();

    expect(snapshot.device).toBe('unknown');
    expect(snapshot.backend).toBe('unknown');
    expect(snapshot.effectiveOffline).toBe(false);
    expect(snapshot.reason).toBeNull();
    expect(harness.onlineWrites).toEqual([]);
  });

  it('a device with no network is offline, whatever the backend is doing', () => {
    const harness = createHarness();
    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');

    expect(harness.store.getSnapshot()).toMatchObject({ effectiveOffline: true, reason: 'device_offline' });
    expect(harness.onlineWrites).toEqual([false]);
  });

  it('offline mode wins over everything, because the climber chose it', () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.setOfflineMode(true, 'more');

    expect(harness.store.getSnapshot()).toMatchObject({ effectiveOffline: true, reason: 'offline_mode' });
  });

  it('a confirmed backend outage on a healthy phone is backend_unreachable, not device_offline', async () => {
    const harness = createHarness();
    await forceOutage(harness);

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'unreachable',
      backendVerdict: 'db_down',
      effectiveOffline: true,
      reason: 'backend_unreachable',
    });
  });

  // The blame rules that keep us from reporting every hotel wifi as Boardsesh
  // downtime.
  it('blames the device when a captive portal answered instead of our server', async () => {
    const harness = createHarness();
    await forceOutage(harness, 'captive_portal');

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'unreachable',
      deviceReachability: 'unreachable',
      reason: 'device_offline',
    });
  });

  it('blames the device for a transport verdict on an uplink NetInfo already calls dead', async () => {
    const harness = createHarness();
    harness.deviceReading.device = 'online';
    harness.deviceReading.deviceReachability = 'unreachable';
    await forceOutage(harness, 'transport');

    expect(harness.readDeviceState).toHaveBeenCalled();
    expect(harness.store.getSnapshot()).toMatchObject({ backend: 'unreachable', reason: 'device_offline' });
  });

  it('blames the backend for a transport verdict on an uplink that is answering fine', async () => {
    const harness = createHarness();
    harness.deviceReading.device = 'online';
    harness.deviceReading.deviceReachability = 'reachable';
    await forceOutage(harness, 'transport');

    expect(harness.store.getSnapshot()).toMatchObject({ backend: 'unreachable', reason: 'backend_unreachable' });
  });

  // The server answered. Whatever it said, it is up — failing the app closed
  // over a 404 or a 429 would be a bug of our own making.
  it.each<ProbeVerdict>(['healthy', 'answered_non_health'])('treats a %s verdict as reachable', async (verdict) => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'failure', status: 500 });
    await harness.answerProbe(verdict);

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'reachable',
      effectiveOffline: false,
      reason: null,
    });
  });
});

describe('connectivity store — the online sink', () => {
  it('mirrors !effectiveOffline and fires only when that bit actually flips', async () => {
    const harness = createHarness();

    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    expect(harness.onlineWrites).toEqual([]);

    await forceOutage(harness);
    expect(harness.onlineWrites).toEqual([false]);

    harness.store.reportBackendOutcome({ kind: 'success' });
    expect(harness.onlineWrites).toEqual([false, true]);
  });

  it('does not write on a repeat of the same device state', () => {
    const harness = createHarness();
    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');
    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');

    expect(harness.onlineWrites).toEqual([false]);
  });

  it('notifies subscribers on change and stops on unsubscribe', () => {
    const harness = createHarness();
    const listener = vi.fn();
    const unsubscribe = harness.store.subscribe(listener);

    harness.store.setDeviceState('offline', 'unknown', 'netinfo');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('connectivity store — probing policy', () => {
  it('probes on the first request failure while the backend is unknown', () => {
    const harness = createHarness();
    harness.store.reportBackendOutcome({ kind: 'failure', error: new Error('boom') });

    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.store.getSnapshot().consecutiveTransportFailures).toBe(1);
  });

  // One dead screen fires a dozen queries. Without the rate limit, the first
  // blip would put a dozen health probes on the wire at once.
  it('rate-limits failure-triggered probes to one per 10s while the backend still reads reachable', async () => {
    const harness = createHarness();
    harness.store.reportBackendOutcome({ kind: 'failure' });
    await harness.answerProbe('healthy');

    harness.advance(10_000);
    harness.store.reportBackendOutcome({ kind: 'failure' });
    harness.store.reportBackendOutcome({ kind: 'failure' });
    expect(harness.probe).toHaveBeenCalledTimes(2);

    await harness.answerProbe('healthy');
    harness.advance(10_000);
    harness.store.reportBackendOutcome({ kind: 'failure' });
    expect(harness.probe).toHaveBeenCalledTimes(3);
  });

  // A known outage already owns the next probe through its ladder; letting each
  // failing request start its own would replace the ladder with a stampede.
  it('does not probe per failing request once the outage is already known', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    harness.probe.mockClear();

    harness.store.reportBackendOutcome({ kind: 'failure', status: 503 });
    harness.store.reportBackendOutcome({ kind: 'failure', status: 503 });

    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('never probes while the device has no network', () => {
    const harness = createHarness();
    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'failure' });

    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('never probes while offline mode is on', () => {
    const harness = createHarness();
    harness.store.setOfflineMode(true, 'more');
    harness.store.reportBackendOutcome({ kind: 'failure' });

    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('never probes while detection is killed', () => {
    const harness = createHarness();
    harness.store.setDetectionEnabled(false);
    harness.store.reportBackendOutcome({ kind: 'failure' });

    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('joins an in-flight probe rather than starting a second', async () => {
    const harness = createHarness();
    const first = harness.store.retryNow();
    const second = harness.store.retryNow();

    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    await harness.answerProbe('healthy');
    await expect(first).resolves.toBe('reachable');
  });

  it('marks the snapshot as probing for the duration', async () => {
    const harness = createHarness();
    void harness.store.retryNow();
    expect(harness.store.getSnapshot().probing).toBe(true);

    await harness.answerProbe('healthy');
    expect(harness.store.getSnapshot().probing).toBe(false);
  });
});

describe('connectivity store — backoff ladder', () => {
  it('walks 5s, 10s, 20s, then holds at 30s', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    expect(harness.pendingDelays()).toEqual([5_000]);

    const observed: number[] = [];
    for (const step of [5_000, 10_000, 20_000, 30_000]) {
      harness.advance(step);
      await harness.answerProbe('db_down');
      observed.push(harness.pendingDelays()[0]);
    }

    expect(observed).toEqual([10_000, 20_000, 30_000, 30_000]);
  });

  it('jitters each rung by +/-25%, so a gym full of phones does not retry in lockstep', async () => {
    const low = createHarness({ random: 0 });
    await forceOutage(low);
    expect(low.pendingDelays()).toEqual([3_750]);

    const high = createHarness({ random: 1 });
    await forceOutage(high);
    expect(high.pendingDelays()).toEqual([6_250]);
  });

  it('stops the ladder while the app is backgrounded and restarts it on foreground', async () => {
    const harness = createHarness();
    await forceOutage(harness);

    harness.store.setAppActive(false);
    expect(harness.pendingDelays()).toEqual([]);

    harness.probe.mockClear();
    harness.store.setAppActive(true);
    expect(harness.probe).toHaveBeenCalledTimes(1);

    // Foregrounding resets the ladder: the climber is looking at the screen, so
    // the next automatic attempt is the short rung again, not the 30s tail.
    await harness.answerProbe('db_down');
    expect(harness.pendingDelays()).toEqual([5_000]);
  });

  it('cancels the ladder when the device drops off the network entirely', async () => {
    const harness = createHarness();
    await forceOutage(harness);

    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');
    expect(harness.pendingDelays()).toEqual([]);
  });

  it('probes immediately (ladder reset) when the device comes back mid-outage', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    harness.advance(5_000);
    await harness.answerProbe('db_down');
    expect(harness.pendingDelays()).toEqual([10_000]);

    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');
    harness.probe.mockClear();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');

    expect(harness.probe).toHaveBeenCalledTimes(1);
    await harness.answerProbe('db_down');
    expect(harness.pendingDelays()).toEqual([5_000]);
  });

  it('probes now when a dead upstream starts answering while the backend is down', async () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'unknown', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'failure', status: 503 });
    await harness.answerProbe('db_down');
    harness.probe.mockClear();

    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it('probes when a live uplink goes unreachable, to find out which side broke', () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'success' });
    harness.probe.mockClear();

    harness.store.setDeviceState('online', 'unreachable', 'netinfo');
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it('resets the ladder on an explicit retry', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    harness.advance(5_000);
    await harness.answerProbe('db_down');
    harness.advance(10_000);
    await harness.answerProbe('db_down');
    expect(harness.pendingDelays()).toEqual([20_000]);

    void harness.store.retryNow();
    await harness.answerProbe('db_down');
    expect(harness.pendingDelays()).toEqual([5_000]);
  });
});

describe('connectivity store — recovery', () => {
  it('discards a probe verdict that settles after a later request succeeded', async () => {
    const harness = createHarness();
    // One failed request starts a probe; before it answers, another request
    // gets through. The server is demonstrably up — a `db_down` from the older
    // probe must not flip the app offline on top of that fresher success.
    harness.store.reportBackendOutcome({ kind: 'failure', status: 500 });
    expect(harness.probe).toHaveBeenCalledTimes(1);
    harness.store.reportBackendOutcome({ kind: 'success' });

    await harness.answerProbe('db_down');

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'reachable',
      effectiveOffline: false,
      probing: false,
    });
    expect(harness.transitions).toEqual([]);
    expect(harness.pendingDelays()).toEqual([]);
  });

  it('recovers from a successful request without spending a probe', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    harness.probe.mockClear();
    // Stay inside the ladder's first rung (5 s): advancing past it would fire a
    // scheduled probe, and this case is about the RECOVERY not spending one.
    harness.advance(1_000);

    harness.store.reportBackendOutcome({ kind: 'success' });

    expect(harness.probe).not.toHaveBeenCalled();
    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'reachable',
      effectiveOffline: false,
      reason: null,
      consecutiveTransportFailures: 0,
      unreachableSince: null,
      lastRecoveredAt: harness.time,
    });
    expect(harness.pendingDelays()).toEqual([]);
  });

  // The seed edge carries no information — nothing had gone wrong to recover
  // from — and it would fire on the first successful request of EVERY launch on
  // every device, burying the outage series under one event per user per launch.
  it('reports nothing for the first successful request of a launch', () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');

    harness.store.reportBackendOutcome({ kind: 'success' });

    expect(harness.store.getSnapshot().backend).toBe('reachable');
    expect(harness.transitions).toEqual([]);
  });

  it('reports the first healthy probe of a launch as state, not as an event', async () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'failure', status: 500 });
    await harness.answerProbe('healthy');

    expect(harness.store.getSnapshot().backend).toBe('reachable');
    expect(harness.transitions).toEqual([]);
  });

  it('reports each real edge once, with how long the outage ran', async () => {
    const harness = createHarness();
    await forceOutage(harness);

    expect(harness.transitions).toHaveLength(1);
    expect(harness.transitions[0]).toMatchObject({
      from: 'unknown',
      to: 'unreachable',
      verdict: 'db_down',
      reason: 'backend_unreachable',
      trigger: 'failure',
      unreachableForMs: null,
    });

    harness.advance(90_000);
    harness.store.reportBackendOutcome({ kind: 'success' });

    expect(harness.transitions).toHaveLength(2);
    expect(harness.transitions[1]).toMatchObject({
      from: 'unreachable',
      to: 'reachable',
      unreachableForMs: 90_000,
    });
    expect(harness.transitions[1].snapshot.effectiveOffline).toBe(false);
  });

  it('does not re-report an outage that merely changes verdict', async () => {
    const harness = createHarness();
    await forceOutage(harness, 'db_down');
    harness.advance(5_000);
    await harness.answerProbe('edge');

    expect(harness.transitions).toHaveLength(1);
    expect(harness.store.getSnapshot().backendVerdict).toBe('edge');
  });

  it('does not churn the snapshot on every successful request', () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'success' });
    const listener = vi.fn();
    harness.store.subscribe(listener);

    harness.store.reportBackendOutcome({ kind: 'success' });
    harness.store.reportBackendOutcome({ kind: 'success' });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('connectivity store — offline mode, kill switch and dev override', () => {
  it('re-asks the server the moment offline mode is turned back off', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    harness.store.setOfflineMode(true, 'more');
    expect(harness.pendingDelays()).toEqual([]);
    harness.probe.mockClear();

    harness.store.setOfflineMode(false, 'banner');

    expect(harness.store.getSnapshot()).toMatchObject({ backend: 'unknown', effectiveOffline: false, reason: null });
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it('kill switch: forgets the outage entirely, so the app behaves as it did before #4862', async () => {
    const harness = createHarness();
    await forceOutage(harness);

    harness.store.setDetectionEnabled(false);

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'unknown',
      backendVerdict: null,
      effectiveOffline: false,
      reason: null,
    });
    expect(harness.pendingDelays()).toEqual([]);
  });

  it('kill switch does not hide a device that genuinely has no network', () => {
    const harness = createHarness();
    harness.store.setDetectionEnabled(false);
    harness.store.setDeviceState('offline', 'unreachable', 'netinfo');

    expect(harness.store.getSnapshot()).toMatchObject({ effectiveOffline: true, reason: 'device_offline' });
  });

  // A probe already on the wire when the switch goes off must not land its
  // verdict. Otherwise the kill switch does nothing for the outage in progress,
  // and flipping it back on adopts a stale conclusion nobody was allowed to act
  // on — taking the app offline at the exact moment someone tried to fix it.
  it('drops a verdict that arrives after the kill switch went off', async () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'failure', status: 503 });
    expect(harness.probe).toHaveBeenCalledTimes(1);

    harness.store.setDetectionEnabled(false);
    await harness.answerProbe('db_down');

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'unknown',
      backendVerdict: null,
      probing: false,
      effectiveOffline: false,
      reason: null,
    });
    expect(harness.transitions).toEqual([]);
    expect(harness.pendingDelays()).toEqual([]);
  });

  it('does not adopt that stale outage when the switch comes back on', async () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.reportBackendOutcome({ kind: 'failure', status: 503 });
    harness.store.setDetectionEnabled(false);
    await harness.answerProbe('db_down');

    harness.store.setDetectionEnabled(true);

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'unknown',
      backendVerdict: null,
      effectiveOffline: false,
      reason: null,
    });
  });

  it('dev override pins the outage against real traffic, and releasing it re-asks', () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    harness.store.setDevForcedUnreachable(true);

    expect(harness.store.getSnapshot()).toMatchObject({
      backend: 'unreachable',
      backendVerdict: 'db_down',
      effectiveOffline: true,
      reason: 'backend_unreachable',
    });

    harness.store.reportBackendOutcome({ kind: 'success' });
    expect(harness.store.getSnapshot().backend).toBe('unreachable');
    expect(harness.pendingDelays()).toEqual([]);

    harness.store.setDevForcedUnreachable(false);
    expect(harness.store.getSnapshot()).toMatchObject({ backend: 'unknown', effectiveOffline: false });
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it('dev override survives detection being off, since a tester needs the UI either way', () => {
    const harness = createHarness();
    harness.store.setDetectionEnabled(false);
    harness.store.setDevForcedUnreachable(true);

    expect(harness.store.getSnapshot()).toMatchObject({ effectiveOffline: true, reason: 'backend_unreachable' });
  });
});

describe('connectivity store — confirmBackendAvailability', () => {
  it('answers from a known outage without adding a probe per queued mutation', async () => {
    const harness = createHarness();
    await forceOutage(harness);
    harness.probe.mockClear();

    await expect(harness.store.confirmBackendAvailability()).resolves.toBe(false);
    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('probes once when the backend has not been checked yet', async () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');

    const confirmation = harness.store.confirmBackendAvailability();
    await harness.answerProbe('healthy');

    await expect(confirmation).resolves.toBe(true);
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it('joins a probe already in flight', async () => {
    const harness = createHarness();
    harness.store.setDeviceState('online', 'reachable', 'netinfo');
    void harness.store.retryNow();

    const confirmation = harness.store.confirmBackendAvailability();
    await harness.answerProbe('db_down');

    await expect(confirmation).resolves.toBe(false);
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });
});

describe('connectivity store — the process-wide singleton', () => {
  let boundStore: ConnectivityStoreHandle | null = null;

  beforeEach(() => {
    __resetConnectivityStoreForTests();
    boundStore = null;
  });

  afterEach(() => {
    __resetConnectivityStoreForTests();
  });

  it('publishes bound device state through the module-level readers', () => {
    boundStore = bindConnectivityStore({ onOnlineChange: vi.fn() });
    const listener = vi.fn();
    subscribeConnectivity(listener);

    boundStore.setDeviceState('offline', 'unreachable', 'netinfo');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getConnectivitySnapshot()).toMatchObject({ effectiveOffline: true, reason: 'device_offline' });
  });

  it('leaves offline mode inert on Expo web, which has no toggle to reach it', () => {
    bindConnectivityStore({ onOnlineChange: vi.fn(), offlineModeSupported: false });

    setOfflineMode(true, 'more');

    expect(getConnectivitySnapshot().offlineMode).toBe(false);
  });
});
