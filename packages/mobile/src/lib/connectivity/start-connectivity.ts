import { AppState, Platform, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { addErrorBreadcrumb, reportHandledError } from '../error-reporting';
import { getSetting, setSetting, subscribeSettings } from '../../settings/hooks';
import {
  bindConnectivityStore,
  getConnectivitySnapshot,
  subscribeConnectivity,
  type ConnectivityStoreHandle,
  type ConnectivityTransitionEvent,
  type DeviceReachability,
  type DeviceState,
  type OfflineModeChange,
} from './connectivity-store';

/**
 * Binds the connectivity machine to the platform, exactly once per launch
 * (issue #4862). Called at module scope from `query-provider`, which is the app
 * root's single entry point for process-wide singletons.
 *
 * Everything react-native lives here so the consumers of the store — the
 * GraphQL client, the auth interceptor, the offline adapter, the analytics
 * super property — keep importing a pure module and never drag NetInfo or
 * AppState into their graphs (or their test suites).
 */

let started = false;
let handle: ConnectivityStoreHandle | null = null;

// Every long-lived subscription this module opens, so the test reset can close
// them. In the app they live for the launch and are never torn down; in a suite
// that starts and resets repeatedly, a discarded unsubscribe is a listener still
// holding a disposed handle and still being called on every NetInfo push,
// AppState change or settings write.
let unsubscribeNetInfo: (() => void) | null = null;
let unsubscribeSettings: (() => void) | null = null;
let appStateSubscription: { remove: () => void } | null = null;

type DeviceReading = { device: DeviceState; deviceReachability: DeviceReachability };

/**
 * NetInfo's two nullable booleans, kept as three-valued state rather than
 * collapsed to one. `null` is "not probed yet", NOT "no", and the store reads
 * `unknown` as online — which preserves exactly the `state.isConnected ?? true`
 * behaviour the query provider shipped before this module existed.
 */
export function readDeviceFromNetInfoState(
  state: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>,
): DeviceReading {
  const { isConnected, isInternetReachable } = state;

  let device: DeviceState = 'unknown';
  if (isConnected === true) device = 'online';
  if (isConnected === false) device = 'offline';

  let deviceReachability: DeviceReachability = 'unknown';
  if (isInternetReachable === true) deviceReachability = 'reachable';
  if (isInternetReachable === false) deviceReachability = 'unreachable';

  return { device, deviceReachability };
}

async function readDeviceStateFromNetInfo(): Promise<DeviceReading> {
  try {
    return readDeviceFromNetInfoState(await NetInfo.fetch());
  } catch {
    // A native module that will not answer tells us nothing new. Hand back what
    // the store already believes — an `unknown/unknown` reading here would be
    // taken as fresh information and erase a device state the live listener
    // had already established, right in the middle of blaming a transport
    // failure on one side or the other.
    const current = handle?.getSnapshot();
    return current
      ? { device: current.device, deviceReachability: current.deviceReachability }
      : { device: 'unknown', deviceReachability: 'unknown' };
  }
}

/**
 * ONE event per outage edge, not one per failed request. The whole point of the
 * store is that a dead backend produces a single state change instead of a
 * stream of identical query failures, so this is the event that makes "how many
 * climbers hit the outage, and for how long" answerable.
 */
function reportBackendReachabilityTransition(event: ConnectivityTransitionEvent): void {
  track(SHARED_EVENTS.BackendReachabilityChanged, {
    from: event.from,
    to: event.to,
    verdict: event.verdict,
    reason: event.reason,
    deviceState: event.snapshot.device,
    deviceReachability: event.snapshot.deviceReachability,
    unreachableForMs: event.unreachableForMs,
    trigger: event.trigger,
  });
  // Sentry keeps the trail rather than an issue: an outage is not a defect in
  // this app, but "the backend went away 40 seconds before this crash" is the
  // context that makes an unrelated report readable.
  addErrorBreadcrumb({
    category: 'connectivity',
    message: `backend ${event.from} -> ${event.to}`,
    level: event.to === 'unreachable' ? 'warning' : 'info',
    data: {
      verdict: event.verdict,
      reason: event.reason,
      trigger: event.trigger,
      unreachableForMs: event.unreachableForMs,
    },
  });
}

/**
 * Offline mode is a real device preference, not a session flag: a climber who
 * switches it on in the gym expects it to still be on tomorrow morning. The
 * store itself is pure TypeScript with no storage, so persistence lands here,
 * on the same callback that files the event — which is why the toggle's three
 * call sites (More, the banner, sign-out) each need to do neither.
 *
 * The write echoes straight back through `subscribeSettings` below. That is
 * harmless by construction: `seedOfflineMode` no-ops when the value already
 * matches, so the loop closes after one comparison.
 */
function persistAndReportOfflineMode(change: OfflineModeChange): void {
  try {
    setSetting('offlineMode', change.enabled);
  } catch (error) {
    // MMKV is a native module and can genuinely fail — a full disk, a corrupt
    // store. Swallowing that would be the worst of both: the switch moves, the
    // banner says offline mode is on, and the next launch quietly comes back
    // online with no record of why. Report it and keep going: the in-memory flip
    // is what the climber asked for, and it is honest for THIS launch.
    reportHandledError(error, { tags: { source: 'connectivity', kind: 'offline-mode-persist' } });
  }
  track(SHARED_EVENTS.OfflineModeToggled, {
    enabled: change.enabled,
    source: change.source,
    reasonBefore: change.reasonBefore,
  });
}

export function startConnectivityStore(): void {
  if (started) return;
  started = true;

  // Expo web has no offline-mode surface (and no native storage to persist one),
  // so the toggle — and everything below that keeps it in step with the stored
  // setting — is inert there.
  const offlineModeSupported = Platform.OS !== 'web';

  const boundStore = bindConnectivityStore({
    readDeviceState: readDeviceStateFromNetInfo,
    onTransition: reportBackendReachabilityTransition,
    onOfflineModeChange: offlineModeSupported ? persistAndReportOfflineMode : undefined,
    offlineModeSupported,
  });
  handle = boundStore;

  if (offlineModeSupported) {
    // Before anything else asks whether we are online. MMKV reads synchronously,
    // so a phone that was left in offline mode never gets the window where the
    // first screen of the launch fires the requests the climber switched off.
    boundStore.seedOfflineMode(getSetting('offlineMode'));
    // One listener for the whole settings store (there is no per-key registry),
    // so this re-reads one key on every settings write and compares. That covers
    // a write from outside the store — a reset-all, a future debug screen — and
    // absorbs the echo of our own `persistAndReportOfflineMode`. It lives for the
    // launch like the NetInfo listener below; the unsubscribe is kept only so the
    // test reset can close it.
    unsubscribeSettings = subscribeSettings(() => {
      boundStore.seedOfflineMode(getSetting('offlineMode'));
    });
  }

  // Seed before the first change event: the store starts at `unknown`, which
  // reads as online, and a genuinely offline cold start would otherwise fire a
  // doomed request per screen before NetInfo's first push arrived.
  void NetInfo.fetch()
    .then((state) => {
      const reading = readDeviceFromNetInfoState(state);
      handle?.setDeviceState(reading.device, reading.deviceReachability, 'seed');
    })
    .catch(() => {
      // The live listener below still delivers real state; nothing to report.
    });

  unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    const reading = readDeviceFromNetInfoState(state);
    handle?.setDeviceState(reading.device, reading.deviceReachability, 'netinfo');
  });

  if (Platform.OS !== 'web') {
    // The probe ladder must not run in a pocket. AppState has no web
    // equivalent worth wiring, and a browser tab is never "suspended" the way a
    // backgrounded app is.
    appStateSubscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      handle?.setAppActive(status === 'active');
    });
  }

  // The store is the single writer of React Query's online state, and this is
  // what makes that true on Expo web too: `setEventListener` REPLACES React
  // Query's default `navigator.onLine` listener, which would otherwise report a
  // browser that is connected to a network but not to our backend as online.
  onlineManager.setEventListener((setOnline) => {
    setOnline(!getConnectivitySnapshot().effectiveOffline);
    return subscribeConnectivity(() => setOnline(!getConnectivitySnapshot().effectiveOffline));
  });
}

/**
 * Test-only: re-arm the once-per-launch guard, and close every subscription the
 * previous start opened. Dropping the unsubscribes instead would leave each
 * suite's listeners stacked on the platform modules, all pointing at handles the
 * next reset disposed.
 */
export function __resetStartConnectivityForTests(): void {
  unsubscribeNetInfo?.();
  unsubscribeNetInfo = null;
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  started = false;
  handle = null;
}
