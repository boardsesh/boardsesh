import { type Device, type Characteristic, type BleError } from 'react-native-ble-plx';
import {
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
  effectiveChunkSizeForMtu,
  INTER_CHUNK_DELAY_MS,
  MAX_BLUETOOTH_MESSAGE_SIZE,
  parseSerialNumber,
  isRetryableAndroidConnectError,
} from '@boardsesh/ble-protocol';
import { bleManager } from './ble-manager';
import { uint8ArrayToBase64, base64ToHex, serviceDataToHex } from './base64';
import { waitForBlePoweredOn } from './availability';
import { isLikelyBoardDevice } from './board-device-filter';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from './scan-options';
import { upsertDiscoveredDevice } from './scan-device-cache';
import type {
  BleAdapterOptions,
  BluetoothAdapter,
  BleConnection,
  BleDisconnectInfo,
  BleWriteDiagnostics,
  BoardScanFamily,
  DevicePickerFn,
  DiscoveredDevice,
} from './types';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';

const CONNECTION_TIMEOUT_MS = 12_000;
const ANDROID_CONNECT_RETRY_BACKOFF_MS = 500;

// The ATT MTU requested after connect. 247 (chunk 244) is the DLE-friendly
// sweet spot: the iOS-26.5 failure cohort clusters at ATT 512 (#3230), so
// don't ask for more than we'd ever write. The default ATT 23 (chunk 20) is
// the fallback when negotiation fails.
const REQUESTED_ATT_MTU = 247;
const DEFAULT_ATT_MTU = 23;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait the full retry backoff only when it fits inside the shared deadline.
 * Whichever timer wins clears the other, so a deadline during backoff cannot
 * leave a 500ms timer alive after the connect sequence has already settled. */
function waitForRetryBackoffBeforeDeadline(deadlineMs: number): Promise<boolean> {
  const remainingMs = deadlineMs - performance.now();
  if (remainingMs <= 0) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (completedFullBackoff: boolean) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (backoffTimer !== null) clearTimeout(backoffTimer);
      resolve(completedFullBackoff);
    };

    // Schedule the deadline first so an exact tie preserves the existing
    // semantics: no second attempt begins once the shared budget is exhausted.
    deadlineTimer = setTimeout(() => settle(false), remainingMs);
    backoffTimer = setTimeout(() => settle(true), ANDROID_CONNECT_RETRY_BACKOFF_MS);
  });
}

type DeadlineSettlement<T> =
  | { kind: 'fulfilled'; result: T }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'deadline' };

/**
 * Settle one connect-stage operation without extending the stage's shared
 * deadline. Both fulfillment and rejection handlers stay attached after the
 * deadline wins, so a late native promise cannot become an unhandled rejection.
 */
async function settleBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
): Promise<DeadlineSettlement<T>> {
  const remainingMs = deadlineMs - performance.now();
  if (remainingMs <= 0) return { kind: 'deadline' };

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const operationSettlement = Promise.resolve()
    .then(operation)
    .then(
      (result): DeadlineSettlement<T> => ({ kind: 'fulfilled', result }),
      (error: unknown): DeadlineSettlement<T> => ({ kind: 'rejected', error }),
    );
  const deadlineSettlement = new Promise<DeadlineSettlement<T>>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: 'deadline' }), remainingMs);
  });

  return Promise.race([operationSettlement, deadlineSettlement]).finally(() => {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  });
}

function connectionTimeoutError(): Error {
  return new Error('Connection timed out — board may be powered off');
}

/**
 * Find a write characteristic by service + characteristic UUID, returning
 * undefined when the service isn't present (react-native-ble-plx throws for an
 * absent service) so callers can fall back to another controller generation.
 */
async function findWriteCharacteristic(
  device: Device,
  serviceUuid: string,
  characteristicUuid: string,
): Promise<Characteristic | undefined> {
  try {
    const characteristics = await device.characteristicsForService(serviceUuid);
    return characteristics.find(
      (characteristic) => characteristic.uuid.toLowerCase() === characteristicUuid.toLowerCase(),
    );
  } catch {
    return undefined;
  }
}

