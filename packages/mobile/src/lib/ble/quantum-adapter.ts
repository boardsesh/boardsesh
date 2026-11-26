import { QUANTUM_RELEASED_MODELS } from '@boardsesh/board-constants/quantum';
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
  assertQuantumWriteEligible,
  parseQuantumControllerMetadata,
  parseQuantumDeviceSerial,
  quantumAttPayloadBytes,
  type QuantumBoardModelId,
  type QuantumBroadcast,
  type QuantumWriteEligibility,
} from '@boardsesh/ble-protocol/quantum';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';
import { getBleManager } from './ble-manager';
import {
  claimQuantumPhysicalOwnership,
  nextQuantumTransactionId,
  type QuantumPhysicalOwnership,
} from './quantum-physical-ownership';
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

function quantumConnectionCancelledError(): Error {
  return new Error('Quantum connection attempt cancelled');
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

async function discoverQuantumCharacteristics(
  device: Device,
  assertCurrent: () => void,
): Promise<QuantumCharacteristics | undefined> {
  for (const serviceUuid of [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID]) {
    try {
      assertCurrent();
      const characteristics = await device.characteristicsForService(serviceUuid);
      assertCurrent();
      const resolved = characteristicsByUuid(serviceUuid, characteristics);
      if (resolved) return resolved;
    } catch {
      assertCurrent();
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
 * adapter: every frame is one mode-appropriate write and must never pass through
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
  private physicalOwnership: QuantumPhysicalOwnership | null = null;
  private scanOwnership: QuantumPhysicalOwnership | null = null;
  private readonly activeTransactionIds = new Set<string>();
  private stateReadsEnabled = true;
  private acknowledgedWrites = true;
  private connectionAttemptGeneration = 0;
  private pendingSelectionCancel: ((error: Error) => void) | null = null;
  private pendingConnectionDeviceId: string | null = null;

  constructor(private readonly devicePicker: DevicePickerFn) {}

  get maximumWriteBytes(): number {
    if (Platform.OS === 'ios' && this.acknowledgedWrites) return IOS_ACKNOWLEDGED_WRITE_MAX_BYTES;
    return quantumAttPayloadBytes(this.negotiatedMtu);
  }

  isAvailable(): Promise<boolean> {
    // Native support is present even with the radio off. Permission and radio
    // readiness belong to the explicit connect action, never a launch probe.
    return Promise.resolve(true);
  }

  async requestAndConnect(
    selectedModelId: QuantumBoardModelId,
    targetSerial?: string,
    targetDeviceId?: string,
  ): Promise<QuantumControllerConnection> {
    if (!QUANTUM_RELEASED_MODELS.some((modelId) => modelId === selectedModelId)) {
      throw new QuantumControllerModelMismatchError(selectedModelId);
    }
    const initialDisconnect = this.disconnect();
    const connectionAttemptGeneration = this.connectionAttemptGeneration;
    await initialDisconnect;
    let physicalOwnership: QuantumPhysicalOwnership | null = null;
    const assertCurrentAttempt = () => {
      if (
        this.connectionAttemptGeneration !== connectionAttemptGeneration ||
        (physicalOwnership && !physicalOwnership.isCurrent())
      ) {
        throw quantumConnectionCancelledError();
      }
    };
    assertCurrentAttempt();
    const poweredOn = await waitForBlePoweredOn();
    assertCurrentAttempt();
    if (!poweredOn) throw new Error('Bluetooth is unavailable or powered off');
    this.resetConnectionState();
    const manager = getBleManager();

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
    const selectionAbortController = new AbortController();
    const cancelSelection = (error: Error) => {
      selectionAbortController.abort(error);
      rejectSelection(error);
    };
    this.pendingSelectionCancel = cancelSelection;

    let autoSelecting = Boolean(targetSerial || targetDeviceId);
    let pickerOpened = false;
    const openPicker = () => {
      if (pickerOpened) return;
      pickerOpened = true;
      autoSelecting = false;
      this.devicePicker(
        (onUpdate, onScanStopped) => {
          updateListener = onUpdate;
          scanStoppedListener = onScanStopped ?? null;
          pushDevices();
        },
        undefined,
        selectionAbortController.signal,
      ).then(resolveSelection, rejectSelection);
    };
    if (!autoSelecting) openPicker();

    let pickerFallbackId: ReturnType<typeof setTimeout> | undefined;
    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let selectedDeviceId: string;
    const scanOwnership = claimQuantumPhysicalOwnership(manager, 'scan', () =>
      cancelSelection(quantumConnectionCancelledError()),
    );
    this.scanOwnership = scanOwnership;
    const stopOwnedScan = () => {
      if (scanOwnership.isCurrent()) void manager.stopDeviceScan();
    };
    try {
      void manager.startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (scanError, scannedDevice) => {
        if (this.connectionAttemptGeneration !== connectionAttemptGeneration || !scanOwnership.isCurrent()) return;
        if (scanError) {
          stopOwnedScan();
          cancelSelection(new Error(`BLE scan failed: ${scanError.message}`));
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
        stopOwnedScan();
        if (autoSelecting) openPicker();
        if (pickerOpened && devices.size === 0) {
          cancelSelection(new Error('No Quantum controllers found within scan window'));
        } else {
          scanStoppedListener?.();
        }
      }, SCAN_TIMEOUT_MS);
      selectedDeviceId = await selectionPromise;
      assertCurrentAttempt();
    } finally {
      if (this.pendingSelectionCancel === cancelSelection) this.pendingSelectionCancel = null;
      if (pickerFallbackId) clearTimeout(pickerFallbackId);
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      stopOwnedScan();
      scanOwnership.detachSupersededListener();
      if (this.scanOwnership === scanOwnership) this.scanOwnership = null;
    }

    const selected = [...devices.values()].find((device) => device.deviceId === selectedDeviceId);
    const deviceName = selected?.name;
    const serial = parseQuantumDeviceSerial(deviceName);
    if (!deviceName || !serial) {
      throw new Error('Selected device is not a supported Quantum controller');
    }

    physicalOwnership = claimQuantumPhysicalOwnership(manager, `device:${selectedDeviceId}`);
    this.physicalOwnership = physicalOwnership;
    const connectionOwnership = physicalOwnership;
    const cancelSelectedDevice = async () => {
      await connectionOwnership.cleanup(() => manager.cancelDeviceConnection(selectedDeviceId));
    };
    const clearAttemptHandles = () => {
      if (this.physicalOwnership === connectionOwnership) this.clearConnectedHandles();
    };
    this.pendingConnectionDeviceId = selectedDeviceId;
    let connectionTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let connected: Device;
    try {
      await connectionOwnership.waitForCleanup();
      assertCurrentAttempt();
      connected = await Promise.race([
        manager.connectToDevice(selectedDeviceId),
        new Promise<never>((_resolve, reject) => {
          connectionTimeoutId = setTimeout(() => {
            void cancelSelectedDevice();
            reject(new Error('Quantum controller connection timed out'));
          }, CONNECTION_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
      });
      assertCurrentAttempt();
    } catch (error) {
      if (this.physicalOwnership === connectionOwnership && this.pendingConnectionDeviceId === selectedDeviceId)
        this.pendingConnectionDeviceId = null;
      await cancelSelectedDevice();
      throw error;
    }
    // Retain the physical link as soon as connect resolves so every setup
    // timeout can retire it, even before characteristics have been discovered.
    this.connectedDevice = connected;
    this.pendingConnectionDeviceId = null;

    try {
      let deviceForDiscovery = connected;
      if (Platform.OS === 'android') {
        for (const requestedMtu of [QUANTUM_REQUESTED_MTU, 247, 185]) {
          try {
            deviceForDiscovery = await this.runGattWithTimeout(
              'MTU request',
              (transactionId) => connected.requestMTU(requestedMtu, transactionId),
              () => this.retireConnection('Quantum MTU request timed out'),
            );
            assertCurrentAttempt();
            break;
          } catch (error) {
            assertCurrentAttempt();
            if (error instanceof QuantumGattTimeoutError || requestedMtu === 185) {
              throw new Error('Quantum controller did not negotiate the required Android MTU', { cause: error });
            }
          }
        }
      }
      this.negotiatedMtu = deviceForDiscovery.mtu || connected.mtu || DEFAULT_ATT_MTU;
      const discoveredDevice = await this.runGattWithTimeout(
        'service discovery',
        (transactionId) => deviceForDiscovery.discoverAllServicesAndCharacteristics(transactionId),
        () => this.retireConnection('Quantum service discovery timed out'),
      );
      assertCurrentAttempt();
      const characteristics = await this.runSetupOperationWithTimeout(
        'characteristic discovery',
        () => discoverQuantumCharacteristics(discoveredDevice, assertCurrentAttempt),
        () => this.retireConnection('Quantum characteristic discovery timed out'),
      );
      assertCurrentAttempt();
      if (!characteristics) {
        throw new Error(
          'Quantum binary control requires FFF1/FFF2/FFF4/FFF5; legacy JSON controllers without FFF5 are unsupported',
        );
      }

      this.acknowledgedWrites = deviceName.startsWith('QB_');
      if (
        this.acknowledgedWrites
          ? !characteristics.write.isWritableWithResponse
          : !characteristics.write.isWritableWithoutResponse
      ) {
        throw new Error('Quantum FFF2 does not support the selected controller write mode');
      }
      const metadataBytes = base64ToUint8Array(
        (
          await this.runGattWithTimeout(
            'metadata read',
            (transactionId) => characteristics.metadata.read(transactionId),
            () => {
              clearAttemptHandles();
              void cancelSelectedDevice();
            },
          )
        ).value,
      );
      assertCurrentAttempt();
      const metadata = metadataBytes ? parseQuantumControllerMetadata(metadataBytes) : undefined;
      if (!metadata || metadata.model.id !== selectedModelId) {
        throw new QuantumControllerModelMismatchError(selectedModelId, metadata?.model.id);
      }

      this.connectedDevice = discoveredDevice;
      this.characteristics = characteristics;
      // `monitor(..., 'notification')` asks ble-plx to configure CCCD 0x2902
      // and enable FFF1 notifications. Each event carries one controller value.
      this.notificationSubscription = characteristics.notify.monitor(
        (error, characteristic) => {
          if (connectionOwnership.isCurrent() && this.physicalOwnership === connectionOwnership)
            this.handleNotification(error, characteristic);
        },
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
              assertCurrentAttempt();
              const currentCharacteristics = await discoveredDevice.characteristicsForService(
                characteristics.serviceUuid,
              );
              assertCurrentAttempt();
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
        assertCurrentAttempt();
      } finally {
        notificationSetupActive = false;
      }
      this.disconnectSubscription = manager.onDeviceDisconnected(selectedDeviceId, (error) => {
        if (!connectionOwnership.isCurrent() || this.physicalOwnership !== connectionOwnership) return;
        this.clearConnectedHandles();
        this.disconnectListener?.({ description: error?.reason ?? error?.message ?? undefined });
      });

      assertCurrentAttempt();
      return { deviceId: selectedDeviceId, deviceName, serial, metadata };
    } catch (error) {
      clearAttemptHandles();
      await cancelSelectedDevice();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.connectionAttemptGeneration += 1;
    const cancelPendingSelection = this.pendingSelectionCancel;
    this.pendingSelectionCancel = null;
    cancelPendingSelection?.(quantumConnectionCancelledError());
    const scanOwnership = this.scanOwnership;
    this.scanOwnership = null;
    if (scanOwnership?.isCurrent()) void getBleManager().stopDeviceScan();
    scanOwnership?.detachSupersededListener();
    const physicalOwnership = this.physicalOwnership;
    const deviceIds = new Set<string>();
    if (this.connectedDevice?.id) deviceIds.add(this.connectedDevice.id);
    if (this.pendingConnectionDeviceId) deviceIds.add(this.pendingConnectionDeviceId);
    this.pendingConnectionDeviceId = null;
    this.clearConnectedHandles();
    this.physicalOwnership = null;
    if (physicalOwnership) {
      await Promise.all(
        [...deviceIds].map((deviceId) =>
          physicalOwnership.cleanup(() => getBleManager().cancelDeviceConnection(deviceId)),
        ),
      );
    }
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
      // Mark inside the serialized GATT lane, immediately before the request;
      // a delayed notification from an earlier transaction cannot cross this
      // freshness floor while another queued operation is still running.
      if (frame[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST) {
        this.notificationInbox.markRosterRequest();
      } else {
        this.notificationInbox.markMutation();
      }
      // Both binary modes send one complete command and require separate roster confirmation.
      await this.runGattWithTimeout(
        this.acknowledgedWrites ? 'acknowledged write' : 'unacknowledged write',
        (transactionId) =>
          this.acknowledgedWrites
            ? write.writeWithResponse(uint8ArrayToBase64(frame), transactionId)
            : write.writeWithoutResponse(uint8ArrayToBase64(frame), transactionId),
        () => this.retireConnection('Quantum controller write timed out'),
      );
    });
  }

  getMutationFailure(command: QuantumCommand) {
    return this.notificationInbox.getMutationFailure(command);
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

  private async runGattWithTimeout<T>(
    operationName: string,
    operation: (transactionId: string) => Promise<T>,
    onTimeout: (cancelled: boolean) => void | Promise<void>,
  ): Promise<T> {
    const transactionId = nextQuantumTransactionId(operationName);
    const ownership = this.physicalOwnership;
    const generation = this.connectionAttemptGeneration;
    if (!ownership?.isCurrent()) throw quantumConnectionCancelledError();
    this.activeTransactionIds.add(transactionId);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const result = await Promise.race([
        operation(transactionId),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new QuantumGattTimeoutError(operationName));
          }, GATT_OPERATION_TIMEOUT_MS);
        }),
      ]);
      if (
        !ownership.isCurrent() ||
        this.physicalOwnership !== ownership ||
        this.connectionAttemptGeneration !== generation
      )
        throw quantumConnectionCancelledError();
      return result;
    } catch (error) {
      if (timedOut) {
        const cancelled = await this.cancelGattTransaction(transactionId, ownership);
        if (
          this.physicalOwnership === ownership &&
          ownership?.isCurrent() &&
          this.connectionAttemptGeneration === generation
        )
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
    const ownership = this.physicalOwnership;
    const generation = this.connectionAttemptGeneration;
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
      if (
        timedOut &&
        this.physicalOwnership === ownership &&
        ownership?.isCurrent() &&
        this.connectionAttemptGeneration === generation
      )
        await onTimeout();
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async cancelGattTransaction(transactionId: string, ownership = this.physicalOwnership): Promise<boolean> {
    if (!ownership?.isCurrent()) return false;
    let cancellationTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        getBleManager()
          .cancelTransaction(transactionId)
          .then(
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
    const ownership = this.physicalOwnership;
    this.clearConnectedHandles();
    this.gattTail = Promise.resolve();
    if (deviceId && ownership) void ownership.cleanup(() => getBleManager().cancelDeviceConnection(deviceId));
    this.disconnectListener?.({ description });
  }

  private clearConnectedHandles(): void {
    for (const transactionId of this.activeTransactionIds) {
      if (!this.physicalOwnership?.isCurrent()) continue;
      void getBleManager()
        .cancelTransaction(transactionId)
        .catch(() => {});
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
