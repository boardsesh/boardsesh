import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

// --- BoardBle native module ---

export type NativeBleScanEvent = {
  device: { deviceId: string; name: string };
  localName: string;
  rssi: number;
  /**
   * Advertised service UUIDs from the advertisement packet. Only present on
   * binaries new enough to scan unfiltered (the ones that also expose
   * `getConnectedDevice`); older binaries scan with a native UUID filter and
   * omit the field.
   */
  serviceUuids?: string[];
  /**
   * Advertisement manufacturer-specific data, lowercase hex. Recon-only
   * (parsed nowhere yet): newer bare-name boxes may carry their serial / LED
   * generation here. Optional — omitted when the packet has none, and absent
   * on binaries older than this field.
   */
  manufacturerData?: string;
  /**
   * Advertisement service-data, `{ uuid: hexBytes }`. Where the undocumented
   * custom GATT UUIDs would surface if advertised. Optional/omitted as above.
   */
  serviceData?: Record<string, string>;
};

export type NativeBleDisconnectEvent = {
  deviceId: string;
  // CoreBluetooth disconnect reason, present when iOS supplied an NSError on
  // didDisconnectPeripheral. Absent on a clean/expected drop, or when the drop
  // came from an app-driven write-stall recovery (which sets `context` instead).
  errorCode?: number;
  errorDomain?: string;
  errorDescription?: string;
  // App-side classification for drops the native layer caused itself (write-stall
  // budget exhausted, recovery reconnect failed/timed out).
  context?: string;
};

export type NativeBleConnectedEvent = {
  deviceId: string;
  deviceName?: string;
};

export type NativeBleConnectedDevice = {
  deviceId: string;
  name?: string;
  /**
   * Connect-time BLE write diagnostics. Only present on binaries new enough to
   * report them (gate on a field being defined, not just on `getConnectedDevice`
   * existing). Used to diagnose write stalls: whether the UART RX characteristic
   * advertised write-without-response, and which write type was chosen.
   */
  characteristicProperties?: number;
  supportsWriteWithoutResponse?: boolean;
  chosenWriteType?: 'withoutResponse' | 'withResponse';
  maxWriteWithResponse?: number;
  maxWriteWithoutResponse?: number;
};

/**
 * Per-write BLE transport telemetry (#3230), reported by the native write path
 * so `Climb Sent to Board` events can carry a measurable before/after for the
 * iOS 26.5 `peripheralIsReady` write stall. `write()` resolves it on success;
 * after a rejected write, fetch the failed write's copy via
 * `getLastWriteDiagnostics`.
 */
export type NativeBleWriteDiagnostics = {
  origin: 'js' | 'native';
  writeType: 'withoutResponse' | 'withResponse';
  initialWriteType?: 'withoutResponse' | 'withResponse';
  finalWriteType?: 'withoutResponse' | 'withResponse';
  writeTypeSource?:
    | 'defaultWithoutResponse'
    | 'watchdogFallback'
    | 'learnedPersistentFallback'
    | 'moonboardCharacteristic';
  chunkSize: number;
  /** Planned chunks for the write (stamped at enqueue), not progress. */
  chunkCount: number;
  negotiatedMaxWriteWithoutResponse: number;
  /** Times a chunk parked on `canSendWriteWithoutResponse` during this write. */
  parkCount: number;
  /** Whether iOS delivered the `peripheralIsReady` delegate during this write. */
  peripheralIsReadyFired: boolean;
  /** What woke the last parked chunk: the delegate, poller, bypass, or fallback switch. */
  lastResumeSource?: 'callback' | 'poll' | 'bypass' | 'withResponse';
  maxParkMs: number;
  totalParkMs: number;
  /** The 5 s stall watchdog fired (the write then failed as write_timeout). */
  watchdogTripped: boolean;
  /** `canSendWriteWithoutResponse` at the moment the watchdog fired. */
  canSendAtTrip?: boolean;
  durationMs: number;
};

/**
 * Diagnostics for a connect that failed during GATT service/characteristic
 * discovery (#3480). Fetched via `getLastConnectDiagnostics` right after a
 * rejected `connect`, so a `service_missing` report can distinguish "the board
 * exposed nothing" (stale iOS cache / decoy peripheral → empty array) from an
 * unknown third controller generation (unfamiliar service UUIDs).
 */
export type NativeBleConnectDiagnostics = {
  /** Service UUIDs actually discovered on the peripheral before it failed. */
  discoveredServices: string[];
};

export type NativeBleConfigureBoardOptions = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  apiLevel?: number;
  deviceName?: string;
  colorOverrides?: Record<string, string>;
  /**
   * MoonBoard grid rows (18 standard, 12 Mini) so native re-encodes (widget
   * intents, reconnect re-light) address the right serpentine grid (#3392).
   * Older binaries ignore it.
   */
  numRows?: number;
  /**
   * MoonBoard "V2" additional-LED feature — see BoardBleEncoding.swift
   * (makeMoonboardPacket). No-op on Aurora boards; older binaries ignore it.
   */
  lightAdjacentHolds?: boolean;
};

