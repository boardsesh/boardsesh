import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The platform half of offline mode (PR-B): the store is pure, so persistence
// and the `Offline Mode Toggled` event only exist once this module binds them.
// Every seam react-native owns is mocked here, exactly as
// query-provider-connectivity.test.ts does for the same module.

const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

const settingsStore = vi.hoisted(() => ({
  offlineMode: false,
  listeners: [] as Array<() => void>,
  writes: [] as Array<{ key: string; value: unknown }>,
  // MMKV is a native module: a full disk or a corrupt store makes a write throw.
  failWrites: false,
}));

const reportHandledError = vi.hoisted(() => vi.fn());

const trackedEvents = vi.hoisted(() => [] as Array<{ name: string; properties: Record<string, unknown> }>);

// Counted, not just stubbed: `__resetStartConnectivityForTests` has to CLOSE
// every subscription a start opened, or each suite stacks listeners on the
// platform modules that all point at handles the next reset disposed.
const platformSubscriptions = vi.hoisted(() => ({ appStateRemovals: 0, netInfoRemovals: 0 }));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({
      remove: () => {
        platformSubscriptions.appStateRemovals += 1;
      },
    }),
  },
  Platform: platform,
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => {
      platformSubscriptions.netInfoRemovals += 1;
    },
    fetch: () => Promise.resolve({ isConnected: true, isInternetReachable: true }),
  },
}));

vi.mock('../../analytics', () => ({
  track: (name: string, properties: Record<string, unknown>) => {
    trackedEvents.push({ name, properties });
  },
}));

vi.mock('../../error-reporting', () => ({
  addErrorBreadcrumb: () => undefined,
  reportHandledError: (error: unknown, context?: unknown) => reportHandledError(error, context),
}));

// Turning offline mode OFF re-asks the server, and the store's default probe is
// a real `fetch` at BACKEND_URL. Answer it here so no test in this file puts a
// request on the wire.
vi.mock('../backend-reachability', () => ({
  probeBackend: () => Promise.resolve('healthy' as const),
  nextProbeDelayMs: () => 5_000,
}));

// A faithful stand-in for the MMKV store, including the part that matters most:
// a write notifies every subscriber SYNCHRONOUSLY, so the echo of our own
// persistence reaches the connectivity store inside the same tap.
vi.mock('../../../settings/hooks', () => ({
  getSetting: (key: string) => {
    if (key !== 'offlineMode') throw new Error(`unexpected settings read: ${key}`);
    return settingsStore.offlineMode;
  },
  setSetting: (key: string, value: unknown) => {
    if (settingsStore.failWrites) throw new Error('mmkv write failed');
    settingsStore.writes.push({ key, value });
    if (key === 'offlineMode') settingsStore.offlineMode = value === true;
    for (const listener of settingsStore.listeners) listener();
  },
  subscribeSettings: (listener: () => void) => {
    settingsStore.listeners.push(listener);
    return () => {
      settingsStore.listeners = settingsStore.listeners.filter((candidate) => candidate !== listener);
    };
  },
}));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getConnectivitySnapshot, setOfflineMode, __resetConnectivityStoreForTests } from '../connectivity-store';
import { startConnectivityStore, __resetStartConnectivityForTests } from '../start-connectivity';

/** The `setSetting` an unrelated screen would do — drives the subscription. */
function writeSettingFromElsewhere(offlineMode: boolean): void {
  settingsStore.offlineMode = offlineMode;
  for (const listener of settingsStore.listeners) listener();
}

function toggleEvents(): Array<Record<string, unknown>> {
  return trackedEvents
    .filter((event) => event.name === SHARED_EVENTS.OfflineModeToggled)
    .map(({ properties }) => properties);
}