export class RNBleAdapter implements BluetoothAdapter {
  private connectedDevice: Device | null = null;
  private writeCharacteristic: Characteristic | null = null;
  private disconnectCallback: ((info?: BleDisconnectInfo) => void) | null = null;
  private disconnectSubscription: { remove: () => void } | null = null;
  // Negotiated ATT MTU for the current connection; sizes write chunks (#3230).
  private negotiatedMtu = DEFAULT_ATT_MTU;
  // Transport diagnostics of the most recently settled write, for analytics.
  private lastWriteDiagnostics: BleWriteDiagnostics | null = null;
  // Board-level demand for acknowledged writes (see BleAdapterOptions). Fixed
  // for the adapter's lifetime — the board it was built for doesn't change.
  private readonly preferWriteWithResponse: boolean;
  // Whether a transient first GATT connect failure gets one in-budget retry
  // (see BleAdapterOptions.enableAndroidConnectRetry) — Android only.
  private readonly enableAndroidConnectRetry: boolean;
  // GATT connect attempts made by the most recent connect, for analytics.
  // Domain is 0/1/2: the adapter is constructed per connect
  // (use-board-bluetooth.ts createBluetoothAdapter), so 0 means the flow never
  // reached the GATT connect at all (picker cancelled, board not found, scan
  // error), 1 means a single attempt, and 2 means the retry ran.
  private lastConnectAttemptCount = 0;

  constructor(
    private readonly devicePicker: DevicePickerFn,
    private readonly scanFamily: BoardScanFamily = 'aurora',
    options?: BleAdapterOptions,
  ) {
    this.preferWriteWithResponse = options?.preferWriteWithResponse ?? false;
    this.enableAndroidConnectRetry = options?.enableAndroidConnectRetry ?? false;
  }

  /** Connect the already-selected peripheral, optionally recovering one known
   * Android GATT handshake failure without rescanning or reopening the picker. */
  private async connectSelectedDevice(
    selectedDeviceId: string,
  ): Promise<{ connected: Device; retrySucceeded: boolean }> {
    // Monotonic clock so a mid-connect wall-clock correction cannot stretch or
    // collapse the budget. The deadline arithmetic here relies on Vitest faking
    // `performance.now` alongside the timers — it does by default, so never add
    // an explicit `toFake` list that omits `performance` or the boundary tests
    // silently freeze the clock and pass for the wrong reason.
    const deadlineMs = performance.now() + CONNECTION_TIMEOUT_MS;
    this.lastConnectAttemptCount = 0;
    const attemptConnect = () => {
      this.lastConnectAttemptCount += 1;
      return settleBeforeDeadline(() => bleManager.connectToDevice(selectedDeviceId), deadlineMs);
    };
    const cancelWithoutWaiting = () => {
      void bleManager.cancelDeviceConnection(selectedDeviceId).catch(() => {});
    };

    const firstAttempt = await attemptConnect();
    if (firstAttempt.kind === 'deadline') {
      cancelWithoutWaiting();
      throw connectionTimeoutError();
    }
    if (firstAttempt.kind === 'fulfilled') {
      return { connected: firstAttempt.result, retrySucceeded: false };
    }

    const firstError = firstAttempt.error;
    if (!this.enableAndroidConnectRetry || !isRetryableAndroidConnectError(firstError)) {
      throw firstError;
    }

    // Close the failed native GATT handle before retrying. A rejection generally
    // means it was already closed, so it must not block the retry. A hanging
    // cleanup is bounded by the original connect deadline.
    const cleanup = await settleBeforeDeadline(() => bleManager.cancelDeviceConnection(selectedDeviceId), deadlineMs);
    if (cleanup.kind === 'deadline') throw firstError;

    const completedBackoff = await waitForRetryBackoffBeforeDeadline(deadlineMs);
    if (!completedBackoff) throw firstError;

    const secondAttempt = await attemptConnect();
    if (secondAttempt.kind === 'deadline') {
      cancelWithoutWaiting();
      throw connectionTimeoutError();
    }
    if (secondAttempt.kind === 'fulfilled') {
      return { connected: secondAttempt.result, retrySucceeded: true };
    }

    const secondError = secondAttempt.error;
    if (isRetryableAndroidConnectError(secondError)) {
      // No third attempt. Close the exhausted handle without waiting: we already
      // have the terminal error, so awaiting a cleanup that may hang would only
      // keep the climber on a spinner before we can show it.
      cancelWithoutWaiting();
    }
    throw secondError;
  }