type BoardBleNativeModule = {
  isAvailable(): Promise<{ available: boolean }>;
  /** An empty `services` array means "scan unfiltered" on newer binaries. */
  startScan(services?: string[]): Promise<void>;
  stopScan(): Promise<void>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Resolves the write's transport diagnostics on binaries new enough to
   * report them; older binaries resolve nothing. Treat a nullish result as
   * "no diagnostics".
   */
  write(value: string): Promise<NativeBleWriteDiagnostics | null | void>;
  cancelWrites(): Promise<void>;
  configureBoard(options: NativeBleConfigureBoardOptions): Promise<void>;
  /**
   * Returns the natively-connected board, or null. Only present on newer
   * binaries — its presence doubles as the feature gate for unfiltered
   * scanning, the `connected` event and connection adoption, so always check
   * `typeof getConnectedDevice === 'function'` before relying on any of them
   * (an OTA JS update can run against an older binary).
   */
  getConnectedDevice?(): Promise<NativeBleConnectedDevice | null>;
  /**
   * Diagnostics of the most recent failed JS write, for tagging the failure
   * analytics event (a rejected promise can't carry them). Only present on
   * newer binaries — gate on `typeof getLastWriteDiagnostics === 'function'`
   * (an OTA JS update can run against an older binary).
   */
  getLastWriteDiagnostics?(): Promise<NativeBleWriteDiagnostics | null>;
  /**
   * Diagnostics of the most recent failed JS connect, for tagging a
   * `service_missing` failure with the services the board actually exposed (a
   * rejected promise can't carry them). Only present on newer binaries — gate
   * on `typeof getLastConnectDiagnostics === 'function'` (an OTA JS update can
   * run against an older binary). See #3480.
   */
  getLastConnectDiagnostics?(): Promise<NativeBleConnectDiagnostics | null>;
  addListener(event: 'scanResult', listener: (payload: NativeBleScanEvent) => void): EventSubscription;
  addListener(event: 'disconnected', listener: (payload: NativeBleDisconnectEvent) => void): EventSubscription;
  addListener(event: 'connected', listener: (payload: NativeBleConnectedEvent) => void): EventSubscription;
};

// requireOptionalNativeModule returns null in Expo Go or any binary without
// the module linked (Android, dev clients built before this module was added).
// Callers should check for null before invoking.
export const boardBleNative = requireOptionalNativeModule<BoardBleNativeModule>('BoardBle');

// --- LiveActivity native module ---

/**
 * Board-connection state from THIS device's point of view, driving the Live
 * Activity lightbulb + Previous/Next visibility:
 * - `connectedByMe`: this device holds the BLE link → bulb lit, controls shown.
 * - `heldByPeer`: someone else drives the board → bulb out, controls hidden,
 *   card shows the climb on the wall.
 * - `disconnected`: nobody is driving → bulb out (tap to reconnect), controls
 *   hidden.
 * Kept in sync with the in-app lightbulb via `deriveBoardConnection`.
 */
export type LiveActivityBoardConnection = 'connectedByMe' | 'heldByPeer' | 'disconnected';

export type LiveActivityStartSessionOptions = {
  sessionId: string;
  serverUrl: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  authToken?: string;
  wsUrl?: string;
  graphqlUrl?: string;
  widgetNavigationAllowed: boolean;
  isPartySession: boolean;
  /** Board-connection state from this device's POV (see the type doc). */
  boardConnection: LiveActivityBoardConnection;
  /** Display name of the peer holding the board (heldByPeer only). */
  holderDisplayName?: string | null;
  /**
   * Bundled board-background webp file paths for the active board, resolved on
   * the JS side (expo-asset) and staged into the App Group so the iOS
   * ThumbnailFetcher can composite them behind the server's holds-only overlay —
   * keeping board art off the network. Ordered base layers (drawn first). iOS
   * only; the Android foreground service ignores it.
   */
  boardBackgroundPaths?: string[];
  /**
   * Localized strings for the Android foreground-service notification. Ignored
   * on iOS (ActivityKit builds its UI in Swift). Supplied so the ongoing
   * notification + its Previous/Next actions respect the app locale instead of
   * hardcoding English in Kotlin.
   */
  androidNotification?: {
    channelName: string;
    channelDescription: string;
    contentTitleFallback: string;
    previousLabel: string;
    nextLabel: string;
    /** Lightbulb action label while this device drives the wall (connectedByMe). */
    relightLabel: string;
    /** Lightbulb action label while a peer holds it / nobody is driving. */
    reconnectLabel: string;
    /** "{{name}} is on the wall" template; Kotlin substitutes holderDisplayName. */
    onWallTemplate: string;
  };
};

export type LiveActivityQueueItem = {
  uuid: string;
  climbUuid: string;
  climbName: string;
  difficulty: string;
  angle: number;
  frames: string;
  setterUsername: string;
  mirrored: boolean;
};

