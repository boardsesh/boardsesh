import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, WledBleFrameAssembler, type WledBleCapabilities } from '@boardsesh/wled-ble-protocol';
const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  stop: vi.fn(),
  connect: vi.fn(),
  cancel: vi.fn(),
  erased: null as null | (() => void),
  credential: null as null | (() => void),
  background: null as null | ((state: string) => void),
  generation: 0,
  permit: vi.fn(),
  powered: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.background = listener;
      return { remove: vi.fn() };
    },
  },
}));
vi.mock('../../ble/ble-manager', () => ({
  getBleManager: () => ({
    startDeviceScan: mocks.scan,
    stopDeviceScan: mocks.stop,
    connectToDevice: mocks.connect,
    cancelDeviceConnection: mocks.cancel,
    onDeviceDisconnected: () => ({ remove: vi.fn() }),
  }),
}));
vi.mock('../../ble/availability', () => ({ waitForBlePoweredOn: mocks.powered }));
vi.mock('../../ble/use-ble-permissions', () => ({ requestBleRuntimePermissions: mocks.permit }));
vi.mock('../../ble/background-safe-timeout', () => ({
  setBackgroundSafeTimeout: (callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
}));
vi.mock('../../privacy/privacy-cache', () => ({
  getCredentialGeneration: () => mocks.generation,
  subscribeToCredentialChanges: (listener: () => void) => {
    mocks.credential = listener;
  },
}));
vi.mock('../spray-wall-led-cache', () => ({
  subscribeSprayWallLedCacheErased: (listener: () => void) => {
    mocks.erased = listener;
  },
}));
import { nativeWledBleDriver, discoverWledBluetooth } from '../wled-ble-native';
import { RogueTimerController } from '../../ble/rogue-timer-ble';
import { claimBleScan, currentBleScanOwner, noteBleScanStarted, releaseBleScan } from '../../ble/ble-scan-slot';
const capabilities: WledBleCapabilities = {
  controllerId: 'wled-aabbccddeeff',
  protocolVersion: 1,
  name: 'Gym',
  wledVersion: '16.0.1',
  ledCount: 1000,
  audio: true,
  maxMessageBytes: 8192,
};
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function device(controllerId = capabilities.controllerId, partialResponse = false) {
  let indicate: ((error: null, characteristic: { value: string }) => void) | undefined;
  const assembler = new WledBleFrameAssembler();
  const writes: Uint8Array[] = [];
  const peripheral = {
    id: 'phone-device',
    mtu: 23,
    requestMTU: vi.fn(),
    discoverAllServicesAndCharacteristics: vi.fn(),
    readCharacteristicForService: vi.fn(async () => ({
      value: btoa(JSON.stringify({ ...capabilities, controllerId })),
    })),
    monitorCharacteristicForService: vi.fn((_service: string, _characteristic: string, listener: typeof indicate) => {
      indicate = listener;
      return { remove: vi.fn() };
    }),
    writeCharacteristicWithResponseForService: vi.fn(
      async (_service: string, _characteristic: string, encoded: string) => {
        const fragment = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        writes.push(fragment);
        const request = assembler.push(fragment) as { id: string; op: string } | null;
        if (request)
          for (const response of [
            encodeFrame({ id: request.id, result: { name: 'Gym', ver: '16.0.1', leds: { count: 1000 } } }),
          ])
            indicate?.(null, { value: b64(partialResponse ? response.slice(0, 2) : response) });
      },
    ),
  };
  peripheral.requestMTU.mockResolvedValue(peripheral);
  peripheral.discoverAllServicesAndCharacteristics.mockResolvedValue(peripheral);
  return { peripheral, writes };
}
async function finishScan() {
  await vi.advanceTimersByTimeAsync(5000);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.erased?.();
  mocks.generation = 0;
  mocks.permit.mockResolvedValue(true);
  mocks.powered.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.scan.mockImplementation(
    (_services: unknown, _options: unknown, listener: (error: null, device: { id: string }) => void) =>
      listener(null, { id: 'phone-device' }),
  );
});
afterEach(() => {
  mocks.erased?.();
  const owner = currentBleScanOwner();
  if (owner) releaseBleScan(owner);
  vi.useRealTimers();
});
describe('native WLED BLE ownership', () => {
  it('does not stop a Spraywall scan when an earlier timer connection finishes', async () => {
    mocks.scan.mockImplementation(
      (_services: unknown, _options: unknown, listener: (error: null, device: { id: string; name: string }) => void) =>
        listener(null, { id: 'timer-device', name: 'Rogue Timer' }),
    );
    const timer = new RogueTimerController();
    let finishConnection!: (connection: { deviceId: string }) => void;
    const connecting = vi.spyOn(timer, 'connectById').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishConnection = resolve;
        }),
    );
    const pending = timer.connectByName('Rogue Timer');
    await vi.advanceTimersByTimeAsync(0);
    expect(connecting).toHaveBeenCalledWith('timer-device');
    const wall = Symbol('spraywall');
    expect(claimBleScan(wall)).toBe(true);
    const stopped = mocks.stop.mock.calls.length;
    finishConnection({ deviceId: 'timer-device' });
    await pending;
    expect(currentBleScanOwner()).toBe(wall);
    expect(mocks.stop).toHaveBeenCalledTimes(stopped);
  });

  it('probes without lighting writes and fragments by default MTU', async () => {
    const { peripheral, writes } = device();
    mocks.connect.mockResolvedValue(peripheral);
    const probe = nativeWledBleDriver.probe('wled-ble:wled-aabbccddeeff');
    await finishScan();
    await expect(probe).resolves.toEqual({ name: 'Gym', version: '16.0.1', ledCount: 1000 });
    expect(writes.every((fragment) => fragment.length <= 20)).toBe(true);
    const assembler = new WledBleFrameAssembler();
    const commands = writes.map((fragment) => assembler.push(fragment)).filter(Boolean);
    expect(commands).toEqual([{ id: expect.any(String), op: 'getInfo' }]);
    expect(mocks.cancel).toHaveBeenCalledWith('phone-device');
  });
  it('retains native ownership until a deferred disconnect finishes', async () => {
    const { peripheral } = device();
    mocks.connect.mockResolvedValue(peripheral);
    let finishDisconnect!: () => void;
    mocks.cancel.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDisconnect = resolve;
      }),
    );
    const probe = nativeWledBleDriver.probe('wled-ble:wled-aabbccddeeff');
    await finishScan();
    expect(mocks.cancel).toHaveBeenCalledWith('phone-device');
    await expect(discoverWledBluetooth()).rejects.toMatchObject({ code: 'unavailable' });
    expect(mocks.scan).toHaveBeenCalledTimes(1);
    finishDisconnect();
    await expect(probe).resolves.toMatchObject({ name: 'Gym' });
    const discovery = discoverWledBluetooth();
    await finishScan();
    await expect(discovery).resolves.toEqual([capabilities]);
    expect(mocks.scan).toHaveBeenCalledTimes(2);
  });

  it('never discovers or disconnects a controller while another WLED request owns it', async () => {
    const { peripheral } = device(capabilities.controllerId, true);
    mocks.connect.mockResolvedValue(peripheral);
    const controller = new AbortController();
    const probe = nativeWledBleDriver.probe('wled-ble:wled-aabbccddeeff', controller.signal);
    const cancelled = expect(probe).rejects.toMatchObject({ code: 'cancelled' });
    await finishScan();
    expect(peripheral.writeCharacteristicWithResponseForService).toHaveBeenCalled();
    await expect(discoverWledBluetooth()).rejects.toMatchObject({ code: 'unavailable' });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.scan).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    controller.abort();
    await cancelled;
    expect(mocks.cancel).toHaveBeenCalledWith('phone-device');
  });

  it('disconnects without replay when an indicated response stalls for five seconds', async () => {
    const { peripheral } = device(capabilities.controllerId, true);
    mocks.connect.mockResolvedValue(peripheral);
    const probe = nativeWledBleDriver.probe('wled-ble:wled-aabbccddeeff');
    const failed = expect(probe).rejects.toMatchObject({ code: 'cancelled' });
    await finishScan();
    const written = peripheral.writeCharacteristicWithResponseForService.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(mocks.cancel).toHaveBeenCalledWith('phone-device');
    expect(peripheral.writeCharacteristicWithResponseForService).toHaveBeenCalledTimes(written);
  });

  it('cancels a native connection that resolves after its probe was abandoned', async () => {
    let resolveConnect!: (candidate: ReturnType<typeof device>['peripheral']) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const abort = new AbortController();
    const probe = nativeWledBleDriver.probe('wled-ble:wled-aabbccddeeff', abort.signal);
    const failed = expect(probe).rejects.toMatchObject({ code: 'cancelled' });
    await finishScan();
    abort.abort();
    await failed;
    const { peripheral } = device();
    resolveConnect(peripheral);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.cancel).toHaveBeenCalledWith('phone-device');
    expect(peripheral.readCharacteristicForService).not.toHaveBeenCalled();
  });
  it('account erasure cancels discovery and prevents remembering late connects', async () => {
    let resolveConnect!: (candidate: ReturnType<typeof device>['peripheral']) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const discovery = discoverWledBluetooth();
    const failed = expect(discovery).rejects.toMatchObject({ code: 'cancelled' });
    await finishScan();
    mocks.erased?.();
    const { peripheral } = device();
    resolveConnect(peripheral);
    await failed;
    mocks.connect.mockResolvedValue(peripheral);
    const second = discoverWledBluetooth();
    await finishScan();
    await second;
    expect(mocks.scan).toHaveBeenCalledTimes(2);
  });
  it('never replaces another scan or stops its owner', async () => {
    const owner = Symbol('timer');
    noteBleScanStarted(owner);
    await expect(discoverWledBluetooth()).rejects.toMatchObject({ code: 'unavailable' });
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBe(owner);
  });
  it('rejects the wrong stable identity without sending a request', async () => {
    const { peripheral } = device('wled-111111111111');
    mocks.connect.mockResolvedValue(peripheral);
    const probe = nativeWledBleDriver.probe('wled-ble:wled-aabbccddeeff');
    const failed = expect(probe).rejects.toMatchObject({ code: 'unavailable' });
    await finishScan();
    await failed;
    expect(peripheral.writeCharacteristicWithResponseForService).not.toHaveBeenCalled();
  });
});