  async isAvailable(): Promise<boolean> {
    return waitForBlePoweredOn();
  }

  // The scan/select flow (silent serial auto-select → grace-window picker
  // fallback → scan timeout) mirrors NativeIosBleAdapter.requestAndConnect and
  // the web adapters. Kept in lockstep by hand; if you change one, change the others.
  async requestAndConnect(targetSerial?: string, targetDeviceId?: string): Promise<BleConnection> {
    // Reset up front so a reused adapter whose reconnect fails before MTU
    // negotiation can't write with the previous connection's stale MTU.
    this.negotiatedMtu = DEFAULT_ATT_MTU;
    const devices = new Map<string, DiscoveredDevice>();
    let updateListener: ((devices: DiscoveredDevice[]) => void) | null = null;
    let scanStoppedListener: (() => void) | null = null;
    const pushDevices = () => updateListener?.([...devices.values()]);

    // One selection promise, resolved by either the silent auto-select (by serial
    // or device id) or — if the target never shows up — the picker the grace
    // window opens.
    let resolveSelection!: (deviceId: string) => void;
    let rejectSelection!: (error: Error) => void;
    const selectionPromise = new Promise<string>((resolve, reject) => {
      resolveSelection = resolve;
      rejectSelection = reject;
    });

    // True only while we're still silently matching the reconnect target — flips
    // false the moment we auto-select or hand off to the picker.
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

    // No reconnect target → straight to the picker.
    if (!targetSerial && !targetDeviceId) {
      openPicker();
    }

    // The scan start and the timers live inside the try so that a
    // startDeviceScan failure still runs the finally — otherwise the scan could
    // be left running and the timers (if any) uncleared.
    let pickerFallbackId: ReturnType<typeof setTimeout> | undefined;
    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let selectedDeviceId: string;
    try {
      // Scan UNFILTERED and filter results in JS (isLikelyBoardDevice below).
      // A hardware service-UUID ScanFilter never matches by name, and on Android
      // its offloaded matcher is unreliable for a 128-bit UUID a box carries only
      // in its scan-response PDU — such a box can be dropped before JS ever sees
      // it. MoonBoard already required an unfiltered scan; Aurora matches it since
      // #3806. The JS filter reads ble-plx's merged advertise+scan-response
      // record, so it still surfaces both Aurora-built (`Kilter Board#serial@N`)
      // and Kilter-built bare-name (`Kilter Board`) boxes while rejecting
      // non-boards.
      //
      // Do NOT read this as "the Aurora scan filter caused the Android
      // empty-picker regression" — an earlier version of this comment did, and it
      // sent at least one investigation down a dead end (#3821). The filter was
      // cleared: 2.1.0 shipped the same filter and was healthy, and the ~2x rise
      // in Android `devicesTotal=0` tracks the Expo 57 / React Native 0.86 native
      // scan-reliability drop instead. #3806 (unfiltering) was explicitly
      // robustness-only; #3811 (LowLatency, see scan-options.ts) is the
      // root-cause mitigation. Unfiltering here buys name-only discovery, not a
      // regression fix — and it is an ANDROID argument: iOS CoreBluetooth scans
      // actively in the foreground and merges ADV + SCAN_RSP before filtering, so
      // the native iOS path keeps its service filter on purpose.
      // High-power scan options (LowLatency on Android) — see scan-options.ts.
      void bleManager.startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (scanError, scannedDevice) => {
        if (scanError) {
          void bleManager.stopDeviceScan();
          // Surface the failure immediately so the user sees feedback instead
          // of waiting out the 30s scan window (the picker, if open, closes too).
          rejectSelection(new Error(`BLE scan failed: ${scanError.message}`));
          return;
        }

        if (!scannedDevice) return;

        const deviceName = scannedDevice.localName ?? scannedDevice.name ?? undefined;
        // Overflow UUIDs cover iOS peripherals whose advertisement is too full
        // to carry the service list in the main packet.
        const advertisedServiceUuids = [
          ...(scannedDevice.serviceUUIDs ?? []),
          ...(scannedDevice.overflowServiceUUIDs ?? []),
        ];
        if (
          !isLikelyBoardDevice({ name: deviceName, serviceUuids: advertisedServiceUuids, scanFamily: this.scanFamily })
        ) {
          return;
        }

        const device: DiscoveredDevice = {
          deviceId: scannedDevice.id,
          name: deviceName,
          rssi: scannedDevice.rssi ?? -100,
          // ble-plx surfaces these as base64; normalize to hex so the recon
          // payload matches the native iOS path (omitted when absent/empty).
          manufacturerData: base64ToHex(scannedDevice.manufacturerData),
          serviceData: serviceDataToHex(scannedDevice.serviceData),
        };
        if (upsertDiscoveredDevice(devices, device)) {
          pushDevices();
        }

        // Auto-select the stored board only until the picker takes over. A
        // MoonBoard has no serial, so it matches on the remembered BLE device id;
        // Aurora boards match on the serial parsed from the advertised name.
        if (autoSelecting) {
          const matchesDeviceId = targetDeviceId !== undefined && device.deviceId === targetDeviceId;
          const matchesSerial = targetSerial !== undefined && parseSerialNumber(device.name) === targetSerial;
          if (matchesDeviceId || matchesSerial) {
            autoSelecting = false;
            resolveSelection(device.deviceId);
          }
        }
      });

      // Grace window: if the remembered board hasn't matched shortly, open the
      // picker (scan keeps running so it live-updates) instead of waiting out
      // the full scan window and failing. Matches the web reconnect-by-serial
      // fallback.
      pickerFallbackId =
        targetSerial || targetDeviceId
          ? setTimeout(() => {
              if (autoSelecting) openPicker();
            }, SERIAL_RECONNECT_GRACE_MS)
          : undefined;

      scanTimeoutId = setTimeout(() => {
        void bleManager.stopDeviceScan();
        // Belt-and-suspenders: make sure the picker is open even if the grace
        // window never fired.
        if (autoSelecting) openPicker();
        // The picker is showing but nothing ever advertised — surface the empty
        // result so the sheet doesn't spin forever.
        if (pickerOpened && devices.size === 0) {
          rejectSelection(new Error('No boards found within scan window'));
        } else {
          // Devices were found but none picked yet — tell the picker the scan
          // stopped so it drops the spinner instead of implying a live scan.
          scanStoppedListener?.();
        }
      }, SCAN_TIMEOUT_MS);

      selectedDeviceId = await selectionPromise;
    } finally {
      if (pickerFallbackId) clearTimeout(pickerFallbackId);
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      void bleManager.stopDeviceScan();
    }

