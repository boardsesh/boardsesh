import { Platform } from 'react-native';
import type { BleError, Characteristic, Device, Subscription } from 'react-native-ble-plx';
import {
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_REQUESTED_MTU,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  parseQuantumControllerMetadata,
  parseQuantumDeviceSerial,
  quantumAttPayloadBytes,
  type QuantumBoardModelId,
  type QuantumBroadcast,
} from '@boardsesh/ble-protocol/quantum';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';
import { bleManager } from './ble-manager';
import { base64ToUint8Array, uint8ArrayToBase64 } from './base64';
import { waitForBlePoweredOn } from './availability';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from './scan-options';
import { upsertDiscoveredDevice } from './scan-device-cache';
import type { DevicePickerFn, DiscoveredDevice } from './types';
import {
  QuantumControllerModelMismatchError,
  QuantumNotificationInbox,
  type QuantumBluetoothTransport,
  type QuantumControllerConnection,
  type QuantumDisconnectInfo,
} from './quantum-transport';

const CONNECTION_TIMEOUT_MS = 12_000;
const GATT_OPERATION_TIMEOUT_MS = 5_000;
const CONNECTION_SETUP_OPERATION_TIMEOUT_MS = 5_000;
const GATT_CANCELLATION_TIMEOUT_MS = 1_000;
const DEFAULT_ATT_MTU = 23;
const NOTIFICATION_READY_POLL_MS = 25;
// CoreBluetooth supports acknowledged long characteristic writes up to the
// Bluetooth attribute limit. ble-plx's iOS `Device.mtu` instead reports
// maximumWriteValueLength(.withoutResponse) + 3, so it cannot size the
// acknowledged write path used here.
const IOS_ACKNOWLEDGED_WRITE_MAX_BYTES = 512;

class QuantumGattTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`Quantum ${operation} timed out`);
    this.name = 'QuantumGattTimeoutError';
  }
}

type QuantumCharacteristics = {
  serviceUuid: string;
  notify: Characteristic;
  write: Characteristic;
  state: Characteristic;
  metadata: Characteristic;
};

function characteristicsByUuid(
  serviceUuid: string,
  characteristics: readonly Characteristic[],
): QuantumCharacteristics | undefined {
  const byUuid = new Map(characteristics.map((characteristic) => [characteristic.uuid.toLowerCase(), characteristic]));
  const notify = byUuid.get(QUANTUM_NOTIFY_CHARACTERISTIC_UUID);
  const write = byUuid.get(QUANTUM_WRITE_CHARACTERISTIC_UUID);
  const state = byUuid.get(QUANTUM_STATE_CHARACTERISTIC_UUID);
  const metadata = byUuid.get(QUANTUM_METADATA_CHARACTERISTIC_UUID);
  return notify && write && state && metadata ? { serviceUuid, notify, write, state, metadata } : undefined;
}

async function discoverQuantumCharacteristics(device: Device): Promise<QuantumCharacteristics | undefined> {
  for (const serviceUuid of [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID]) {
    try {
      const characteristics = await device.characteristicsForService(serviceUuid);
      const resolved = characteristicsByUuid(serviceUuid, characteristics);
      if (resolved) return resolved;
    } catch {
      // This controller generation does not expose the service; try the legacy
      // UUID. Never combine characteristics across services.
    }
  }
  return undefined;
}

function sameSerial(first?: string, second?: string): boolean {
  return first !== undefined && second !== undefined && first.toLowerCase() === second.toLowerCase();
}

/** Quantum's GATT contract is intentionally separate from the Aurora/MoonBoard
 * adapter: every frame is one acknowledged write and must never pass through
 * their chunking paths. This adapter is used on both iOS and Android. */
export class RNQuantumBluetoothTransport implements QuantumBluetoothTransport {
  private connectedDevice: Device | null = null;
  private characteristics: QuantumCharacteristics | null = null;
  private notificationSubscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private disconnectListener: ((info?: QuantumDisconnectInfo) => void) | null = null;
  private readonly notificationInbox = new QuantumNotificationInbox();
  private negotiatedMtu = DEFAULT_ATT_MTU;
  private gattTail: Promise<void> = Promise.resolve();
  private transactionSequence = 0;
  private readonly activeTransactionIds = new Set<string>();
  private stateReadsEnabled = true;

