import {
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  REDBEARLAB_SERVICE_UUID,
  parseSerialNumber,
} from '@boardsesh/ble-protocol';
import {
  boardBleNative,
  type NativeBleConfigureBoardOptions,
  type NativeBleScanEvent,
} from '../../../modules/live-activity/src/index';
import type { BluetoothAdapter, BleConnection, BoardScanFamily, DevicePickerFn, DiscoveredDevice } from './types';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';
import { isLikelyBoardDevice } from './board-device-filter';
import { upsertDiscoveredDevice } from './scan-device-cache';

/**
 * True when the running binary ships the newer BoardBle native surface
 * (`getConnectedDevice`, the `connected` event, unfiltered scanning). JS rides
 * OTA updates onto older binaries, so every new native capability is gated on
 * this check.
 */
export function nativeBleSupportsConnectionAdoption(): boolean {
  return typeof boardBleNative?.getConnectedDevice === 'function';
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    const value = bytes[byteIndex];
    hex += value.toString(16).padStart(2, '0');
  }
  return hex;
}

// Adapter that drives the BoardBleManager Swift singleton via the
// `@boardsesh/live-activity-module` Expo Module. iOS-only — guarded at the
// factory level. Keeps the encoding-in-JS pattern the existing
// `useBoardBluetooth` hook uses (climb frames → hex packet → native write),
// but additionally calls `configureBoard` so that the widget intent path
// (Dynamic Island next/prev → BoardBleManager.displayCurrentItemAwaitingReady)
// has the board metadata it needs to encode without going through JS.
export class NativeIosBleAdapter implements BluetoothAdapter {
  private connectedDeviceId: string | null = null;
  private disconnectCallback: (() => void) | null = null;
  private disconnectSubscription: { remove: () => void } | null = null;

  constructor(
    private readonly devicePicker: DevicePickerFn,
    private readonly scanFamily: BoardScanFamily = 'aurora',
  ) {
    if (!boardBleNative) {
      throw new Error('BoardBle native module not linked — rebuild the preview client');
    }
  }

  async isAvailable(): Promise<boolean> {
    const native = this.requireNative();
    const result = await native.isAvailable();
    return result.available;
  }