    let selectedDeviceName: string | undefined;
    let selectedManufacturerData: string | undefined;
    let selectedServiceData: Record<string, string> | undefined;
    for (const device of devices.values()) {
      if (device.deviceId === selectedDeviceId) {
        selectedDeviceName = device.name;
        selectedManufacturerData = device.manufacturerData;
        selectedServiceData = device.serviceData;
        break;
      }
    }

    const { connected, retrySucceeded } = await this.connectSelectedDevice(selectedDeviceId);

    // Negotiate MTU before service discovery (Android requires this order
    // for best results; iOS handles MTU automatically but the call is safe).
    // The negotiated value sizes write chunks below — fewer, larger writes
    // per climb, mirroring the native iOS path and the official Kilter app
    // (#3230). Skipped for the moonboard family: chunks stay at 20 there
    // regardless, and the original RedBearLab box is old enough that the
    // fewer GATT ops we throw at it, the better.
    // `||` (not `??`) is deliberate: ble-plx types mtu as number, so the only
    // bad runtime values are falsy ones (0/NaN), which must also fall back.
    if (this.scanFamily === 'moonboard') {
      this.negotiatedMtu = DEFAULT_ATT_MTU;
    } else {
      try {
        const negotiated = await connected.requestMTU(REQUESTED_ATT_MTU);
        this.negotiatedMtu = negotiated.mtu || DEFAULT_ATT_MTU;
      } catch {
        // Negotiation failed — fall back to the default ATT 23 (20 usable).
        this.negotiatedMtu = connected.mtu || DEFAULT_ATT_MTU;
      }
    }

