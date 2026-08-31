import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
} from '@boardsesh/ble-protocol/quantum';

const webBluetooth = vi.hoisted(() => ({ requestDevice: vi.fn() }));
vi.mock('@boardsesh/ble-protocol/web-transport', () => ({
  requestWebBluetoothDevice: webBluetooth.requestDevice,
}));

import {
  QUANTUM_WEB_REQUEST_DEVICE_OPTIONS,
  WebQuantumBluetoothTransport,
  isQuantumWebBluetoothAvailable,
} from '../quantum-adapter.web';

function metadataView(): DataView {
  const bytes = new Uint8Array(41);
  bytes[34] = 4;
  bytes[35] = 0;
  bytes[36] = 15;
  bytes[37] = 0;
  bytes[38] = 12;
  return new DataView(bytes.buffer);
}

function setupDevice(name = 'eWalls_gym_AABBCCDDEEFF') {
  const writeValueWithResponse = vi.fn(async () => undefined);
  const listeners = new Map<string, (event: { target?: { value?: DataView } }) => void>();
  const characteristic = (uuid: string) => ({
    uuid,
    properties: { writeWithoutResponse: false },
    writeValueWithResponse,
    writeValueWithoutResponse: vi.fn(async () => undefined),
    readValue: vi.fn(async () =>
      uuid === QUANTUM_METADATA_CHARACTERISTIC_UUID ? metadataView() : new DataView(new ArrayBuffer(0)),
    ),
    startNotifications: vi.fn(async () => undefined),
    addEventListener: vi.fn((type: string, listener: (event: { target?: { value?: DataView } }) => void) => {
      listeners.set(`${uuid}:${type}`, listener);
    }),
    removeEventListener: vi.fn(),
  });
  const characteristics = new Map([
    [QUANTUM_NOTIFY_CHARACTERISTIC_UUID, characteristic(QUANTUM_NOTIFY_CHARACTERISTIC_UUID)],
    [QUANTUM_WRITE_CHARACTERISTIC_UUID, characteristic(QUANTUM_WRITE_CHARACTERISTIC_UUID)],
    [QUANTUM_STATE_CHARACTERISTIC_UUID, characteristic(QUANTUM_STATE_CHARACTERISTIC_UUID)],
    [QUANTUM_METADATA_CHARACTERISTIC_UUID, characteristic(QUANTUM_METADATA_CHARACTERISTIC_UUID)],
  ]);
  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => {
      const resolved = characteristics.get(uuid);
      if (!resolved) throw new Error('missing characteristic');
      return resolved;
    }),
  };
  const gatt = {
    connected: false,
    connect: vi.fn(async function connect() {
      gatt.connected = true;
      return gatt;
    }),
    disconnect: vi.fn(() => {
      gatt.connected = false;
    }),
    getPrimaryService: vi.fn(async (uuid: string) => {
      if (uuid !== QUANTUM_SERVICE_UUID) throw new Error('missing service');
      return service;
    }),
  };
  const device = {
    id: 'web-quantum',
    name,
    gatt,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  webBluetooth.requestDevice.mockResolvedValue(device);
  return { device, characteristics, writeValueWithResponse };
}

describe('WebQuantumBluetoothTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { bluetooth: { requestDevice: vi.fn() } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'isSecureContext');
    Reflect.deleteProperty(globalThis, 'navigator');
  });

  it('offers only exact Quantum name prefixes and both service generations', () => {
    expect(QUANTUM_WEB_REQUEST_DEVICE_OPTIONS).toEqual({
      filters: [{ namePrefix: 'eWalls_' }, { namePrefix: 'QB_' }, { namePrefix: 'QBB_' }],
      optionalServices: [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID],
    });
  });

  it('requires a secure Chromium Web Bluetooth context', () => {
    expect(isQuantumWebBluetoothAvailable()).toBe(true);
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    expect(isQuantumWebBluetoothAvailable()).toBe(false);
  });

  it('validates FFF5 and performs one acknowledged, unfragmented write', async () => {
    const controller = setupDevice();
    const transport = new WebQuantumBluetoothTransport();
    const connection = await transport.requestAndConnect('l');
    expect(connection.serial).toBe('AABBCCDDEEFF');

    const frame = Uint8Array.from({ length: 227 }, (_, index) => index & 0xff);
    await transport.writeWithResponse(frame);
    expect(controller.writeValueWithResponse).toHaveBeenCalledOnce();
    expect(controller.writeValueWithResponse).toHaveBeenCalledWith(frame);
    expect(
      controller.characteristics.get(QUANTUM_NOTIFY_CHARACTERISTIC_UUID)?.startNotifications,
    ).toHaveBeenCalledOnce();
  });

  it('rejects a prefix match without the final 12-hex serial', async () => {
    setupDevice('QB_not-a-controller');
    const transport = new WebQuantumBluetoothTransport();
    await expect(transport.requestAndConnect('l')).rejects.toThrow('not a supported Quantum controller');
  });

  it('disconnects a GATT link that resolves after the connection attempt is cancelled', async () => {
    const controller = setupDevice();
    let resolveGattConnection!: (server: typeof controller.device.gatt) => void;
    controller.device.gatt.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGattConnection = resolve;
      }),
    );
    const transport = new WebQuantumBluetoothTransport();

    const connection = transport.requestAndConnect('l');
    await vi.waitFor(() => expect(controller.device.gatt.connect).toHaveBeenCalledOnce());
    await transport.disconnect();
    controller.device.gatt.connected = true;
    resolveGattConnection(controller.device.gatt);

    await expect(connection).rejects.toThrow('connection attempt cancelled');
    expect(controller.device.gatt.disconnect).toHaveBeenCalledOnce();
    expect(controller.device.gatt.connected).toBe(false);
  });
});
