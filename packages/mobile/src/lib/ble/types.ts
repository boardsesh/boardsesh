export type BleConnection = {
  deviceId: string;
  deviceName?: string;
  // True only when the Android ble-plx adapter recovered a transient first
  // GATT connect failure with its single in-budget retry.
  retrySucceeded?: boolean;
  // Advertisement recon payload of the connected device, threaded through so the
  // `Bluetooth Connection Success` event can carry it. See `AdvertisementRecon`.
  manufacturerData?: string;
  serviceData?: Record<string, string>;
};

export type DiscoveredDevice = {
  deviceId: string;
  name?: string;
  rssi: number;
} & AdvertisementRecon;

// Undocumented advertisement payload captured for PostHog reconnaissance. Newer
// Kilter-built boxes advertise a bare name with no `#serial@apiLevel` suffix, so
// the serial / LED generation may ride in manufacturer data or per-UUID service
// data instead. Canonical encoding is lowercase hex (both native iOS and the
// ble-plx base64→hex path normalize to it) so the field is comparable across
// platforms. Parsed nowhere yet — capture + telemetry only.
export type AdvertisementRecon = {
  manufacturerData?: string;
  serviceData?: Record<string, string>;
};

// Names the BLE PROTOCOL FAMILY, not a board brand. 'aurora' = the Aurora
// advertised-service boards (Kilter/Tension/...). 'moonboard' = the Nordic-UART
// family: MoonBoard AND Woods both ride it (same scan UUIDs, 20-byte chunks, no
// MTU negotiation) — Woods maps here via `scanFamilyForBoard`, with its
// board-specific transport need (acknowledged writes) expressed separately as
// `BleAdapterOptions.preferWriteWithResponse`, not as a third family. Before
// adding a variant for a new UART board, check whether an adapter option covers
// it: every consumer branches two ways on this type.
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
  initialWriteType?: 'withoutResponse' | 'withResponse';
  finalWriteType?: 'withoutResponse' | 'withResponse';
  writeTypeSource?:
    | 'defaultWithoutResponse'
    | 'watchdogFallback'
    | 'learnedPersistentFallback'
    | 'moonboardCharacteristic'
    // The board itself demands the write type, whatever the characteristic
    // advertises — see BleAdapterOptions.preferWriteWithResponse. JS-adapter
    // only; the Swift writer has no equivalent source.
    | 'boardPreference';
  chunkSize?: number;
  // PLANNED chunks for the write on both platforms (stamped at enqueue), not
  // progress — a write that fails mid-stream still reports the full plan.
  chunkCount?: number;
  negotiatedMaxWriteWithoutResponse?: number;
  negotiatedMtu?: number;
  parkCount?: number;
  peripheralIsReadyFired?: boolean;
  lastResumeSource?: 'callback' | 'poll' | 'bypass' | 'withResponse';
  maxParkMs?: number;
  totalParkMs?: number;
  watchdogTripped?: boolean;
  canSendAtTrip?: boolean;
  durationMs?: number;
};

// Diagnostics for a connect that failed during GATT discovery (#3480), for
// tagging the `service_missing` failure. Populated only by native iOS; a
// rejected connect promise can't carry it, so the adapter stashes it and the
// hook reads it right after the failure.
export type BleConnectDiagnostics = {
  // Service UUIDs the peripheral actually exposed before discovery failed. The
  // native module always reports this (possibly empty) when it hands back a
  // diagnostics object, so it's required. Empty means the board advertised no
  // known write service (stale iOS GATT cache or a decoy peripheral matched by
  // name); unfamiliar UUIDs point at a controller generation we don't handle yet.
  discoveredServices: string[];
};

/**
 * Per-board transport preferences handed to an adapter at construction.
 *
 * `preferWriteWithResponse` forces acknowledged GATT writes (write request)
 * regardless of what the write characteristic advertises. The Woods board needs
 * it: its protocol spec (§8, `docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md`) mandates
 * write requests, and the acknowledgement also paces the 20-byte chunks for its
 * Arduino-class firmware. Aurora boards must never set it — write-without-
 * response is their proven path.
 *
 * Only `RNBleAdapter` honours it. `NativeIosBleAdapter` accepts it for
 * signature symmetry but cannot act on it, because the write type of a native
 * write is chosen in Swift (`BoardBleEncoding.preferredWriteType`); the factory
 * routes boards that need acknowledged writes through `RNBleAdapter` instead.
 */
export type BleAdapterOptions = {
  preferWriteWithResponse?: boolean;
  // RNBleAdapter only: retry one transient first GATT connect failure before
  // surfacing it. Android only — set by createBluetoothAdapter from Platform.OS,
  // never by a board's own preferences.
  enableAndroidConnectRetry?: boolean;
};

export type BluetoothAdapter = {
  isAvailable(): Promise<boolean>;
  // `targetSerial` (Aurora) / `targetDeviceId` (MoonBoard) silently auto-select
  // the remembered board on the reconnect scan; with neither, the picker opens.
  requestAndConnect(targetSerial?: string, targetDeviceId?: string): Promise<BleConnection>;
  disconnect(): Promise<void>;
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>;
  onDisconnect(callback: (info?: BleDisconnectInfo) => void): () => void;
  // Transport diagnostics of the adapter's most recently settled write
  // (success or failure), for analytics tagging. Optional: web-era adapters
  // and old binaries don't report any.
  getLastWriteDiagnostics?(): Promise<BleWriteDiagnostics | null>;
  // Diagnostics of the adapter's most recent failed connect, for tagging a
  // service_missing report. Optional: only native iOS reports it.
  getLastConnectDiagnostics?(): Promise<BleConnectDiagnostics | null>;
};
