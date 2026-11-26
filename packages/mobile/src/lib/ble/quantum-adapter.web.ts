import { QUANTUM_RELEASED_MODELS } from '@boardsesh/board-constants/quantum';
import {
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  assertQuantumWriteEligible,
  parseQuantumControllerMetadata,
  parseQuantumDeviceSerial,
  type QuantumBoardModelId,
  type QuantumBroadcast,
  type QuantumWriteEligibility,
} from '@boardsesh/ble-protocol/quantum';
import {
  requestWebBluetoothDevice,
  type WebBluetoothDevice,
  type WebBluetoothRemoteGATTCharacteristic,
  type WebBluetoothRemoteGATTServer,
  type WebRequestDeviceOptions,
} from '@boardsesh/ble-protocol/web-transport';
import type { DevicePickerFn } from './types';
import { claimQuantumPhysicalOwnership, type QuantumPhysicalOwnership } from './quantum-physical-ownership';
import {
  QuantumControllerModelMismatchError,
  QuantumNotificationInbox,
  type QuantumBluetoothTransport,
  type QuantumControllerConnection,
  type QuantumDisconnectInfo,
} from './quantum-transport';

// Web Bluetooth has no MTU API. Quantum frames are capped to 227 bytes by the
// protocol; Chromium performs the selected characteristic write or rejects it. Never
// hide that rejection by fragmenting the command.
const WEB_QUANTUM_MAXIMUM_WRITE_BYTES = 509;
const WEB_PHYSICAL_SCOPE = {};

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
  filters: [{ namePrefix: 'QB_' }, { namePrefix: 'QBB_' }],
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
  assertCurrent: () => void,
): Promise<QuantumWebCharacteristics | undefined> {
  for (const serviceUuid of [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID]) {
    try {
      // Chromium permits only one outstanding GATT operation. Resolve the
      // service and its four characteristics sequentially, never Promise.all.
      assertCurrent();
      const service = await server.getPrimaryService(serviceUuid);
      assertCurrent();
      const notify = await service.getCharacteristic(QUANTUM_NOTIFY_CHARACTERISTIC_UUID);
      assertCurrent();
      const write = await service.getCharacteristic(QUANTUM_WRITE_CHARACTERISTIC_UUID);
      assertCurrent();
      const state = await service.getCharacteristic(QUANTUM_STATE_CHARACTERISTIC_UUID);
      assertCurrent();
      const metadata = await service.getCharacteristic(QUANTUM_METADATA_CHARACTERISTIC_UUID);
      assertCurrent();
      if (
        hasQuantumWebCharacteristicSurface(notify) &&
        hasQuantumWebCharacteristicSurface(write) &&
        hasQuantumWebCharacteristicSurface(state) &&
        hasQuantumWebCharacteristicSurface(metadata)
      ) {
        return { notify, write, state, metadata };
      }
    } catch {
      assertCurrent();
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
  private physicalOwnership: QuantumPhysicalOwnership | null = null;
  private removeConnectionListeners: (() => void) | null = null;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(isQuantumWebBluetoothAvailable());
  }

  async requestAndConnect(
    selectedModelId: QuantumBoardModelId,
    _targetSerial?: string,
    _targetDeviceId?: string,
  ): Promise<QuantumControllerConnection> {
    if (!QUANTUM_RELEASED_MODELS.some((modelId) => modelId === selectedModelId)) {
      throw new QuantumControllerModelMismatchError(selectedModelId);
    }
    if (!isQuantumWebBluetoothAvailable()) {
      throw new Error('Quantum board control requires Chromium in a secure context');
    }
    const initialDisconnect = this.disconnect();
    const connectionAttemptGeneration = this.connectionAttemptGeneration;
    await initialDisconnect;
    let ownership: QuantumPhysicalOwnership | null = null;
    const assertCurrentAttempt = () => {
      if (this.connectionAttemptGeneration !== connectionAttemptGeneration || (ownership && !ownership.isCurrent())) {
        throw new Error('Quantum connection attempt cancelled');
      }
    };
    assertCurrentAttempt();

    const device = await requestWebBluetoothDevice(QUANTUM_WEB_REQUEST_DEVICE_OPTIONS);
    // A cancelled chooser has not opened a link and cannot claim or close a
    // device another adapter may now own.
    assertCurrentAttempt();
    const deviceName = device.name;
    const serial = parseQuantumDeviceSerial(deviceName);
    if (!deviceName || !serial) throw new Error('Selected device is not a supported Quantum controller');
    ownership = claimQuantumPhysicalOwnership(WEB_PHYSICAL_SCOPE, device.id);
    const connectionOwnership = ownership;
    this.physicalOwnership = ownership;
    this.device = device;
    let server: WebBluetoothRemoteGATTServer | undefined;
    let removeListeners: (() => void) | undefined;
    try {
      server = device.gatt?.connected ? device.gatt : await device.gatt?.connect();
      assertCurrentAttempt();
      if (!server) throw new Error('Quantum controller has no Web Bluetooth GATT server');
      const characteristics = await discoverQuantumWebCharacteristics(server, assertCurrentAttempt);
      assertCurrentAttempt();
      if (!characteristics) {
        throw new Error(
          'Quantum binary control requires FFF1/FFF2/FFF4/FFF5; legacy JSON controllers without FFF5 are unsupported',
        );
      }
      const write = characteristics.write;
      const supported = deviceName.startsWith('QB_')
        ? write.properties?.write && typeof write.writeValueWithResponse === 'function'
        : write.properties?.writeWithoutResponse && typeof write.writeValueWithoutResponse === 'function';
      if (!supported) throw new Error('Quantum FFF2 does not support the selected controller write mode');
      const metadata = parseQuantumControllerMetadata(bytesFromView(await characteristics.metadata.readValue()));
      assertCurrentAttempt();
      if (!metadata || metadata.model.id !== selectedModelId) {
        throw new QuantumControllerModelMismatchError(selectedModelId, metadata?.model.id);
      }
      this.characteristics = characteristics;
      const isCurrentConnection = () =>
        connectionOwnership.isCurrent() && this.physicalOwnership === connectionOwnership;
      const handleDisconnect = () => {
        if (isCurrentConnection()) this.handleDisconnect();
      };
      const handleNotification = (event: QuantumValueChangedEvent) => {
        if (isCurrentConnection()) this.handleNotification(event);
      };
      device.addEventListener('gattserverdisconnected', handleDisconnect);
      characteristics.notify.addEventListener('characteristicvaluechanged', handleNotification);
      removeListeners = () => {
        device.removeEventListener('gattserverdisconnected', handleDisconnect);
        characteristics.notify.removeEventListener('characteristicvaluechanged', handleNotification);
      };
      this.removeConnectionListeners = removeListeners;
      // Configure CCCD before allowing the first roster command.
      await characteristics.notify.startNotifications();
      assertCurrentAttempt();
      return { deviceId: device.id, deviceName, serial, metadata };
    } catch (error) {
      removeListeners?.();
      if (connectionOwnership.isCurrent() && device.gatt?.connected) device.gatt.disconnect();
      if (this.physicalOwnership === connectionOwnership) {
        this.device = null;
        this.characteristics = null;
        this.physicalOwnership = null;
        if (this.removeConnectionListeners === removeListeners) this.removeConnectionListeners = null;
        this.notificationInbox.reset();
      }
      throw error;
    }
  }

  disconnect(): Promise<void> {
    this.connectionAttemptGeneration += 1;
    this.cleanupListeners();
    if (this.physicalOwnership?.isCurrent() && this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
    this.physicalOwnership = null;
    this.characteristics = null;
    this.notificationInbox.reset();
    this.gattTail = Promise.resolve();
    return Promise.resolve();
  }

  writeFrame(frame: Uint8Array, isEligible?: QuantumWriteEligibility): Promise<void> {
    if (frame.length === 0 || frame.length > this.maximumWriteBytes) {
      return Promise.reject(
        new Error(`Quantum frame needs ${frame.length} atomic bytes; transport allows ${this.maximumWriteBytes}`),
      );
    }
    return this.enqueueGatt(async () => {
      const write = this.characteristics?.write;
      if (!write) throw new Error('Quantum controller is not connected');
      assertQuantumWriteEligible(isEligible);
      if (frame[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST) this.notificationInbox.markRosterRequest();
      else this.notificationInbox.markMutation();
      if (this.device?.name?.startsWith('QB_')) await write.writeValueWithResponse(frame.slice());
      else await write.writeValueWithoutResponse(frame.slice());
    });
  }

  getMutationFailure(command: QuantumCommand) {
    return this.notificationInbox.getMutationFailure(command);
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
    const ownership = this.physicalOwnership;
    const generation = this.connectionAttemptGeneration;
    const result = this.gattTail.then(() => {
      if (
        !ownership?.isCurrent() ||
        this.physicalOwnership !== ownership ||
        this.connectionAttemptGeneration !== generation
      ) {
        throw new Error('Quantum controller is not connected');
      }
      return operation();
    });
    this.gattTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private cleanupListeners(): void {
    this.removeConnectionListeners?.();
    this.removeConnectionListeners = null;
  }
}

export function createQuantumBluetoothTransport(_devicePicker: DevicePickerFn): QuantumBluetoothTransport {
  return new WebQuantumBluetoothTransport();
}
