import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UART_WRITE_CHARACTERISTIC_UUID } from '@boardsesh/ble-protocol/transport';

type ScanCallback = (error: unknown, device: { id: string; localName?: string; rssi?: number } | null) => void;

const radio = vi.hoisted(() => ({
  permitted: true,
  poweredOn: true,
  appState: null as ((next: string) => void) | null,
  timers: [] as { callback: () => void; cancelled: boolean; delay: number }[],
  scan: null as ScanCallback | null,
  disconnects: new Map<string, () => void>(),
  failing: new Set<string>(),
  storage: new Map<string, unknown>(),
}));

function fakeDevice(id: string) {
  const write = vi.fn(async () => undefined);
  const device = {
    id,
    mtu: 247,
    write,
    requestMTU: async () => device,
    discoverAllServicesAndCharacteristics: async () => device,
    characteristicsForService: async () => [{ uuid: UART_WRITE_CHARACTERISTIC_UUID, writeWithResponse: write }],
  };
  return device;
}

const manager = vi.hoisted(() => ({
  connectToDevice: vi.fn(),
  cancelDeviceConnection: vi.fn(async () => undefined),
  onDeviceDisconnected: vi.fn(),
  startDeviceScan: vi.fn(),
  stopDeviceScan: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      radio.appState = listener;
      return { remove: () => (radio.appState = null) };
    },
  },
}));
vi.mock('../../ble/ble-manager', () => ({ getBleManager: () => manager }));
vi.mock('../../ble/availability', () => ({ waitForBlePoweredOn: async () => radio.poweredOn }));
vi.mock('../../ble/use-ble-permissions', () => ({ requestBleRuntimePermissions: async () => radio.permitted }));
vi.mock('../../ble/background-safe-timeout', () => ({
  setBackgroundSafeTimeout: (callback: () => void, delay: number) => {
    const timer = { callback, cancelled: false, delay };
    radio.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  },
}));
vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => radio.storage.get(key) ?? null,
  setPreference: async (key: string, value: unknown) => {
    radio.storage.set(key, value);
  },
  removePreference: async (key: string) => {
    radio.storage.delete(key);
  },
  removePreferencesMatching: async () => undefined,
}));

import { currentBleScanOwner, noteBleScanStarted, releaseBleScan } from '../../ble/ble-scan-slot';
import {
  SPRAY_LED_BLE_IDLE_MS,
  rememberSprayLedController,
  resetSprayLedBleTransportForTests,
  scanForSprayLedControllers,
  sprayLedBleTransport,
} from '../spray-led-ble-transport';

const NAME = 'Boardsesh Spraywall 1A2B';
const ID_KEY = `sprayLedBleDeviceId:${NAME}`;
const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
/** Fire the newest background-safe timer that is still armed. */
const fireIdleTimer = () => {
  const timer = [...radio.timers]
    .reverse()
    .find((candidate) => !candidate.cancelled && candidate.delay === SPRAY_LED_BLE_IDLE_MS);
  expect(timer).toBeDefined();
  timer!.cancelled = true;
  timer!.callback();
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSprayLedBleTransportForTests();
  radio.permitted = true;
  radio.poweredOn = true;
  radio.timers = [];
  radio.scan = null;
  radio.disconnects.clear();
  radio.failing.clear();
  radio.storage.clear();
  const owner = currentBleScanOwner();
  if (owner) releaseBleScan(owner);
  manager.connectToDevice.mockImplementation(async (id: string) => {
    if (radio.failing.has(id)) throw new Error('not here');
    return fakeDevice(id);
  });
  manager.onDeviceDisconnected.mockImplementation((id: string, listener: () => void) => {
    radio.disconnects.set(id, listener);
    return { remove: () => radio.disconnects.delete(id) };
  });
  manager.startDeviceScan.mockImplementation((_uuids: unknown, _options: unknown, callback: ScanCallback) => {
    radio.scan = callback;
  });
});
afterEach(() => resetSprayLedBleTransportForTests());

/** Answer the running scan with a device advertising `name`. */
async function advertise(id: string, name = NAME) {
  await vi.waitFor(() => expect(radio.scan).not.toBeNull());
  radio.scan?.(null, { id, localName: name, rssi: -50 });
}

