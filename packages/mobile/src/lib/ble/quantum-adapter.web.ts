import {
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  parseQuantumControllerMetadata,
  parseQuantumDeviceSerial,
  type QuantumBoardModelId,
  type QuantumBroadcast,
} from '@boardsesh/ble-protocol/quantum';
import {
  requestWebBluetoothDevice,
  type WebBluetoothDevice,
  type WebBluetoothRemoteGATTCharacteristic,
  type WebBluetoothRemoteGATTServer,
  type WebRequestDeviceOptions,
} from '@boardsesh/ble-protocol/web-transport';
import type { DevicePickerFn } from './types';
import {
  QuantumControllerModelMismatchError,
  QuantumNotificationInbox,
  type QuantumBluetoothTransport,
  type QuantumControllerConnection,
  type QuantumDisconnectInfo,
} from './quantum-transport';

// Web Bluetooth has no MTU API. Quantum frames are capped to 227 bytes by the
// protocol; Chromium performs the one acknowledged write or rejects it. Never
// hide that rejection by fragmenting the command.
const WEB_QUANTUM_MAXIMUM_WRITE_BYTES = 509;

type DataViewLike = {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
};

type QuantumWebCharacteristic = WebBluetoothRemoteGATTCharacteristic & {
  value?: DataViewLike;
  readValue(): Promise<DataViewLike>;
  startNotifications(): Promise<QuantumWebCharacteristic>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: QuantumValueChangedEvent) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: QuantumValueChangedEvent) => void): void;
};

type QuantumValueChangedEvent = {
  target?: { value?: DataViewLike };
};

type QuantumWebCharacteristics = {
  notify: QuantumWebCharacteristic;
  write: QuantumWebCharacteristic;
  state: QuantumWebCharacteristic;
  metadata: QuantumWebCharacteristic;
};

export const QUANTUM_WEB_REQUEST_DEVICE_OPTIONS: WebRequestDeviceOptions = {
  filters: [{ namePrefix: 'eWalls_' }, { namePrefix: 'QB_' }, { namePrefix: 'QBB_' }],
  optionalServices: [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID],
};

function bytesFromView(view: DataViewLike): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

