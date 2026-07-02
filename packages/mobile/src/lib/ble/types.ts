export type BleConnection = {
  deviceId: string;
  deviceName?: string;
};

export type DiscoveredDevice = {
  deviceId: string;
  name?: string;
  rssi: number;
};

export type BoardScanFamily = 'aurora' | 'moonboard';

// Best-effort reason for an unsolicited BLE drop, surfaced to analytics so we
// can tell a takeover (another phone grabbing the last-connection-wins board)
// apart from a range/idle timeout or an app-driven write-stall recovery. Fields
// are sparse — each adapter fills only what its platform exposes. `source` names
// which adapter observed the drop so a missing code reads as "platform didn't
// report one" rather than "we forgot to capture it".
export type BleDisconnectInfo = {
  source: 'native-ios' | 'ble-plx' | 'write-failure';
  // CoreBluetooth CBError code (native-ios: NSError.code; ble-plx: iosErrorCode).
  iosErrorCode?: number;
  // Android GATT status (ble-plx androidErrorCode).
  androidErrorCode?: number;
  // react-native-ble-plx BleErrorCode enum value.
  bleErrorCode?: number;
  // NSError domain (native-ios) — distinguishes CBErrorDomain from CBATTErrorDomain.
  errorDomain?: string;
  // App-side classification for drops we caused (write-stall recovery paths).
  context?: string;
  // Human-readable description (localizedDescription / ble-plx reason or message).
  description?: string;
};

// The picker subscribes for live device updates and, optionally, a one-shot
// signal that the scan has stopped (timeout) so it can drop its "scanning"
// spinner instead of implying a scan that's no longer running.
export type DevicePickerFn = (
  subscribe: (onUpdate: (devices: DiscoveredDevice[]) => void, onScanStopped?: () => void) => void,
) => Promise<string>;

// Per-write transport diagnostics (#3230), attached to the Climb Sent to Board
// analytics events. Sparse by platform: native iOS reports the full
// flow-control story (parks, resume source, watchdog); the ble-plx (Android)
// adapter only knows its negotiated MTU and chunking. Every field optional so
// adapters/binaries that can't report a value simply omit it.
export type BleWriteDiagnostics = {
  origin?: 'js' | 'native';
  writeType?: 'withoutResponse' | 'withResponse';
  chunkSize?: number;
  // PLANNED chunks for the write on both platforms (stamped at enqueue), not
  // progress — a write that fails mid-stream still reports the full plan.
  chunkCount?: number;
  negotiatedMaxWriteWithoutResponse?: number;
  negotiatedMtu?: number;
  parkCount?: number;
  peripheralIsReadyFired?: boolean;
  lastResumeSource?: 'callback' | 'poll';
  maxParkMs?: number;
  totalParkMs?: number;
  watchdogTripped?: boolean;
  canSendAtTrip?: boolean;
  durationMs?: number;
};

export type BluetoothAdapter = {
  isAvailable(): Promise<boolean>;
  requestAndConnect(targetSerial?: string): Promise<BleConnection>;
  disconnect(): Promise<void>;
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>;
  onDisconnect(callback: (info?: BleDisconnectInfo) => void): () => void;
  // Transport diagnostics of the adapter's most recently settled write
  // (success or failure), for analytics tagging. Optional: web-era adapters
  // and old binaries don't report any.
  getLastWriteDiagnostics?(): Promise<BleWriteDiagnostics | null>;
};