    const deviceWithServices = await connected.discoverAllServicesAndCharacteristics();

    // Newer controllers expose the write characteristic on the Nordic UART
    // service. The original MoonBoard (RedBearLab) LED box uses a different
    // service, so fall back to it for the moonboard family.
    let writeCharacteristic = await findWriteCharacteristic(
      deviceWithServices,
      UART_SERVICE_UUID,
      UART_WRITE_CHARACTERISTIC_UUID,
    );
    if (!writeCharacteristic && this.scanFamily === 'moonboard') {
      writeCharacteristic = await findWriteCharacteristic(
        deviceWithServices,
        REDBEARLAB_SERVICE_UUID,
        REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
      );
    }

    if (!writeCharacteristic) {
      await bleManager.cancelDeviceConnection(selectedDeviceId);
      throw new Error('UART write characteristic not found');
    }

    this.connectedDevice = deviceWithServices;
    this.writeCharacteristic = writeCharacteristic;

    this.disconnectSubscription = bleManager.onDeviceDisconnected(selectedDeviceId, (error, _device) => {
      this.connectedDevice = null;
      this.writeCharacteristic = null;
      this.disconnectSubscription?.remove();
      this.disconnectSubscription = null;
      this.disconnectCallback?.(bleErrorToDisconnectInfo(error));
    });