  constructor(private readonly devicePicker: DevicePickerFn) {}

  get maximumWriteBytes(): number {
    if (Platform.OS === 'ios') return IOS_ACKNOWLEDGED_WRITE_MAX_BYTES;
    return quantumAttPayloadBytes(this.negotiatedMtu);
  }

  isAvailable(): Promise<boolean> {
    return waitForBlePoweredOn();
  }

  async requestAndConnect(
    selectedModelId: QuantumBoardModelId,
    targetSerial?: string,
    targetDeviceId?: string,
  ): Promise<QuantumControllerConnection> {
    await this.disconnect();
    this.resetConnectionState();

    const devices = new Map<string, DiscoveredDevice>();
    let updateListener: ((devices: DiscoveredDevice[]) => void) | null = null;
    let scanStoppedListener: (() => void) | null = null;
    const pushDevices = () => updateListener?.([...devices.values()]);

    let resolveSelection!: (deviceId: string) => void;
    let rejectSelection!: (error: Error) => void;
    const selectionPromise = new Promise<string>((resolve, reject) => {
      resolveSelection = resolve;
      rejectSelection = reject;
    });

    let autoSelecting = Boolean(targetSerial || targetDeviceId);
    let pickerOpened = false;
    const openPicker = () => {
      if (pickerOpened) return;
      pickerOpened = true;
      autoSelecting = false;
      this.devicePicker((onUpdate, onScanStopped) => {
        updateListener = onUpdate;
        scanStoppedListener = onScanStopped ?? null;
        pushDevices();
      }).then(resolveSelection, rejectSelection);
    };
    if (!autoSelecting) openPicker();

    let pickerFallbackId: ReturnType<typeof setTimeout> | undefined;
    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let selectedDeviceId: string;
    try {
      void bleManager.startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (scanError, scannedDevice) => {
        if (scanError) {
          void bleManager.stopDeviceScan();
          rejectSelection(new Error(`BLE scan failed: ${scanError.message}`));
          return;
        }
        if (!scannedDevice) return;

        const deviceName = scannedDevice.localName ?? scannedDevice.name ?? undefined;
        const serial = parseQuantumDeviceSerial(deviceName);
        if (!serial || !deviceName) return;

        const discovered: DiscoveredDevice = {
          deviceId: scannedDevice.id,
          name: deviceName,
          rssi: scannedDevice.rssi ?? -100,
        };
        if (upsertDiscoveredDevice(devices, discovered)) pushDevices();

        if (autoSelecting) {
          const matchesDeviceId = targetDeviceId !== undefined && scannedDevice.id === targetDeviceId;
          if (matchesDeviceId || sameSerial(serial, targetSerial)) {
            autoSelecting = false;
            resolveSelection(scannedDevice.id);
          }
        }
      });

      pickerFallbackId =
        targetSerial || targetDeviceId
          ? setTimeout(() => {
              if (autoSelecting) openPicker();
            }, SERIAL_RECONNECT_GRACE_MS)
          : undefined;
      scanTimeoutId = setTimeout(() => {
        void bleManager.stopDeviceScan();
        if (autoSelecting) openPicker();
        if (pickerOpened && devices.size === 0) {
          rejectSelection(new Error('No Quantum controllers found within scan window'));
        } else {
          scanStoppedListener?.();
        }
      }, SCAN_TIMEOUT_MS);
      selectedDeviceId = await selectionPromise;
    } finally {
      if (pickerFallbackId) clearTimeout(pickerFallbackId);
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      void bleManager.stopDeviceScan();
    }

    const selected = [...devices.values()].find((device) => device.deviceId === selectedDeviceId);
    const deviceName = selected?.name;
    const serial = parseQuantumDeviceSerial(deviceName);
    if (!deviceName || !serial) {
      throw new Error('Selected device is not a supported Quantum controller');
    }