function hasQuantumWebCharacteristicSurface(
  characteristic: WebBluetoothRemoteGATTCharacteristic,
): characteristic is QuantumWebCharacteristic {
  const candidate = characteristic as Partial<QuantumWebCharacteristic>;
  return (
    typeof candidate.readValue === 'function' &&
    typeof candidate.startNotifications === 'function' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

async function discoverQuantumWebCharacteristics(
  server: WebBluetoothRemoteGATTServer,
): Promise<QuantumWebCharacteristics | undefined> {
  for (const serviceUuid of [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID]) {
    try {
      // Chromium permits only one outstanding GATT operation. Resolve the
      // service and its four characteristics sequentially, never Promise.all.
      const service = await server.getPrimaryService(serviceUuid);
      const notify = await service.getCharacteristic(QUANTUM_NOTIFY_CHARACTERISTIC_UUID);
      const write = await service.getCharacteristic(QUANTUM_WRITE_CHARACTERISTIC_UUID);
      const state = await service.getCharacteristic(QUANTUM_STATE_CHARACTERISTIC_UUID);
      const metadata = await service.getCharacteristic(QUANTUM_METADATA_CHARACTERISTIC_UUID);
      if (
        hasQuantumWebCharacteristicSurface(notify) &&
        hasQuantumWebCharacteristicSurface(write) &&
        hasQuantumWebCharacteristicSurface(state) &&
        hasQuantumWebCharacteristicSurface(metadata)
      ) {
        return { notify, write, state, metadata };
      }
    } catch {
      // Current service generation absent or incomplete; try the legacy one.
    }
  }
  return undefined;
}

/** Browser support is intentionally narrow: Chromium exposes
 * navigator.bluetooth only in a secure context. Safari/Firefox/insecure HTTP
 * keep browse and ticks available while this returns false. */
export function isQuantumWebBluetoothAvailable(): boolean {
  const browser = globalThis as {
    isSecureContext?: boolean;
    navigator?: { bluetooth?: unknown };
  };
  return browser.isSecureContext === true && browser.navigator?.bluetooth !== undefined;
}

export class WebQuantumBluetoothTransport implements QuantumBluetoothTransport {
  readonly maximumWriteBytes = WEB_QUANTUM_MAXIMUM_WRITE_BYTES;
  private device: WebBluetoothDevice | null = null;
  private characteristics: QuantumWebCharacteristics | null = null;
  private disconnectListener: ((info?: QuantumDisconnectInfo) => void) | null = null;
  private readonly notificationInbox = new QuantumNotificationInbox();
  private gattTail: Promise<void> = Promise.resolve();
  private connectionAttemptGeneration = 0;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(isQuantumWebBluetoothAvailable());
  }

  async requestAndConnect(
    selectedModelId: QuantumBoardModelId,
    _targetSerial?: string,
    _targetDeviceId?: string,
  ): Promise<QuantumControllerConnection> {
    if (!isQuantumWebBluetoothAvailable()) {
      throw new Error('Quantum board control requires Chromium in a secure context');
    }
    const initialDisconnect = this.disconnect();
    const connectionAttemptGeneration = this.connectionAttemptGeneration;
    await initialDisconnect;
    const assertCurrentAttempt = (device?: WebBluetoothDevice) => {
      if (this.connectionAttemptGeneration === connectionAttemptGeneration) return;
      if (device?.gatt?.connected) device.gatt.disconnect();
      throw new Error('Quantum connection attempt cancelled');
    };
    assertCurrentAttempt();

    const device = await requestWebBluetoothDevice(QUANTUM_WEB_REQUEST_DEVICE_OPTIONS);
    assertCurrentAttempt(device);
    const deviceName = device.name;
    const serial = parseQuantumDeviceSerial(deviceName);
    if (!deviceName || !serial) throw new Error('Selected device is not a supported Quantum controller');

    const server = device.gatt?.connected ? device.gatt : await device.gatt?.connect();
    assertCurrentAttempt(device);
    if (!server) throw new Error('Quantum controller has no Web Bluetooth GATT server');
    this.device = device;
    let characteristics: QuantumWebCharacteristics | undefined;
    try {
      characteristics = await discoverQuantumWebCharacteristics(server);
      assertCurrentAttempt(device);
      if (!characteristics) {
        throw new Error('Quantum controller characteristics FFF1/FFF2/FFF4/FFF5 were not found');
      }

      const metadata = parseQuantumControllerMetadata(bytesFromView(await characteristics.metadata.readValue()));
      assertCurrentAttempt(device);
      if (!metadata || metadata.model.id !== selectedModelId) {
        throw new QuantumControllerModelMismatchError(selectedModelId, metadata?.model.id);
      }

      this.characteristics = characteristics;
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      characteristics.notify.addEventListener('characteristicvaluechanged', this.handleNotification);
      // startNotifications configures CCCD 0x2902 in the browser; controller
      // values still pass through strict frame reassembly below.
      await characteristics.notify.startNotifications();
      assertCurrentAttempt(device);
      return { deviceId: device.id, deviceName, serial, metadata };
    } catch (error) {
      device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
      characteristics?.notify.removeEventListener('characteristicvaluechanged', this.handleNotification);
      server.disconnect();
      if (this.device === device) {
        this.device = null;
        this.characteristics = null;
        this.notificationInbox.reset();
      }
      throw error;
    }
  }

  disconnect(): Promise<void> {
    this.connectionAttemptGeneration += 1;
    this.cleanupListeners();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
    this.characteristics = null;
    this.notificationInbox.reset();
    this.gattTail = Promise.resolve();
    return Promise.resolve();
  }

  writeWithResponse(frame: Uint8Array): Promise<void> {
    if (frame.length === 0 || frame.length > this.maximumWriteBytes) {
      return Promise.reject(
        new Error(`Quantum frame needs ${frame.length} atomic bytes; transport allows ${this.maximumWriteBytes}`),
      );
    }
    return this.enqueueGatt(async () => {
      const write = this.characteristics?.write;
      if (!write) throw new Error('Quantum controller is not connected');
      if (frame[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST) this.notificationInbox.markRosterRequest();
      await write.writeValueWithResponse(frame.slice());
    });
  }

  readState(): Promise<Uint8Array | undefined> {
    return this.enqueueGatt(async () => {
      const state = this.characteristics?.state;
      if (!state) throw new Error('Quantum controller is not connected');
      return bytesFromView(await state.readValue());
    });
  }

  waitForNotification(timeoutMs: number): Promise<Uint8Array | undefined> {
    return this.notificationInbox.waitForRoster(timeoutMs);
  }

  onDisconnect(listener: (info?: QuantumDisconnectInfo) => void): () => void {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) this.disconnectListener = null;
    };
  }

  onBroadcast(listener: (broadcast: QuantumBroadcast) => void): () => void {
    return this.notificationInbox.subscribe(listener);
  }

  private readonly handleNotification = (event: QuantumValueChangedEvent): void => {
    const value = event.target?.value;
    if (value) this.notificationInbox.push(bytesFromView(value));
  };

  private readonly handleDisconnect = (): void => {
    this.connectionAttemptGeneration += 1;
    this.cleanupListeners();
    this.characteristics = null;
    this.notificationInbox.reset();
    this.disconnectListener?.({ description: 'Web Bluetooth GATT connection closed' });
  };

  private enqueueGatt<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gattTail.then(operation);
    this.gattTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private cleanupListeners(): void {
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.characteristics?.notify.removeEventListener('characteristicvaluechanged', this.handleNotification);
  }
}

export function createQuantumBluetoothTransport(_devicePicker: DevicePickerFn): QuantumBluetoothTransport {
  return new WebQuantumBluetoothTransport();
}