    return {
      deviceId: selectedDeviceId,
      deviceName: selectedDeviceName,
      manufacturerData: selectedManufacturerData,
      serviceData: selectedServiceData,
      retrySucceeded,
    };
  }

  async disconnect(): Promise<void> {
    if (this.disconnectSubscription) {
      this.disconnectSubscription.remove();
      this.disconnectSubscription = null;
    }

    if (this.connectedDevice) {
      const deviceId = this.connectedDevice.id;
      this.connectedDevice = null;
      this.writeCharacteristic = null;
      try {
        await bleManager.cancelDeviceConnection(deviceId);
      } catch {
        // Device may already be disconnected
      }
    }
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const writeCharacteristic = this.writeCharacteristic;
    if (!writeCharacteristic) {
      throw new Error('Not connected');
    }

    // Aurora chunks are sized from the negotiated MTU (clamped well below the
    // ATT-512 cliff, see #3230). Both MoonBoard generations stay on the proven
    // 20-byte chunks, mirroring the native iOS effectiveChunkSize gating.
    const chunkSize =
      this.scanFamily === 'moonboard' ? MAX_BLUETOOTH_MESSAGE_SIZE : effectiveChunkSizeForMtu(this.negotiatedMtu);
    const chunks = splitMessages(data, chunkSize);
    // Aurora boards always use write-without-response (proven path; on some
    // iOS versions the characteristic under-reports the property but still
    // needs no-response). Only the original MoonBoard (RedBearLab) write
    // characteristic — which advertises `.write` only — falls back to
    // write-with-response, mirroring the native preferredWriteType gating.
    // Android sends no-response writes regardless, so this only matters on
    // Expo Go iOS. Decided once per write (the characteristic object never
    // changes mid-write, only nulls on disconnect) so the dispatch below and
    // the diagnostics report the same value by construction.
    //
    // preferWriteWithResponse overrides both gates: the Woods board's firmware
    // is Arduino-class and its protocol spec (§8) mandates acknowledged writes,
    // whatever its Nordic-UART characteristic advertises. The acknowledgement
    // also paces the 20-byte chunks for us. Aurora never sets the flag, so it
    // stays unconditionally on write-without-response.
    const usesWithoutResponse =
      !this.preferWriteWithResponse &&
      (this.scanFamily !== 'moonboard' || (writeCharacteristic.isWritableWithoutResponse ?? true));
    // Every write through this adapter is JS-driven (Android has no
    // widget-intent write path), hence the fixed 'js' origin. Only the board
    // preference names a writeTypeSource — the family/characteristic gate is
    // this adapter's long-standing default and has never reported one.
    this.lastWriteDiagnostics = {
      origin: 'js',
      writeType: usesWithoutResponse ? 'withoutResponse' : 'withResponse',
      ...(this.preferWriteWithResponse ? { writeTypeSource: 'boardPreference' as const } : {}),
      negotiatedMtu: this.negotiatedMtu,
      chunkSize,
      chunkCount: chunks.length,
    };

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (signal?.aborted) {
        throw new DOMException('Write aborted', 'AbortError');
      }

      if (chunkIndex > 0) {
        await delay(INTER_CHUNK_DELAY_MS);
        if (signal?.aborted) {
          throw new DOMException('Write aborted', 'AbortError');
        }
      }

      // Re-check the characteristic before each chunk — a mid-write
      // disconnect sets it to null via the onDeviceDisconnected handler.
      const characteristic = this.writeCharacteristic;
      if (!characteristic) {
        throw new Error('Device disconnected during write');
      }

      const chunk = chunks[chunkIndex];
      const base64Chunk = uint8ArrayToBase64(chunk);

      try {
        if (usesWithoutResponse) {
          await characteristic.writeWithoutResponse(base64Chunk);
        } else {
          await characteristic.writeWithResponse(base64Chunk);
        }
      } catch (error) {
        // react-native-ble-plx surfaces a mid-write drop as a BleError whose
        // message (e.g. CharacteristicWriteFailed — "Characteristic … write
        // failed for device …") doesn't name the disconnect, so
        // isDisconnectionError can't classify it from the message. Probe the
        // live link: if the device is actually gone, normalise to the
        // disconnect signature the write-failure path keys on so the lightbulb
        // darkens; otherwise rethrow the original error untouched (a genuine
        // transient write failure on a live link must not look like a drop).
        const stillConnected = await this.connectedDevice?.isConnected().catch(() => false);
        if (!stillConnected) {
          throw new Error('Device disconnected during write');
        }
        throw error;
      }
    }
  }

  onDisconnect(callback: (info?: BleDisconnectInfo) => void): () => void {
    this.disconnectCallback = callback;
    return () => {
      this.disconnectCallback = null;
    };
  }

  // ble-plx can't observe CoreBluetooth-style flow control, so this only
  // carries the MTU/chunking story; the park/resume fields are iOS-native-only.
  async getLastWriteDiagnostics(): Promise<BleWriteDiagnostics | null> {
    return this.lastWriteDiagnostics;
  }

  // 0 when the flow never reached the GATT connect, 1 for a single attempt,
  // 2 when the Android retry ran. Pairs with `retrySucceeded` to give the retry
  // a denominator: 2 + success is a save, 2 + failure is a retry that lost.
  getLastConnectAttemptCount(): number {
    return this.lastConnectAttemptCount;
  }
}

// Normalise a react-native-ble-plx disconnect error into the cross-adapter
// shape. `onDeviceDisconnected` passes null on a clean drop; an unexpected drop
// (RF loss, another central grabbing the board) carries a BleError whose
// iosErrorCode/androidErrorCode is the platform's real reason code.
function bleErrorToDisconnectInfo(error: BleError | null): BleDisconnectInfo {
  if (!error) return { source: 'ble-plx' };
  return {
    source: 'ble-plx',
    bleErrorCode: error.errorCode,
    iosErrorCode: error.iosErrorCode ?? undefined,
    androidErrorCode: error.androidErrorCode ?? undefined,
    description: error.reason ?? error.message ?? undefined,
  };
}