describe('the Spraywall Bluetooth transport', () => {
  it('shares one connection between callers, and finds the device by its advertised name', async () => {
    const first = sprayLedBleTransport.connect(NAME);
    const second = sprayLedBleTransport.connect(NAME);
    // A device with another name is ignored.
    await advertise('OTHER', 'Boardsesh Spraywall FFFF');
    await advertise('AA:BB');
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(one.name).toBe(NAME);
    expect(manager.connectToDevice).toHaveBeenCalledTimes(1);
    expect(manager.connectToDevice).toHaveBeenCalledWith('AA:BB', expect.anything());
    // Found once, remembered on this phone; the scan stopped as soon as it matched.
    expect(radio.storage.get(ID_KEY)).toBe('AA:BB');
    expect(manager.stopDeviceScan).toHaveBeenCalledTimes(1);
    expect(currentBleScanOwner()).toBeNull();
  });

  it('connects straight to a remembered device without scanning', async () => {
    await rememberSprayLedController(NAME, 'AA:BB');
    await sprayLedBleTransport.connect(NAME);
    expect(manager.startDeviceScan).not.toHaveBeenCalled();
    expect(manager.connectToDevice).toHaveBeenCalledWith('AA:BB', expect.anything());
  });

  it('scans by name once more when the remembered device no longer connects', async () => {
    await rememberSprayLedController(NAME, 'STALE');
    radio.failing.add('STALE');
    const connecting = sprayLedBleTransport.connect(NAME);
    await advertise('FRESH');
    await connecting;
    expect(manager.connectToDevice.mock.calls.map(([id]) => id)).toEqual(['STALE', 'FRESH']);
    expect(radio.storage.get(ID_KEY)).toBe('FRESH');
  });

  it('lets go after a minute without writes, on the background-safe timer', async () => {
    await rememberSprayLedController(NAME, 'AA:BB');
    const link = await sprayLedBleTransport.connect(NAME);
    await link.write(Uint8Array.from([1]));
    fireIdleTimer();
    expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('AA:BB');
    // The next climb connects again.
    await sprayLedBleTransport.connect(NAME);
    expect(manager.connectToDevice).toHaveBeenCalledTimes(2);
  });

  it('lets go of the controller when the app goes to the background', async () => {
    await rememberSprayLedController(NAME, 'AA:BB');
    await sprayLedBleTransport.connect(NAME);
    radio.appState?.('inactive');
    await flush();
    expect(manager.cancelDeviceConnection).not.toHaveBeenCalled();
    radio.appState?.('background');
    await flush();
    expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('AA:BB');
  });

  it('forgets a link the controller dropped', async () => {
    await rememberSprayLedController(NAME, 'AA:BB');
    await sprayLedBleTransport.connect(NAME);
    radio.disconnects.get('AA:BB')?.();
    await flush();
    await sprayLedBleTransport.connect(NAME);
    expect(manager.connectToDevice).toHaveBeenCalledTimes(2);
  });

  it('reports Bluetooth that is off or not allowed apart from an unreachable controller', async () => {
    radio.permitted = false;
    await expect(sprayLedBleTransport.connect(NAME)).rejects.toMatchObject({ code: 'bluetooth-unavailable' });
    radio.permitted = true;
    radio.poweredOn = false;
    await expect(sprayLedBleTransport.connect(NAME)).rejects.toMatchObject({ code: 'bluetooth-unavailable' });
    expect(manager.connectToDevice).not.toHaveBeenCalled();
  });

  it('never starts a scan over another caller’s, and never stops one it does not own', async () => {
    const rogue = Symbol('rogue');
    noteBleScanStarted(rogue);
    const stopped = vi.fn();
    scanForSprayLedControllers(vi.fn(), stopped);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith('busy'));
    expect(manager.startDeviceScan).not.toHaveBeenCalled();
    expect(manager.stopDeviceScan).not.toHaveBeenCalled();
    releaseBleScan(rogue);

    const stop = scanForSprayLedControllers(vi.fn(), vi.fn());
    await vi.waitFor(() => expect(manager.startDeviceScan).toHaveBeenCalledTimes(1));
    // Another caller took the slot (its scan replaced ours): our stop leaves it running.
    noteBleScanStarted(rogue);
    stop();
    expect(manager.stopDeviceScan).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBe(rogue);
    releaseBleScan(rogue);
  });

  it('lists only controllers advertising the exact Spraywall name', async () => {
    const update = vi.fn();
    const stop = scanForSprayLedControllers(update, vi.fn());
    await vi.waitFor(() => expect(radio.scan).not.toBeNull());
    radio.scan?.(null, { id: 'K', localName: 'Kilter Board#123456@3' });
    radio.scan?.(null, { id: 'S', localName: NAME, rssi: -40 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith([{ id: 'S', name: NAME, rssi: -40 }]);
    stop();
    expect(manager.stopDeviceScan).toHaveBeenCalledTimes(1);
  });
});