    let connectionTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const connected = await Promise.race([
      bleManager.connectToDevice(selectedDeviceId),
      new Promise<never>((_resolve, reject) => {
        connectionTimeoutId = setTimeout(() => {
          void bleManager.cancelDeviceConnection(selectedDeviceId).catch(() => {});
          reject(new Error('Quantum controller connection timed out'));
        }, CONNECTION_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
    });
    // Retain the physical link as soon as connect resolves so every setup
    // timeout can retire it, even before characteristics have been discovered.
    this.connectedDevice = connected;

    try {
      let deviceForDiscovery = connected;
      if (Platform.OS === 'android') {
        try {
          // Quantum's largest valid activation is 227 bytes. Android defaults to
          // an ATT payload of 20, so 512 is a hard request there. iOS negotiates
          // internally and ble-plx documents requestMTU as a no-op on that
          // platform, so only Android performs this request.
          deviceForDiscovery = await this.runGattWithTimeout(
            'MTU request',
            (transactionId) => connected.requestMTU(QUANTUM_REQUESTED_MTU, transactionId),
            () => this.retireConnection('Quantum MTU request timed out'),
          );
        } catch (error) {
          throw new Error('Quantum controller did not negotiate the required Android MTU', { cause: error });
        }
      }
      this.negotiatedMtu = deviceForDiscovery.mtu || connected.mtu || DEFAULT_ATT_MTU;
      const discoveredDevice = await this.runGattWithTimeout(
        'service discovery',
        (transactionId) => deviceForDiscovery.discoverAllServicesAndCharacteristics(transactionId),
        () => this.retireConnection('Quantum service discovery timed out'),
      );
      const characteristics = await this.runSetupOperationWithTimeout(
        'characteristic discovery',
        () => discoverQuantumCharacteristics(discoveredDevice),
        () => this.retireConnection('Quantum characteristic discovery timed out'),
      );
      if (!characteristics) {
        throw new Error('Quantum controller characteristics FFF1/FFF2/FFF4/FFF5 were not found');
      }

      const metadataBytes = base64ToUint8Array(
        (
          await this.runGattWithTimeout(
            'metadata read',
            (transactionId) => characteristics.metadata.read(transactionId),
            () => {
              this.clearConnectedHandles();
              void bleManager.cancelDeviceConnection(selectedDeviceId).catch(() => {});
            },
          )
        ).value,
      );
      const metadata = metadataBytes ? parseQuantumControllerMetadata(metadataBytes) : undefined;
      if (!metadata || metadata.model.id !== selectedModelId) {
        throw new QuantumControllerModelMismatchError(selectedModelId, metadata?.model.id);
      }

      this.connectedDevice = discoveredDevice;
      this.characteristics = characteristics;
      // `monitor(..., 'notification')` asks ble-plx to configure CCCD 0x2902
      // and enable FFF1 notifications. Values pass through strict reassembly.
      this.notificationSubscription = characteristics.notify.monitor(
        this.handleNotification,
        undefined,
        'notification',
      );
      // ble-plx's public monitor API returns only a Subscription; its native
      // promise remains pending for the lifetime of the monitor. Re-query the
      // cached characteristic until CoreBluetooth/RxAndroidBle reports CCCD
      // readiness, so the first FFF2 request cannot race notification setup.
      let notificationSetupActive = true;
      try {
        await this.runSetupOperationWithTimeout(
          'notification setup',
          async () => {
            while (notificationSetupActive) {
              const currentCharacteristics = await discoveredDevice.characteristicsForService(
                characteristics.serviceUuid,
              );
              const notify = currentCharacteristics.find(
                (characteristic) => characteristic.uuid.toLowerCase() === QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
              );
              if (notify?.isNotifying) return;
              await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_READY_POLL_MS));
            }
            throw new QuantumGattTimeoutError('notification setup');
          },
          () => this.retireConnection('Quantum notification setup timed out'),
        );
      } finally {
        notificationSetupActive = false;
      }
      this.disconnectSubscription = bleManager.onDeviceDisconnected(selectedDeviceId, (error) => {
        this.clearConnectedHandles();
        this.disconnectListener?.({ description: error?.reason ?? error?.message ?? undefined });
      });

      return { deviceId: selectedDeviceId, deviceName, serial, metadata };
    } catch (error) {
      this.clearConnectedHandles();
      await bleManager.cancelDeviceConnection(selectedDeviceId).catch(() => {});
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const deviceId = this.connectedDevice?.id;
    this.clearConnectedHandles();
    if (deviceId) await bleManager.cancelDeviceConnection(deviceId).catch(() => {});
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
      // Mark inside the serialized GATT lane, immediately before the request;
      // a delayed notification from an earlier transaction cannot cross this
      // freshness floor while another queued operation is still running.
      if (frame[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST) {
        this.notificationInbox.markRosterRequest();
      }
      // Exactly one acknowledged GATT write. Do not split this frame.
      await this.runGattWithTimeout(
        'acknowledged write',
        (transactionId) => write.writeWithResponse(uint8ArrayToBase64(frame), transactionId),
        () => this.retireConnection('Quantum acknowledged write timed out'),
      );
    });
  }

