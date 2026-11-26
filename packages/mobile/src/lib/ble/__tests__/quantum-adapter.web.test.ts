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

function setupDevice(name = 'QB_AABBCCDDEEFF', id = 'web-quantum') {
  const writeValueWithResponse = vi.fn(async () => undefined);
  const listeners = new Map<string, (event: { target?: { value?: DataView } }) => void>();
  const characteristic = (uuid: string) => ({
    uuid,
    properties: { write: true, writeWithoutResponse: true },
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
    id,
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
      filters: [{ namePrefix: 'QB_' }, { namePrefix: 'QBB_' }],
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
    await transport.writeFrame(frame);
    expect(controller.writeValueWithResponse).toHaveBeenCalledOnce();
    expect(controller.writeValueWithResponse).toHaveBeenCalledWith(frame);
    expect(
      controller.characteristics.get(QUANTUM_NOTIFY_CHARACTERISTIC_UUID)?.startNotifications,
    ).toHaveBeenCalledOnce();
  });

  it('uses the advertised without-response mode for binary QBB', async () => {
    const controller = setupDevice('QBB_AABBCCDDEEFF');
    const transport = new WebQuantumBluetoothTransport();
    await transport.requestAndConnect('l');
    await transport.writeFrame(new Uint8Array([1, 0x47]));
    expect(
      controller.characteristics.get(QUANTUM_WRITE_CHARACTERISTIC_UUID)?.writeValueWithoutResponse,
    ).toHaveBeenCalledOnce();
    expect(controller.writeValueWithResponse).not.toHaveBeenCalled();
  });
  it('rejects legacy JSON and refuses unsupported characteristic write modes', async () => {
    const legacy = setupDevice();
    legacy.characteristics.delete(QUANTUM_METADATA_CHARACTERISTIC_UUID);
    await expect(new WebQuantumBluetoothTransport().requestAndConnect('l')).rejects.toThrow('legacy JSON');
    const binary = setupDevice('QBB_AABBCCDDEEFF');
    const write = binary.characteristics.get(QUANTUM_WRITE_CHARACTERISTIC_UUID)!;
    write.properties.writeWithoutResponse = false;
    await expect(new WebQuantumBluetoothTransport().requestAndConnect('l')).rejects.toThrow('write mode');
    expect(binary.writeValueWithResponse).not.toHaveBeenCalled();
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
  it.each(['success', 'failure'] as const)(
    'preserves a replacement adapter on the same GATT after late setup %s',
    async (outcome) => {
      const shared = setupDevice();
      const metadataRead = shared.characteristics.get(QUANTUM_METADATA_CHARACTERISTIC_UUID)!.readValue;
      let finishMetadata!: (metadata: DataView) => void;
      let failMetadata!: (error: Error) => void;
      metadataRead.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finishMetadata = resolve;
          failMetadata = reject;
        }),
      );
      const first = new WebQuantumBluetoothTransport();
      const second = new WebQuantumBluetoothTransport();
      const firstConnect = first.requestAndConnect('l');
      const firstRejected = expect(firstConnect).rejects.toThrow(
        outcome === 'success' ? 'cancelled' : 'old setup rejected',
      );
      await vi.waitFor(() => expect(metadataRead).toHaveBeenCalledOnce());
      await first.disconnect();
      await second.requestAndConnect('l');
      const disconnects = shared.device.gatt.disconnect.mock.calls.length;
      if (outcome === 'success') finishMetadata(metadataView());
      else failMetadata(new Error('old setup rejected'));
      await firstRejected;
      expect(shared.device.gatt.disconnect).toHaveBeenCalledTimes(disconnects);
      expect(shared.device.gatt.connected).toBe(true);
      await second.writeFrame(new Uint8Array([1, 0x47]));
      expect(shared.writeValueWithResponse).toHaveBeenCalledOnce();
    },
  );

  it.each(['same', 'unrelated'] as const)(
    'retires a late orphaned GATT only if the replacement owns an %s device',
    async (replacement) => {
      const firstDevice = setupDevice();
      let finishConnection!: (server: typeof firstDevice.device.gatt) => void;
      firstDevice.device.gatt.connect.mockReturnValueOnce(
        new Promise((resolve) => {
          finishConnection = resolve;
        }),
      );
      const first = new WebQuantumBluetoothTransport();
      const second = new WebQuantumBluetoothTransport();
      const firstConnect = first.requestAndConnect('l');
      const firstRejected = expect(firstConnect).rejects.toThrow('cancelled');
      await vi.waitFor(() => expect(firstDevice.device.gatt.connect).toHaveBeenCalledOnce());
      await first.disconnect();
      const secondDevice = replacement === 'same' ? firstDevice : setupDevice('QB_FFEEDDCCBBAA', 'other-web-device');
      await second.requestAndConnect('l');
      firstDevice.device.gatt.connected = true;
      finishConnection(firstDevice.device.gatt);
      await firstRejected;
      expect(firstDevice.device.gatt.disconnect).toHaveBeenCalledTimes(replacement === 'same' ? 0 : 1);
      expect(secondDevice.device.gatt.connected).toBe(true);
      await second.readState();
    },
  );
  it('rechecks queued write eligibility before the browser characteristic call', async () => {
    const { writeValueWithResponse } = setupDevice();
    const adapter = new WebQuantumBluetoothTransport();
    await adapter.requestAndConnect('l');
    let releaseFirst!: () => void;
    writeValueWithResponse.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseFirst = () => resolve(undefined);
        }),
    );
    const first = adapter.writeFrame(Uint8Array.of(1, 0x47));
    await Promise.resolve();
    let eligible = true;
    const queued = adapter.writeFrame(Uint8Array.of(1, 0x41), () => eligible);
    const rejected = expect(queued).rejects.toMatchObject({ code: 'operation-cancelled' });
    eligible = false;
    releaseFirst();
    await first;
    await rejected;
    expect(writeValueWithResponse).toHaveBeenCalledOnce();
  });

  it('refuses Belay before opening the browser chooser', async () => {
    setupDevice();
    await expect(new WebQuantumBluetoothTransport().requestAndConnect('belay')).rejects.toThrow('metadata');
    expect(webBluetooth.requestDevice).not.toHaveBeenCalled();
  });

  it('fences queued GATT work and disconnect from a superseded live browser adapter', async () => {
    const shared = setupDevice();
    const first = new WebQuantumBluetoothTransport();
    const second = new WebQuantumBluetoothTransport();
    await first.requestAndConnect('l');
    await second.requestAndConnect('l');
    await expect(first.writeFrame(new Uint8Array([1, 0x47]))).rejects.toThrow('not connected');
    expect(shared.writeValueWithResponse).not.toHaveBeenCalled();
    await first.disconnect();
    expect(shared.device.gatt.disconnect).not.toHaveBeenCalled();
    await second.writeFrame(new Uint8Array([1, 0x47]));
    expect(shared.writeValueWithResponse).toHaveBeenCalledOnce();
    expect(shared.device.gatt.connected).toBe(true);
  });
});