describe('start-connectivity — offline mode', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    settingsStore.offlineMode = false;
    settingsStore.listeners = [];
    settingsStore.writes = [];
    settingsStore.failWrites = false;
    trackedEvents.length = 0;
    reportHandledError.mockClear();
    __resetConnectivityStoreForTests();
    __resetStartConnectivityForTests();
    // AFTER the resets: they close the previous test's subscriptions, and those
    // removals belong to that test, not this one.
    platformSubscriptions.appStateRemovals = 0;
    platformSubscriptions.netInfoRemovals = 0;
  });

  afterEach(() => {
    __resetConnectivityStoreForTests();
    __resetStartConnectivityForTests();
  });

  // The whole reason the setting exists: a climber who switched the phone
  // offline in the gym expects it to still be offline the next morning, with no
  // window where the first screen of the launch fires the requests they stopped.
  it('restores a persisted offline mode before anything else asks', () => {
    settingsStore.offlineMode = true;

    startConnectivityStore();

    expect(getConnectivitySnapshot()).toMatchObject({
      offlineMode: true,
      effectiveOffline: true,
      reason: 'offline_mode',
    });
    // Seeding is not a toggle: no event, and nothing written back.
    expect(toggleEvents()).toEqual([]);
    expect(settingsStore.writes).toEqual([]);
  });

  it('starts online when nothing was persisted', () => {
    startConnectivityStore();

    expect(getConnectivitySnapshot()).toMatchObject({ offlineMode: false, effectiveOffline: false, reason: null });
  });

  it('persists the flip and files exactly one event, with the source and the pre-flip reason', () => {
    startConnectivityStore();

    setOfflineMode(true, 'more');

    expect(settingsStore.writes).toEqual([{ key: 'offlineMode', value: true }]);
    expect(toggleEvents()).toEqual([{ enabled: true, source: 'more', reasonBefore: null }]);
    expect(getConnectivitySnapshot().offlineMode).toBe(true);
  });

  // The write echoes straight back through the settings subscription. If that
  // echo were treated as a fresh toggle, every tap would persist and report
  // twice — or spin.
  it('absorbs the echo of its own write instead of reporting it twice', () => {
    startConnectivityStore();

    setOfflineMode(true, 'more');

    expect(settingsStore.writes).toHaveLength(1);
    expect(toggleEvents()).toHaveLength(1);
  });

  it('mirrors a write made from outside the store', () => {
    startConnectivityStore();

    writeSettingFromElsewhere(true);

    expect(getConnectivitySnapshot()).toMatchObject({ offlineMode: true, reason: 'offline_mode' });
    // Not a toggle anybody made: nothing to attribute a source to.
    expect(toggleEvents()).toEqual([]);
  });

  it('carries the source through the banner and sign-out paths too', () => {
    startConnectivityStore();

    setOfflineMode(true, 'banner');
    setOfflineMode(false, 'sign_out');

    expect(toggleEvents()).toEqual([
      { enabled: true, source: 'banner', reasonBefore: null },
      { enabled: false, source: 'sign_out', reasonBefore: 'offline_mode' },
    ]);
    expect(settingsStore.writes).toEqual([
      { key: 'offlineMode', value: true },
      { key: 'offlineMode', value: false },
    ]);
  });

  // A silent failure here is the nastiest kind: the switch moves, the banner says
  // offline mode is on, and the next launch quietly comes back online with no
  // record of why. Keep the flip (the climber asked for it, and it is honest for
  // this launch) and file the write failure.
  it('reports a failed persist without undoing the flip', () => {
    startConnectivityStore();
    settingsStore.failWrites = true;

    setOfflineMode(true, 'more');

    expect(getConnectivitySnapshot()).toMatchObject({ offlineMode: true, reason: 'offline_mode' });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0]![1]).toMatchObject({
      tags: { source: 'connectivity', kind: 'offline-mode-persist' },
    });
    // Nothing landed on disk — which is exactly what the report is for.
    expect(settingsStore.offlineMode).toBe(false);
    // The event still goes out: the toggle happened, whatever storage did.
    expect(toggleEvents()).toEqual([{ enabled: true, source: 'more', reasonBefore: null }]);
  });

  // A listener kept past the reset would still fire on every later settings
  // write, driving a handle that was disposed two suites ago.
  it('closes every subscription it opened when the launch guard is re-armed', () => {
    startConnectivityStore();
    expect(settingsStore.listeners).toHaveLength(1);

    __resetStartConnectivityForTests();

    expect(settingsStore.listeners).toEqual([]);
    expect(platformSubscriptions.netInfoRemovals).toBe(1);
    expect(platformSubscriptions.appStateRemovals).toBe(1);
  });

  // Expo web has no offline catalog to fall back on and no native store behind
  // the switch, so the whole mechanism stays out of the way there — including
  // a value some earlier native session might have left in a shared store.
  it('is inert on Expo web', () => {
    platform.OS = 'web';
    settingsStore.offlineMode = true;

    startConnectivityStore();
    setOfflineMode(true, 'more');

    expect(getConnectivitySnapshot().offlineMode).toBe(false);
    expect(settingsStore.writes).toEqual([]);
    expect(settingsStore.listeners).toEqual([]);
    expect(toggleEvents()).toEqual([]);
  });
});