  readState(): Promise<Uint8Array | undefined> {
    return this.enqueueGatt(async () => {
      if (!this.stateReadsEnabled) return undefined;
      const state = this.characteristics?.state;
      if (!state) throw new Error('Quantum controller is not connected');
      const characteristic = await this.runGattWithTimeout(
        'state read',
        (transactionId) => state.read(transactionId),
        (cancelled) => {
          if (cancelled) {
            // A cancelled FFF4 read cannot complete late and overlap the next
            // serialized operation. Keep FFF1 alive as the connection's
            // explicit 0x47 fallback and skip FFF4 for the rest of this link.
            this.stateReadsEnabled = false;
          } else {
            this.retireConnection('Quantum state read timed out and could not be cancelled');
          }
        },
      );
      return base64ToUint8Array(characteristic.value);
    });
  }

  async waitForNotification(timeoutMs: number): Promise<Uint8Array | undefined> {
    if (!this.characteristics) return undefined;
    const frame = await this.notificationInbox.waitForRoster(timeoutMs);
    if (!frame) this.retireConnection('Quantum roster notification timed out');
    return frame;
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

  private readonly handleNotification = (error: BleError | null, characteristic: Characteristic | null): void => {
    if (error || !characteristic || !this.characteristics) return;
    const chunk = base64ToUint8Array(characteristic.value);
    if (!chunk) return;

    this.notificationInbox.push(chunk);
  };

  private enqueueGatt<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gattTail.then(operation);
    this.gattTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runGattWithTimeout<T>(
    operationName: string,
    operation: (transactionId: string) => Promise<T>,
    onTimeout: (cancelled: boolean) => void | Promise<void>,
  ): Promise<T> {
    const transactionId = `quantum-${operationName.replaceAll(' ', '-')}-${++this.transactionSequence}`;
    this.activeTransactionIds.add(transactionId);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        operation(transactionId),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new QuantumGattTimeoutError(operationName));
          }, GATT_OPERATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        const cancelled = await this.cancelGattTransaction(transactionId);
        await onTimeout(cancelled);
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.activeTransactionIds.delete(transactionId);
    }
  }

  private async runSetupOperationWithTimeout<T>(
    operationName: string,
    operation: () => Promise<T>,
    onTimeout: () => void | Promise<void>,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new QuantumGattTimeoutError(operationName));
          }, CONNECTION_SETUP_OPERATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (timedOut) await onTimeout();
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async cancelGattTransaction(transactionId: string): Promise<boolean> {
    let cancellationTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        bleManager.cancelTransaction(transactionId).then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          cancellationTimeoutId = setTimeout(() => resolve(false), GATT_CANCELLATION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (cancellationTimeoutId) clearTimeout(cancellationTimeoutId);
    }
  }

  private retireConnection(description: string): void {
    const deviceId = this.connectedDevice?.id;
    this.clearConnectedHandles();
    this.gattTail = Promise.resolve();
    if (deviceId) void bleManager.cancelDeviceConnection(deviceId).catch(() => {});
    this.disconnectListener?.({ description });
  }

  private clearConnectedHandles(): void {
    for (const transactionId of this.activeTransactionIds) {
      void bleManager.cancelTransaction(transactionId).catch(() => {});
    }
    this.activeTransactionIds.clear();
    this.notificationSubscription?.remove();
    this.notificationSubscription = null;
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = null;
    this.connectedDevice = null;
    this.characteristics = null;
    this.notificationInbox.reset();
  }

  private resetConnectionState(): void {
    this.negotiatedMtu = DEFAULT_ATT_MTU;
    this.gattTail = Promise.resolve();
    this.stateReadsEnabled = true;
  }
}

export function createQuantumBluetoothTransport(devicePicker: DevicePickerFn): QuantumBluetoothTransport {
  return new RNQuantumBluetoothTransport(devicePicker);
}