  // The scan/select flow (silent serial auto-select → grace-window picker
  // fallback → scan timeout) mirrors RNBleAdapter.requestAndConnect and the web
  // adapters. Kept in lockstep by hand; if you change one, change the others.
  async requestAndConnect(targetSerial?: string): Promise<BleConnection> {
    const native = this.requireNative();
    const devices = new Map<string, DiscoveredDevice>();
    let updateListener: ((devices: DiscoveredDevice[]) => void) | null = null;
    let scanStoppedListener: (() => void) | null = null;
    const pushDevices = () => updateListener?.([...devices.values()]);

    // One selection promise, resolved by either the silent serial auto-select
    // or — if that serial never shows up — the picker the grace window opens.
    let resolveSelection!: (deviceId: string) => void;
    let rejectSelection!: (error: Error) => void;
    const selectionPromise = new Promise<string>((resolve, reject) => {
      resolveSelection = resolve;
      rejectSelection = reject;
    });

    // True only while we're still silently matching the target serial — flips
    // false the moment we auto-select or hand off to the picker.
    let autoSelecting = Boolean(targetSerial);
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

    // No target serial → straight to the picker.
    if (!targetSerial) {
      openPicker();
    }

    // MoonBoard scans are unfiltered on newer binaries (a native service-UUID
    // filter would hide controllers that only surface via name). Aurora scans
    // stay filtered to avoid unrelated peripherals reaching the picker.
    const supportsUnfilteredScan = nativeBleSupportsConnectionAdoption();

    const scanSubscription = native.addListener('scanResult', (payload: NativeBleScanEvent) => {
      const deviceName = payload.localName || payload.device.name || undefined;
      if (
        !isLikelyBoardDevice({
          name: deviceName,
          serviceUuids: payload.serviceUuids,
          scanFamily: this.scanFamily,
        })
      ) {
        return;
      }
      const device: DiscoveredDevice = {
        deviceId: payload.device.deviceId,
        name: deviceName,
        rssi: payload.rssi,
      };
      if (upsertDiscoveredDevice(devices, device)) {
        pushDevices();
      }

      // Auto-select the stored board only until the picker takes over.
      if (autoSelecting && targetSerial) {
        const serial = parseSerialNumber(device.name);
        if (serial === targetSerial) {
          autoSelecting = false;
          resolveSelection(device.deviceId);
        }
      }
    });

    // startScan and the timers live inside the try so that a startScan failure
    // (Bluetooth toggled off / permission revoked mid-flow) still runs the
    // finally — otherwise the scanResult listener would leak and the scan stay
    // running.
    let pickerFallbackId: ReturnType<typeof setTimeout> | undefined;
    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let selectedDeviceId: string;
    try {
      const scanServiceUuids =
        this.scanFamily === 'aurora'
          ? [AURORA_ADVERTISED_SERVICE_UUID]
          : supportsUnfilteredScan
            ? []
            : // MoonBoard spans two controller generations: newer boards
              // advertise Nordic UART, the original RedBearLab box its own
              // service. Filter on both when an unfiltered scan isn't available.
              [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID];
      await native.startScan(scanServiceUuids);

      // Grace window: if the stored serial hasn't matched shortly, open the
      // picker (scan keeps running so it live-updates) instead of waiting out
      // the full scan window and failing. Matches the web reconnect-by-serial
      // fallback.
      pickerFallbackId = targetSerial
        ? setTimeout(() => {
            if (autoSelecting) openPicker();
          }, SERIAL_RECONNECT_GRACE_MS)
        : undefined;

      scanTimeoutId = setTimeout(() => {
        void native.stopScan();
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
      scanSubscription.remove();
      // Swallow stopScan rejections: a throw here (e.g. Bluetooth toggled off
      // mid-flow) would mask the original error — turning a user-cancel into a
      // spurious failure alert, or hiding the real scan/connect error.
      await native.stopScan().catch(() => {});
    }

    let selectedDeviceName: string | undefined;
    for (const device of devices.values()) {
      if (device.deviceId === selectedDeviceId) {
        selectedDeviceName = device.name;
        break;
      }
    }

    await native.connect(selectedDeviceId);

    this.trackConnectedDevice(selectedDeviceId);

    return {
      deviceId: selectedDeviceId,
      deviceName: selectedDeviceName,
    };
  }

  /**
   * Adopt a connection the native BoardBleManager already holds (a widget
   * intent reconnected in the background) without scanning or connecting:
   * just start tracking the device so writes and the disconnect callback
   * work. The caller is responsible for verifying the device actually is
   * connected (via `getConnectedDevice`) and for hook-level state.
   */
  adoptConnection(deviceId: string): void {
    this.trackConnectedDevice(deviceId);
  }

  private trackConnectedDevice(deviceId: string): void {
    const native = this.requireNative();
    this.disconnectSubscription?.remove();
    this.connectedDeviceId = deviceId;
    this.disconnectSubscription = native.addListener('disconnected', (payload) => {
      if (payload.deviceId !== deviceId) return;
      this.connectedDeviceId = null;
      this.disconnectSubscription?.remove();
      this.disconnectSubscription = null;
      this.disconnectCallback?.();
    });
  }

  async disconnect(): Promise<void> {
    // Belt-and-suspenders: drop the disconnect subscription regardless so an
    // abandoned adapter leaves no listener behind.
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = null;
    // The native BoardBleManager is a singleton. After an event-driven
    // self-clean (the 'disconnected' listener in trackConnectedDevice already
    // nulled connectedDeviceId), a blind native.disconnect() could cancel a
    // connection that was adopted by a *new* adapter after this one was
    // abandoned. So when we no longer track a device, skip the native call.
    if (!this.connectedDeviceId) return;
    const native = this.requireNative();
    this.connectedDeviceId = null;
    await native.disconnect();
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const native = this.requireNative();
    if (!this.connectedDeviceId) {
      throw new Error('Not connected');
    }
    if (signal?.aborted) {
      throw new DOMException('Write aborted', 'AbortError');
    }
    // Native side handles chunking (20-byte UART chunks with 5ms inter-chunk
    // delay) inside BoardBleManager, so we pass the full payload as a single
    // hex string. An abort while the chunks are still draining natively flushes
    // the native queue too — without cancelWrites the stale climb would keep
    // streaming to the wall after the caller gave up on it.
    if (!signal) {
      await native.write(uint8ArrayToHex(data));
      return;
    }
    const onAbort = () => {
      void native.cancelWrites().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await native.write(uint8ArrayToHex(data));
    } catch (error) {
      // The native queue rejects cancelled writes with its own error shape;
      // normalise to AbortError so callers classify it as a cancellation.
      if (signal.aborted) {
        throw new DOMException('Write aborted', 'AbortError');
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectCallback = callback;
    return () => {
      this.disconnectCallback = null;
    };
  }

  // Persists the active board configuration into BoardBleManager via shared
  // UserDefaults. Required for the widget intent path: when the user taps
  // next/previous on the Dynamic Island, the intent calls
  // `BoardBleManager.displayCurrentItemAwaitingReady(items, currentIndex)`
  // which encodes the wall packet using this configuration. Without this,
  // JS-driven writes still work (we already hex-encode in JS), but the
  // Dynamic Island path silently no-ops because BoardBleManager has no
  // configuration to encode against.
  async configureBoard(options: NativeBleConfigureBoardOptions): Promise<void> {
    const native = this.requireNative();
    await native.configureBoard(options);
  }

  private requireNative() {
    if (!boardBleNative) {
      throw new Error('BoardBle native module not linked');
    }
    return boardBleNative;
  }
}