export type LiveActivityUpdateOptions = {
  climbName: string;
  climbDifficulty: string;
  angle: number;
  currentIndex: number;
  totalClimbs: number;
  hasNext: boolean;
  hasPrevious: boolean;
  climbUuid: string;
  queue: LiveActivityQueueItem[];
  widgetNavigationAllowed: boolean;
  isPartySession: boolean;
  /** Board-connection state from this device's POV (see the type doc). */
  boardConnection: LiveActivityBoardConnection;
  /** Display name of the peer holding the board (heldByPeer only). */
  holderDisplayName?: string | null;
  /**
   * Android-only: on-device climb render for the notification thumbnail, so it
   * never hits the network (the app's "no-network board art" rule). `file://`
   * holds-only PNG from the BoardRenderer native module, layered over the bundled
   * board background image paths. The foreground service composites them; iOS
   * ignores these (ActivityKit fetches its own thumbnail).
   */
  androidThumbnailOverlayPath?: string | null;
  androidThumbnailBackgroundPaths?: string[];
};

export type LiveActivityClimbUpdateOptions = Omit<LiveActivityUpdateOptions, 'queue'>;

export type WidgetQueueNavigateEvent = {
  action: 'next' | 'previous';
  currentIndex: number;
  correlationId: string;
};

export type LiveActivityIntentDiagnosticKind = 'nextClimb' | 'previousClimb' | 'takeControl' | 'reconnectBoard';

export type LiveActivityIntentDiagnosticStage =
  | 'entered'
  | 'networkStarted'
  | 'networkFinishedSuccess'
  | 'networkFinishedRetryable'
  | 'networkFinishedTerminal'
  | 'activityKitUpdated'
  | 'bleStarted'
  | 'bleFinishedSuccess'
  | 'bleFinishedFailure'
  | 'darwinPosted'
  | 'completed';

export type LiveActivityIntentCompletionClass =
  | 'success'
  | 'sharedDefaultsUnavailable'
  | 'navigationOutOfBounds'
  | 'serverRejected'
  | 'retryableNetworkFailure'
  | 'localNavigationEnabled'
  | 'alreadyAllowed'
  | 'bleFailure';

export type InterruptedLiveActivityIntentDiagnostic = {
  schemaVersion: 1;
  runId: string;
  processId: string;
  intentKind: LiveActivityIntentDiagnosticKind;
  appVersion: string;
  buildNumber: string;
  startedAtMs: number;
  updatedAtMs: number;
  lastStage: Exclude<LiveActivityIntentDiagnosticStage, 'completed'>;
  reactRootMounted: boolean;
};

/**
 * Android-only: a tap on the foreground-service notification's lightbulb.
 * - `reconnect`: bulb was out (heldByPeer / disconnected) → reconnect to the
 *   last board, taking it back from a peer (Aurora is last-connection-wins).
 * - `reassert`: bulb was lit (connectedByMe) → re-push the current climb to the
 *   wall. iOS drives the equivalent through App Intents, not this event.
 */
export type BoardControlEvent = {
  action: 'reconnect' | 'reassert';
  correlationId: string;
};

type LiveActivityNativeModule = {
  isAvailable(): Promise<{ available: boolean }>;
  startSession(options: LiveActivityStartSessionOptions): Promise<void>;
  endSession(): Promise<void>;
  updateActivity(options: LiveActivityUpdateOptions): Promise<void>;
  updateActivityClimb(options: LiveActivityClimbUpdateOptions): Promise<void>;
  /** Optional for OTA compatibility with binaries predating #4077. */
  markIntentReactRootMounted?(): Promise<void>;
  /** Optional for OTA compatibility with binaries predating #4077. */
  consumeInterruptedIntentRuns?(): Promise<InterruptedLiveActivityIntentDiagnostic[]>;
  addListener(event: 'queueNavigate', listener: (payload: WidgetQueueNavigateEvent) => void): EventSubscription;
};

export const liveActivityNative = requireOptionalNativeModule<LiveActivityNativeModule>('LiveActivity');

// --- SessionPresence native module (Android) ---

// The Android counterpart to the iOS LiveActivity module: a foreground service +
// ongoing media-style notification that keeps the BLE connection alive in the
// background and surfaces Previous/Next session controls. It deliberately
// mirrors the LiveActivity method names + the queueNavigate event shape so the
// JS seam (live-activity-plugin) can drive either platform through one selector.
// requireOptionalNativeModule returns null on iOS (where 'LiveActivity'/'BoardBle'
// are the live modules) and in Expo Go / pre-module builds.
type SessionPresenceNativeModule = {
  isAvailable(): Promise<{ available: boolean }>;
  startSession(options: LiveActivityStartSessionOptions): Promise<void>;
  endSession(): Promise<void>;
  updateActivity(options: LiveActivityUpdateOptions): Promise<void>;
  updateActivityClimb(options: LiveActivityClimbUpdateOptions): Promise<void>;
  addListener(event: 'queueNavigate', listener: (payload: WidgetQueueNavigateEvent) => void): EventSubscription;
  // Android-only: lightbulb taps on the ongoing notification (reconnect/reassert).
  addListener(event: 'boardControl', listener: (payload: BoardControlEvent) => void): EventSubscription;
};

export const sessionPresenceNative = requireOptionalNativeModule<SessionPresenceNativeModule>('SessionPresence');
