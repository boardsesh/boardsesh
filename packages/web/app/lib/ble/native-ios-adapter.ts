import type { BleConnection, BluetoothAdapter, DevicePickerFn, DiscoveredDevice } from './types';
import {
  AURORA_SCAN_SERVICE_UUIDS,
  parseSerialNumber,
} from '@/app/components/board-bluetooth-control/bluetooth-aurora';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from './scan-constants';

// Opt-in BLE tracing for on-device debugging. Append `?bleDebug` to the URL and
// watch the WebView console (Safari Web Inspector) to see whether native
// disconnect events arrive and whether their deviceId matches the connected one.
// Silent in normal use; loads live via the web app so no app rebuild is needed.
function bleDebugEnabled(): boolean {
  return typeof window !== 'undefined' && window.location.search.includes('bleDebug');
}

type NativeBoardBlePlugin = NonNullable<NonNullable<Window['Capacitor']>['Plugins']['BoardBle']>;
type NativeBoardBleListenerHandle = Awaited<ReturnType<NativeBoardBlePlugin['addListener']>>;

type NativeScanResult = {
  device?: { deviceId?: string; name?: string };
  localName?: string;
  rssi?: number;
};

function getNativeBoardBlePlugin(): NativeBoardBlePlugin {
  const plugin = window.Capacitor?.Plugins?.BoardBle;
  if (!plugin) {
    throw new Error('Native BoardBle plugin not available');
  }
  return plugin;
}

function toHexString(data: Uint8Array): string {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createAbortError(): DOMException | Error {
  if (typeof DOMException === 'function') {
    return new DOMException('Write aborted', 'AbortError');
  }
  const error = new Error('Write aborted');
  error.name = 'AbortError';
  return error;
}

async function normalizeListenerHandle(
  handle: NativeBoardBleListenerHandle | Promise<NativeBoardBleListenerHandle>,
): Promise<NativeBoardBleListenerHandle> {
  return await Promise.resolve(handle);
}

function stopScanQuietly(plugin: NativeBoardBlePlugin): Promise<void> {
  return plugin.stopScan().catch(() => {});
}

export class NativeIosBleAdapter implements BluetoothAdapter {
  constructor(private readonly devicePicker?: DevicePickerFn) {}

  private deviceId: string | null = null;
  private disconnectCallback: (() => void) | null = null;
  private disconnectListenerHandle: NativeBoardBleListenerHandle | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      const result = await getNativeBoardBlePlugin().isAvailable();
      return result.available;
    } catch {
      return false;
    }
  }

  async requestAndConnect(targetSerial?: string): Promise<BleConnection> {
    if (!this.devicePicker) {
      throw new Error('Native iOS BLE requires the Boardsesh device picker');
    }

    const devicePicker = this.devicePicker;
    const plugin = getNativeBoardBlePlugin();
    const devicesById = new Map<string, DiscoveredDevice>();
    let updateListener: ((devices: DiscoveredDevice[]) => void) | null = null;
    const pushDevices = () => updateListener?.([...devicesById.values()]);

    // One selection promise resolved by either the silent serial auto-select
    // or, if that serial never shows up, the picker the grace window opens.
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
      devicePicker((onUpdate) => {
        updateListener = onUpdate;
        pushDevices();
      }).then(resolveSelection, rejectSelection);
    };

    // No target serial → straight to the picker.
    if (!targetSerial) {
      openPicker();
    }

    const scanListener = await normalizeListenerHandle(
      plugin.addListener('scanResult', (data) => {
        const result = data as NativeScanResult;
        const deviceId = result.device?.deviceId;
        if (!deviceId) return;

        const previousDevice = devicesById.get(deviceId);
        const device: DiscoveredDevice = {
          deviceId,
          name: result.localName || result.device?.name || previousDevice?.name,
          rssi: result.rssi ?? previousDevice?.rssi ?? 0,
        };
        devicesById.set(deviceId, device);
        pushDevices();

        // Auto-select if this device matches the target serial (only until the
        // picker takes over).
        if (autoSelecting && targetSerial) {
          const serial = parseSerialNumber(device.name);
          if (serial === targetSerial) {
            autoSelecting = false;
            resolveSelection(device.deviceId);
          }
        }
      }),
    );

    await plugin.startScan({ services: [...AURORA_SCAN_SERVICE_UUIDS] });

    // Grace window: if the stored serial hasn't matched shortly, open the picker
    // (scan keeps running so it live-updates) instead of failing outright.
    const pickerFallbackId = targetSerial
      ? setTimeout(() => {
          if (autoSelecting) openPicker();
        }, SERIAL_RECONNECT_GRACE_MS)
      : undefined;

    // Auto-stop scan after timeout to prevent indefinite battery drain. By now
    // the picker is open (the grace window is shorter), so the user still sees
    // the last results — matching the no-target picker flow.
    const scanTimeoutId = setTimeout(() => {
      void stopScanQuietly(plugin);
      if (autoSelecting) openPicker();
    }, SCAN_TIMEOUT_MS);

    let selectedDeviceId: string;
    let selectedDeviceName: string | undefined;

    try {
      selectedDeviceId = await selectionPromise;
    } finally {
      if (pickerFallbackId) clearTimeout(pickerFallbackId);
      clearTimeout(scanTimeoutId);
      await scanListener.remove();
      await stopScanQuietly(plugin);
    }

    selectedDeviceName = devicesById.get(selectedDeviceId)?.name;

    await plugin.connect({ deviceId: selectedDeviceId });
    this.deviceId = selectedDeviceId;

    this.disconnectListenerHandle = await normalizeListenerHandle(
      plugin.addListener('disconnected', (data) => {
        if (bleDebugEnabled()) {
          console.debug('[ble] native disconnected event', {
            received: data.deviceId,
            expected: this.deviceId,
            willFire: data.deviceId === this.deviceId,
          });
        }
        if (data.deviceId === this.deviceId) {
          this.deviceId = null;
          this.disconnectListenerHandle = null;
          this.disconnectCallback?.();
        }
      }),
    );

    return {
      deviceId: selectedDeviceId,
      deviceName: selectedDeviceName,
    };
  }

  async disconnect(): Promise<void> {
    if (this.disconnectListenerHandle) {
      await this.disconnectListenerHandle.remove();
      this.disconnectListenerHandle = null;
    }

    if (this.deviceId) {
      try {
        await getNativeBoardBlePlugin().disconnect();
      } catch {
        // Ignore disconnect errors; the peripheral may already be gone.
      }
      this.deviceId = null;
    }
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!this.deviceId) {
      throw new Error('Not connected');
    }
    if (signal?.aborted) {
      throw createAbortError();
    }

    const plugin = getNativeBoardBlePlugin();
    const writePromise = plugin.write({ value: toHexString(data) });

    if (!signal) {
      await writePromise;
      return;
    }

    let abortHandler: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      abortHandler = () => {
        void plugin.cancelWrites?.().catch(() => {});
        reject(createAbortError());
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      await Promise.race([writePromise, abortPromise]);
    } finally {
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectCallback = callback;
    return () => {
      this.disconnectCallback = null;
    };
  }

  async configureBoard(options: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    apiLevel?: number;
    deviceName?: string;
    colorOverrides?: Record<string, string>;
  }): Promise<void> {
    await getNativeBoardBlePlugin().configureBoard(options);
  }
}
