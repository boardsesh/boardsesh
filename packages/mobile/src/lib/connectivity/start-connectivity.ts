import { AppState, Platform, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { addErrorBreadcrumb } from '../error-reporting';
import {
  bindConnectivityStore,
  getConnectivitySnapshot,
  subscribeConnectivity,
  type ConnectivityStoreHandle,
  type ConnectivityTransitionEvent,
  type DeviceReachability,
  type DeviceState,
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
    // A native module that will not answer tells us nothing; the store keeps
    // whatever it already believed rather than inventing a disconnect.
    return { device: 'unknown', deviceReachability: 'unknown' };
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

export function startConnectivityStore(): void {
  if (started) return;
  started = true;

  handle = bindConnectivityStore({
    readDeviceState: readDeviceStateFromNetInfo,
    onTransition: reportBackendReachabilityTransition,
    // Expo web has no offline-mode surface (and no native storage to persist
    // one), so the toggle is inert there.
    offlineModeSupported: Platform.OS !== 'web',
  });

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

  NetInfo.addEventListener((state) => {
    const reading = readDeviceFromNetInfoState(state);
    handle?.setDeviceState(reading.device, reading.deviceReachability, 'netinfo');
  });

  if (Platform.OS !== 'web') {
    // The probe ladder must not run in a pocket. AppState has no web
    // equivalent worth wiring, and a browser tab is never "suspended" the way a
    // backgrounded app is.
    AppState.addEventListener('change', (status: AppStateStatus) => {
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

/** Test-only: re-arm the once-per-launch guard. */
export function __resetStartConnectivityForTests(): void {
  started = false;
  handle = null;
}
