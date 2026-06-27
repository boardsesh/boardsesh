import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  getAuroraBluetoothPacket,
  parseApiLevel,
  parseBoardTypeFromDeviceName,
  parseSerialNumber,
  type LedColorOverrides,
} from '@boardsesh/ble-protocol/aurora';
import { getMoonboardBluetoothPacket, isMoonboardDeviceName } from '@boardsesh/ble-protocol/moonboard';
import {
  classifyBleFailure,
  classifyBleFailureReason,
  isDisconnectionError,
  type BleFailureCategory,
} from '@boardsesh/ble-protocol/connection-error';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { RECORD_BOARD_SERIAL } from '@boardsesh/graphql/operations';
import { getHttpClient } from '../graphql/client';
import { getAuthToken } from '../auth-store';
import {
  createBluetoothAdapter,
  getNativeBleConnectedDevice,
  isNativeIosBleAdapter,
  subscribeNativeBleConnected,
} from './adapter-factory';
import { requestBleRuntimePermissions } from './use-ble-permissions';
import type { BluetoothAdapter, DevicePickerFn, DiscoveredDevice } from './types';
import type { HoldPlacement } from '../../components/board-renderer/types';
import { track } from '../analytics';
import { reportHandledError } from '../error-reporting';
import { clearBleDiagnosticsTags, setBleDiagnosticsTags } from '../sentry';
import { recordBleEvent } from './ble-diagnostics-log';
import { buildHoldColorOverrideSignature, type HoldColorOverrides } from '../hold-color-overrides';

// Exported for testing. Decides how a connect-failure category reaches error
// tracking:
//  - null  → don't report. The user dismissed the device picker
//    ('user_cancelled') — that's the app doing exactly what was asked, not a fault.
//  - 'warning' → environmental, not an app bug: the board is off, out of range,
//    or the GATT connect timed out ('board_not_found' / 'connect_failed').
//  - 'error' → a genuine fault worth surfacing ('unavailable' / 'service_missing'
//    / 'unknown').
export function bleConnectReportLevel(category: BleFailureCategory): 'warning' | 'error' | null {
  if (category === 'user_cancelled') return null;
  if (category === 'board_not_found' || category === 'connect_failed') return 'warning';
  return 'error';
}

// Exported for testing — isolates the .packet extraction so regressions are caught.
//
// Returns:
//  - undefined when there are no frames (nothing to send)
//  - false when every placement was skipped (the packet builder still emits the
//    "clear all" packet `l##`, so writing it would silently dark the board while
//    the caller reported success). The caller surfaces the incompatible-climb
//    error instead of writing — web parity (use-board-bluetooth.ts:348-363).
//  - true after a successful write.
export async function dispatchMoonboardPacket(
  frames: string,
  write: BluetoothAdapter['write'],
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  if (!frames) return undefined;
  const { packet, skippedRoleCount, skippedPositionCount, totalPlacements } = getMoonboardBluetoothPacket(frames);
  const skippedCount = skippedRoleCount + skippedPositionCount;
  if (totalPlacements > 0 && skippedCount === totalPlacements) {
    return false;
  }
  await write(packet, signal);
  return true;
}

export type PickerState = {
  devices: DiscoveredDevice[];
  isScanning: boolean;
  handleSelect: (deviceId: string) => void;
  handleCancel: () => void;
};

// Identity of a board pairing: the silent-reconnect and adoption guards only
// trust a remembered/native connection while the active config still matches.
// Deliberately excludes set_ids — see the reconnectSerialForCurrentBoard note.
export function boardConfigKey(boardName: string, layoutId: number, sizeId: number): string {
  return `${boardName}::${layoutId}::${sizeId}`;
}

/**
 * Board type parsed from a BLE device name, covering both families: Aurora
 * names via the product-name prefix, MoonBoard via its name prefixes. Returns
 * undefined when the name identifies neither.
 */
function parseAnyBoardTypeFromDeviceName(deviceName?: string): string | undefined {
  if (!deviceName) return undefined;
  if (isMoonboardDeviceName(deviceName)) return 'moonboard';
  return parseBoardTypeFromDeviceName(deviceName);
}

function scanFamilyForBoard(boardName: string): 'aurora' | 'moonboard' {
  return boardName === 'moonboard' ? 'moonboard' : 'aurora';
}

/**
 * Fire-and-forget GraphQL mutation recording the (serial, board config, API
 * level) seen on connect for the authenticated user. Mirrors the web app's
 * `recordBoardSerial`. Failures are swallowed — connect must not block on this.
 */
function recordBoardSerial(input: {
  serialNumber: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  apiLevel: number;
  boardUuid?: string;
}): void {
  // Canonicalise set IDs: dedupe + numeric sort, dropping any non-numeric token
  // so the value satisfies the backend's `^\d+(,\d+)*$` schema.
  const setIds = [
    ...new Set(
      input.setIds
        .split(',')
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part)),
    ),
  ]
    .sort((first, second) => Number(first) - Number(second))
    .join(',');
  if (!setIds) return;
  // The mutation requires auth, so firing it while signed out is a guaranteed
  // 401 round-trip on every anonymous connect. Skip when there's no stored
  // token. (Web threads a token through and fires regardless, but on mobile the
  // token lives in SecureStore, so a cheap async check here avoids the noise.)
  void getAuthToken().then((token) => {
    if (!token) return;
    return getHttpClient()
      .request(RECORD_BOARD_SERIAL, { input: { ...input, setIds } })
      .catch(() => {});
  });
}

type GetLedPlacementsFn = (boardName: string, layoutId: number, sizeId: number) => Record<number, number>;
let cachedGetLedPlacements: GetLedPlacementsFn | null = null;

export const convertToMirroredFramesString = (frames: string, holdsData: HoldPlacement[]): string => {
  const holdIdToMirroredIdMap = new Map<number, number>();
  for (const hold of holdsData) {
    if (hold.mirroredHoldId) {
      holdIdToMirroredIdMap.set(hold.id, hold.mirroredHoldId);
    }
  }

  return frames
    .split('p')
    .filter((hold) => hold)
    .map((holdEntry) => {
      const [holdId, stateCode] = holdEntry.split('r').map((str) => Number(str));
      const mirroredHoldId = holdIdToMirroredIdMap.get(holdId);

      if (mirroredHoldId === undefined) {
        throw new Error(`Mirrored hold ID is not defined for hold ID ${holdId}.`);
      }

      return `p${mirroredHoldId}r${stateCode}`;
    })
    .join('');
};

/**
 * Diagnostic context attached to Climb Sent to Board Success/Failure so PostHog
 * can tell WHAT was sent and WHY apart. Optional — callers that don't have it
 * (e.g. a manual mirror re-send) just omit it.
 */
export type BleSendContext = {
  /** Where the send came from: the queue auto-sender, an undo, or a clear. */
  sendSource: 'auto' | 'undo' | 'clear';
  targetQueueItemUuid?: string;
  climbUuid?: string;
  /** The climb's own board metadata, when known — lets a board/climb mismatch be seen. */
  climbBoardType?: string;
  climbLayoutId?: number | null;
};

export type SendFramesToBoard = (
  frames: string,
  mirrored?: boolean,
  signal?: AbortSignal,
  sendContext?: BleSendContext,
) => Promise<boolean | undefined>;

type UseBoardBluetoothOptions = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  /** Comma-separated set IDs of the active board, recorded against the serial on connect. */
  setIds?: string;
  /** UUID of the active (saved) board, linked to the serial recording. */
  boardUuid?: string;
  holdsData?: HoldPlacement[];
  ledColorOverrides?: LedColorOverrides;
  analyticsBoardId?: number | null;
  onConnectionChange?: (connected: boolean) => void;
  onConnectSuccess?: (serial: string | null) => void;
  /** Reads whether this connection was made via the mismatch "Connect anyway"
   *  override, attached to connection + send analytics. */
  getConnectedViaMismatchOverride?: () => boolean;
};

const KEEP_AWAKE_TAG = 'boardsesh-ble';

/**
 * Create a single AbortSignal that fires when either of the two input signals
 * is aborted. This lets us combine a caller-supplied signal with an internal
 * one without losing either. Callers must invoke `dispose` once the guarded
 * work settles — the caller-supplied signal can be long-lived (the
 * AutoSender's lifetime controller), and without the dispose every write
 * would leave one more dangling 'abort' listener on it for the rest of the
 * session.
 */
function mergeAbortSignals(signalA: AbortSignal, signalB: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const detach = () => {
    signalA.removeEventListener('abort', onAbort);
    signalB.removeEventListener('abort', onAbort);
  };
  const onAbort = () => {
    controller.abort();
    detach();
  };

  if (signalA.aborted || signalB.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }

  signalA.addEventListener('abort', onAbort);
  signalB.addEventListener('abort', onAbort);

  return { signal: controller.signal, dispose: detach };
}

export function useBoardBluetooth({
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardUuid,
  holdsData,
  ledColorOverrides,
  analyticsBoardId,
  onConnectionChange,
  onConnectSuccess,
  getConnectedViaMismatchOverride,
}: UseBoardBluetoothOptions) {
  const { t } = useTranslation('settings');
  // Connect-failure copy lives in the shared `common.bluetooth.*` keys so web
  // and mobile describe the same failure the same way.
  const { t: tCommon } = useTranslation('common');
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // Remember the board (serial + which config it was paired against) so a later
  // involuntary drop can be recovered with a silent reconnect to the same board
  // (the lightbulb tap, native shells). Only valid while the current route still
  // points at the same board — switching board/layout/size invalidates it and
  // callers fall back to the picker. Mirrors the web `reconnectSerialForCurrentBoard`.
  const [lastConnectedBoard, setLastConnectedBoard] = useState<{ serial: string; configKey: string } | null>(null);
  const lastConnectedBoardRef = useRef(lastConnectedBoard);
  lastConnectedBoardRef.current = lastConnectedBoard;

  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);
  // One AbortController per connection generation, shared by every write of
  // that generation. connect()/disconnect() abort it so ALL in-flight and
  // queued writes against the old adapter cancel — a per-write controller
  // would only ever cover the most recent one.
  const writeAbortRef = useRef<AbortController | null>(null);
  // Serialises every adapter.write across all callers of sendFramesToBoard.
  // The AutoSender (first frame on climb change), the play-drawer playback
  // drain (subsequent frames) and the create-climb preview each guard only
  // their own writes, so without a shared mutex their independent latest-wins
  // loops can overlap at the GATT boundary. RNBleAdapter splits a packet into
  // 20-byte chunks written sequentially with inter-chunk delays — two
  // overlapping writes interleave chunks of two different packets and corrupt
  // both. Mirrors the web hook's writeChainRef; reset on connect/disconnect
  // so a hung write can't wedge the next connection's sends.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  // True while a connect attempt is running. Guards against a second
  // concurrent connect (double-tapped lightbulb): both attempts would share
  // the singleton BLE manager, and the first attempt's scan teardown kills
  // the second attempt's scan, stranding the picker.
  const connectInFlightRef = useRef(false);
  // True after an explicit user disconnect, false again on the next deliberate
  // connect. While set, the native-connection adoption path is ignored — it
  // would otherwise race the in-flight native disconnect and re-establish the
  // connection the user just closed.
  const adoptionSuppressedRef = useRef(false);
  // One disconnect diagnostics record per connection generation. Both involuntary
  // drop paths — the adapter's own disconnect event and the write-failure
  // detection in sendFramesToBoard — funnel through clearConnectionAfterDrop,
  // and on some BLE stacks a stolen-link write failure ALSO fires the adapter
  // event, so without this guard a single physical drop logs twice. Reset to
  // false when a new connection is established; the send path raises the kind to
  // 'stolen' before tearing down so the more-specific label wins when it's known.
  const disconnectRecordedRef = useRef(false);
  const pendingDisconnectKindRef = useRef<'stolen' | 'dropped'>('dropped');
  // The configKey the live connection was established for. Lets the
  // config-switch effect tell a genuine board/layout/size change (tear down)
  // from an unrelated re-render (no-op), and is the key cleared on every drop.
  const connectedConfigKeyRef = useRef<string | null>(null);
  // What connect() pushed as its initialFrames write, if any. The AutoSender
  // (mounted right after isConnected flips true) reads this one-shot seed so a
  // byte-identical current climb doesn't get re-sent immediately on connect —
  // a redundant full-frame write plus a doubled success haptic.
  const connectInitialSendRef = useRef<{ frames: string; mirrored: boolean; colorSignature: string } | null>(null);
  const configuredDeviceNameRef = useRef<string | undefined>(undefined);

  // ledColorOverrides narrowed to string values, shared by the connect and
  // adoption configureBoard calls so both push identical overrides natively.
  const sanitizedColorOverrides = useMemo(() => {
    if (!ledColorOverrides) return undefined;
    return Object.fromEntries(
      Object.entries(ledColorOverrides).filter(([, value]) => typeof value === 'string') as [string, string][],
    );
  }, [ledColorOverrides]);
  const colorSignature = useMemo(
    () => buildHoldColorOverrideSignature((sanitizedColorOverrides ?? {}) as HoldColorOverrides),
    [sanitizedColorOverrides],
  );

  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const pickerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Keep the screen awake while connected to a board
  useEffect(() => {
    if (isConnected) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [isConnected]);

  const devicePicker = useCallback<DevicePickerFn>((subscribe) => {
    return new Promise<string>((resolve, reject) => {
      pickerRejectRef.current = reject;

      const cleanup = () => {
        pickerRejectRef.current = null;
        setPickerState(null);
      };

      const handleSelect = (deviceId: string) => {
        cleanup();
        resolve(deviceId);
      };

      const handleCancel = () => {
        cleanup();
        reject(new Error('Device selection cancelled'));
      };

      setPickerState({ devices: [], isScanning: true, handleSelect, handleCancel });

      subscribe(
        (devices) => {
          setPickerState((prev) => (prev ? { ...prev, devices } : null));
        },
        () => {
          // Scan window closed — drop the spinner. The picker stays open (a
          // device was found but not yet picked, or it shows the empty state).
          setPickerState((prev) => (prev ? { ...prev, isScanning: false } : null));
        },
      );
    });
  }, []);

  const clearConnectionAfterDrop = useCallback(() => {
    // Only involuntary drops reach here (a deliberate user disconnect goes
    // through teardownConnection), so log exactly one disconnect per generation.
    if (!disconnectRecordedRef.current) {
      disconnectRecordedRef.current = true;
      recordBleEvent({ type: 'disconnect', boardName, kind: pendingDisconnectKindRef.current });
    }
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    configuredDeviceNameRef.current = undefined;
    connectedConfigKeyRef.current = null;
    writeAbortRef.current?.abort();
    writeAbortRef.current = null;
    writeChainRef.current = Promise.resolve();
    setIsConnected(false);
    onConnectionChange?.(false);
    // Drop the connect-time BLE diagnostic tags so a later unrelated error
    // doesn't carry stale ble_* tags from this (now-dead) connection.
    clearBleDiagnosticsTags();
    // Two callers reach here: the adapter's own disconnect event (the adapter
    // already self-cleaned, so disconnect() is now a no-op), and the
    // write-failure drop path (isDisconnectionError). In the latter the
    // RNBleAdapter's onDeviceDisconnected subscription and a possibly half-alive
    // native link would otherwise leak — dispose explicitly.
    void adapter?.disconnect().catch(() => {});
  }, [boardName, onConnectionChange]);

  const handleDisconnection = useCallback(() => {
    clearConnectionAfterDrop();
  }, [clearConnectionAfterDrop]);

  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal, sendContext?: BleSendContext) => {
      if (!adapterRef.current || !boardName || layoutId === undefined || sizeId === undefined) return;
      const boardAnalyticsProperties = {
        boardName,
        layoutId,
        sizeId,
        mirrored,
        boardId: analyticsBoardId ?? undefined,
        connectedViaMismatchOverride: getConnectedViaMismatchOverride?.() ?? false,
        ...sendContext,
      };

      // Lazily create the per-connection-generation controller so connect()
      // can cancel every write of the old generation at once.
      if (!writeAbortRef.current) {
        writeAbortRef.current = new AbortController();
      }
      const generationSignal = writeAbortRef.current.signal;

      // Combine caller-provided signal with the generation controller.
      const merged = signal ? mergeAbortSignals(signal, generationSignal) : null;
      const combinedSignal = merged ? merged.signal : generationSignal;

      const performSend = async (): Promise<boolean | undefined> => {
        try {
          // The send may have queued behind another write; by the time it runs
          // the connection generation may be gone (reconnect/disconnect) — bail
          // before touching the (possibly new) adapter.
          if (combinedSignal.aborted || !adapterRef.current) return;

          if (boardName === 'moonboard') {
            const sent = await dispatchMoonboardPacket(
              frames,
              adapterRef.current.write.bind(adapterRef.current),
              combinedSignal,
            );
            // false = every placement was skipped (unrecognised/corrupt hold
            // data). The packet builder would emit a "clear all" packet, darking
            // the board, so dispatchMoonboardPacket refuses to write. Surface the
            // same incompatible-climb error the Aurora branch uses instead of
            // letting the AutoSender buzz success on a dark board.
            if (sent === false) {
              console.warn('[BLE] All MoonBoard placements skipped — climb has unrecognised hold data');
              Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
              track(SHARED_EVENTS.ClimbSentToBoardFailure, {
                ...boardAnalyticsProperties,
                failureReason: 'incompatible_climb',
              });
              return false;
            }
            if (sent) track(SHARED_EVENTS.ClimbSentToBoardSuccess, boardAnalyticsProperties);
            return sent;
          }

          // Empty frames = "clear all LEDs" for Aurora boards
          if (frames === '') {
            const clearResult = getAuroraBluetoothPacket('', {}, boardName as AuroraBoardName, apiLevelRef.current);
            await adapterRef.current.write(clearResult.packet, combinedSignal);
            return true;
          }

          let framesToSend = frames;

          if (mirrored && boardSupportsMirroring(boardName, layoutId)) {
            // On a board that supports mirroring, a mirrored send REQUIRES the
            // hold map to produce mirrored frames. If it's missing/empty we must
            // refuse rather than send the original (un-mirrored) frames — that
            // would light the wrong holds on the wall while the AutoSender buzzed
            // success. Web parity (use-board-bluetooth.ts:397-403).
            if (!holdsData || holdsData.length === 0) {
              console.error(
                `[BLE] Cannot mirror frames: holdsData is missing or empty for ${boardName} layout=${layoutId}`,
              );
              Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
              track(SHARED_EVENTS.ClimbSentToBoardFailure, {
                ...boardAnalyticsProperties,
                failureReason: 'missing_mirror_data',
              });
              return false;
            }
            framesToSend = convertToMirroredFramesString(frames, holdsData);
          }

          if (!cachedGetLedPlacements) {
            const mod = await import('@boardsesh/board-constants/led-placements');
            cachedGetLedPlacements = mod.getLedPlacements as GetLedPlacementsFn;
          }
          const getLedPlacementsFn = cachedGetLedPlacements;
          const placementPositions = getLedPlacementsFn(boardName, layoutId, sizeId);

          if (Object.keys(placementPositions).length === 0) {
            console.error(
              `[BLE] LED placement map is empty for ${boardName} layout=${layoutId} size=${sizeId}. Board configuration may be incorrect or LED data may need regeneration.`,
            );
            Alert.alert(t('ble.sendFailedTitle'), t('ble.errorLedMissing'));
            track(SHARED_EVENTS.ClimbSentToBoardFailure, {
              ...boardAnalyticsProperties,
              failureReason: 'missing_led_placements',
            });
            return false;
          }

          const result = getAuroraBluetoothPacket(
            framesToSend,
            placementPositions,
            boardName as AuroraBoardName,
            apiLevelRef.current,
            ledColorOverrides,
          );

          const skippedCount = result.skippedPositionCount + result.skippedRoleCount;

          if (skippedCount > 0 && result.packet.length === 0) {
            console.warn(`[BLE] All ${result.totalPlacements} placements skipped — climb incompatible with board`);
            Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
            track(SHARED_EVENTS.ClimbSentToBoardFailure, {
              ...boardAnalyticsProperties,
              failureReason: 'incompatible_climb',
              skippedPositionCount: result.skippedPositionCount,
              skippedRoleCount: result.skippedRoleCount,
              totalPlacements: result.totalPlacements,
            });
            return false;
          }

          if (skippedCount > 0) {
            console.warn(`[BLE] ${skippedCount} of ${result.totalPlacements} placements skipped`);
          }

          await adapterRef.current.write(result.packet, combinedSignal);
          track(SHARED_EVENTS.ClimbSentToBoardSuccess, boardAnalyticsProperties);
          return true;
        } catch (error) {
          // An aborted write (unmount, or a reconnect cancelling the old
          // generation) is not a failure — some adapters surface it as a
          // DOMException, others reject with their own cancellation error after
          // the signal fired, so check the signal too.
          if (combinedSignal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            return;
          }
          const bleFailureReason = classifyBleFailureReason(error);
          console.error('Error sending frames to board:', error);
          track(SHARED_EVENTS.ClimbSentToBoardFailure, {
            ...boardAnalyticsProperties,
            failureReason: bleFailureReason,
          });
          recordBleEvent({
            type: 'send_failure',
            boardName,
            failureReason: bleFailureReason,
            message: error instanceof Error ? error.message : String(error),
          });
          // A dropped link is routine on these last-connection-wins boards
          // (another climber grabbed it, or it disconnected mid-session), so keep
          // it a filterable warning rather than a full error that drowns real
          // write bugs. Already tracked above via ClimbSentToBoardFailure.
          reportHandledError(error, {
            level: bleFailureReason === 'disconnected' ? 'warning' : 'error',
            tags: { source: 'ble-send', failure_reason: bleFailureReason },
          });
          // A write that fails because the link is gone (the board dropped or
          // another device grabbed it — these boards are last-connection-wins) is
          // often the only signal we get: the adapter's disconnect event may never
          // fire. Mark the connection lost so the lightbulb stops showing
          // "connected" and a deliberate reconnect can run. The native adapters
          // throw the plain-Error signatures the predicate matches ("Not
          // connected", "Device disconnected during write").
          if (isDisconnectionError(error)) {
            // The tug-of-war signal: we believed we were connected but a write just
            // failed on a dead link. On a shared board this is usually another
            // device having grabbed it. Recorded so the two-climber case is visible.
            track(SHARED_EVENTS.BluetoothConnectionStolen, { boardName, layoutId, sizeId });
            // Mark this drop as 'stolen' (write failed on a dead link) so the
            // disconnect record clearConnectionAfterDrop writes carries the more
            // specific label rather than the generic 'dropped'.
            pendingDisconnectKindRef.current = 'stolen';
            handleDisconnection();
          }
          return false;
        } finally {
          merged?.dispose();
        }
      };

      // Queue behind whatever write is already running or pending.
      // writeChainRef.current is never left rejected (the bookkeeping below
      // coerces both outcomes), so a single fulfilled-arm .then suffices here;
      // the rejected arm below is belt-and-suspenders so a future edit that
      // lets performSend throw still can't wedge the chain.
      const queuedSend = writeChainRef.current.then(performSend);
      writeChainRef.current = queuedSend.then(
        () => undefined,
        () => undefined,
      );
      return queuedSend;
    },
    [
      boardName,
      layoutId,
      sizeId,
      holdsData,
      ledColorOverrides,
      analyticsBoardId,
      handleDisconnection,
      getConnectedViaMismatchOverride,
      t,
    ],
  );

  const connect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => {
      if (!boardName) {
        console.error('Cannot connect to Bluetooth without board name');
        return false;
      }

      // A connect is already running (double-tapped lightbulb, or a second
      // surface racing the first). Both attempts would share the singleton BLE
      // manager and tear down each other's scans, so ignore the second tap.
      if (connectInFlightRef.current) {
        return false;
      }
      connectInFlightRef.current = true;
      // A deliberate connect re-arms native-connection adoption after an
      // earlier explicit disconnect suppressed it.
      adoptionSuppressedRef.current = false;

      setLoading(true);

      try {
        const permissionsGranted = await requestBleRuntimePermissions({ requestNotificationPermission: true });
        if (!permissionsGranted) {
          Alert.alert(t('ble.permissionRequired'), t('ble.errorPermissionDenied'));
          return false;
        }

        const adapter = createBluetoothAdapter(devicePicker, scanFamilyForBoard(boardName));

        const available = await adapter.isAvailable();
        if (!available) {
          Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unavailable'));
          return false;
        }

        // Abort every in-flight or queued write from the previous connection
        // generation so nothing keeps writing on a potentially-disconnected
        // device, and unblock the write chain in case a write hung.
        writeAbortRef.current?.abort();
        writeAbortRef.current = null;
        writeChainRef.current = Promise.resolve();

        // Clean up any existing adapter
        if (adapterRef.current) {
          unsubDisconnectRef.current?.();
          try {
            await adapterRef.current.disconnect();
          } catch {
            // The previous adapter may already be torn down — e.g. after a
            // write-failure disconnect (another device grabbed the board) the
            // link is dead, and disconnecting a dead handle can reject. We're
            // replacing it anyway, so swallow it rather than aborting the
            // reconnect with a spurious error.
          }
        }

        // Surface the scan on the session-recording timeline / PostHog. `reconnect`
        // distinguishes a deliberate same-board serial reconnect (lightbulb) from a
        // fresh picker-driven connect.
        track(SHARED_EVENTS.BluetoothScanStarted, { boardName, layoutId, sizeId, reconnect: !!targetSerial });

        const connection = await adapter.requestAndConnect(targetSerial);
        apiLevelRef.current = parseApiLevel(connection.deviceName);
        configuredDeviceNameRef.current = connection.deviceName;

        // New connection generation: re-arm the one-shot disconnect record and
        // default its label to 'dropped' (the send path raises it to 'stolen').
        disconnectRecordedRef.current = false;
        pendingDisconnectKindRef.current = 'dropped';
        unsubDisconnectRef.current = adapter.onDisconnect(handleDisconnection);
        adapterRef.current = adapter;

        // Push board configuration into the native BoardBleManager so the
        // Dynamic Island widget intent path (next/prev tapped while the app
        // is backgrounded) can encode wall packets from queue items stored in
        // the App Group without going through JS. No-op on Android.
        if (
          isNativeIosBleAdapter(adapter) &&
          typeof adapter.configureBoard === 'function' &&
          layoutId !== undefined &&
          sizeId !== undefined
        ) {
          try {
            await adapter.configureBoard({
              boardName,
              layoutId,
              sizeId,
              apiLevel: apiLevelRef.current,
              deviceName: connection.deviceName,
              colorOverrides: sanitizedColorOverrides,
            });
          } catch (error) {
            console.warn('[BLE] Failed to push board configuration to native side:', error);
          }
        }

        // Parse serial for Aurora boards and record the (serial, config, API
        // level) mapping for serial→config lookups. Moonboard device names
        // don't carry a serial in this format, so they're skipped.
        let parsedSerial: string | null = null;
        if (boardName !== 'moonboard' && connection.deviceName) {
          parsedSerial = parseSerialNumber(connection.deviceName) ?? null;
          if (parsedSerial && boardName && layoutId !== undefined && sizeId !== undefined && setIds) {
            recordBoardSerial({
              serialNumber: parsedSerial,
              boardName,
              layoutId,
              sizeId,
              setIds,
              apiLevel: apiLevelRef.current,
              boardUuid,
            });
          }
        }

        // Remember the board (keyed to the config it was paired against) so an
        // involuntary drop can be recovered with a silent reconnect. Only Aurora
        // boards expose a parseable serial; moonboard can't be reconnected by
        // serial. Without a full config there is no usable key (and the
        // reconnect comparison against currentConfigKey could never match).
        if (parsedSerial && layoutId !== undefined && sizeId !== undefined) {
          setLastConnectedBoard({ serial: parsedSerial, configKey: boardConfigKey(boardName, layoutId, sizeId) });
        }

        // Send initial frames if provided; seed the AutoSender's dedup with
        // what was written so it doesn't immediately repeat the identical
        // frame (and its success haptic) when it mounts on isConnected.
        if (initialFrames) {
          await sendFramesToBoard(initialFrames, mirrored);
          connectInitialSendRef.current = { frames: initialFrames, mirrored: !!mirrored, colorSignature };
        } else {
          connectInitialSendRef.current = null;
        }

        connectedConfigKeyRef.current =
          layoutId !== undefined && sizeId !== undefined ? boardConfigKey(boardName, layoutId, sizeId) : null;
        setIsConnected(true);
        onConnectionChange?.(true);
        onConnectSuccess?.(parsedSerial);
        // Connect-time BLE write diagnostics (iOS native adapter only; null on
        // Android/web and on binaries too old to report them). Set as global
        // Sentry tags so they ride any later write-stall report, and recorded on
        // the success event so PostHog can correlate the chosen write type with
        // send failures (#3181 follow-up).
        // Never let a diagnostics fetch failure skip the success analytics below
        // (getNativeBleConnectedDevice already swallows native errors → null, but
        // be explicit so analytics parity can't regress).
        const connectionDiagnostics = await getNativeBleConnectedDevice().catch(() => null);
        setBleDiagnosticsTags(connectionDiagnostics);
        recordBleEvent({
          type: 'connect_success',
          boardName,
          layoutId,
          sizeId,
          apiLevel: apiLevelRef.current,
          deviceNamePresent: !!connection.deviceName,
          diagnostics: connectionDiagnostics,
        });
        // apiLevel is the level parseApiLevel actually picked; deviceNamePresent
        // records whether an advertised name was even available. parseApiLevel
        // silently defaults to v2 when the name is missing/unparseable, and v2
        // encoding drops LED positions > 1023 — so a v3 board connecting with no
        // advertised name would light only part of the wall. These two props let
        // us see in PostHog whether that fallback ever fires in the wild.
        track(SHARED_EVENTS.BluetoothConnectionSuccess, {
          boardName,
          layoutId,
          sizeId,
          apiLevel: apiLevelRef.current,
          deviceNamePresent: !!connection.deviceName,
          boardId: analyticsBoardId ?? undefined,
          connectedViaMismatchOverride: getConnectedViaMismatchOverride?.() ?? false,
          bleChosenWriteType: connectionDiagnostics?.chosenWriteType,
          bleSupportsWithoutResponse: connectionDiagnostics?.supportsWriteWithoutResponse,
          bleCharProperties: connectionDiagnostics?.characteristicProperties,
          // Negotiated write lengths too, so a future MTU-related stall (vs a
          // write-type one) is visible in PostHog (see #3230).
          bleMaxWriteWithResponse: connectionDiagnostics?.maxWriteWithResponse,
          bleMaxWriteWithoutResponse: connectionDiagnostics?.maxWriteWithoutResponse,
        });
        return true;
      } catch (error) {
        // Classify once, up front: it decides both whether this reaches error
        // tracking and the user copy below. A user dismissing the device picker
        // ('user_cancelled') isn't a failure — don't log it as one or report it.
        // board_not_found / connect_failed are environmental (board off, out of
        // range, GATT timeout), not app bugs, so they go in as warnings. Genuine
        // faults (unavailable / service_missing / unknown) stay at error level.
        const failureCategory = classifyBleFailure(error);
        const reportLevel = bleConnectReportLevel(failureCategory);
        if (reportLevel === null) {
          console.warn('Bluetooth device selection cancelled by user');
        } else {
          console.error('Error connecting to Bluetooth:', error);
          reportHandledError(error, {
            level: reportLevel,
            tags: { source: 'ble-connect', failure_category: failureCategory },
          });
          // Recorded for an opt-in bug report. A user-cancel (reportLevel null)
          // isn't a connection issue, so it's deliberately left out.
          recordBleEvent({
            type: 'connect_failure',
            boardName,
            failureCategory,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        setIsConnected(false);

        // Dismiss the picker sheet if it's still showing. When a reconnect-by-
        // serial grace window opens the picker but nothing ever advertises, the
        // adapter rejects the selection promise on the scan timeout without
        // settling the picker's own promise — so the sheet (and its spinner)
        // would otherwise stay mounted until the user swipes it away. Settle the
        // dangling picker promise before clearing it (matching the unmount
        // cleanup) so it can't leak.
        pickerRejectRef.current?.(new Error('Connection failed'));
        pickerRejectRef.current = null;
        setPickerState(null);

        // failureCategory (classified above) maps to actionable user copy via the
        // shared, deliberately-tight predicate. A previous bare `/cancel/i` regex
        // here also matched CoreBluetooth's "operation cancelled" / ble-plx's
        // "Operation was cancelled", so those real failures showed nothing — the
        // connect just looked like a dead tap. Only an explicit user-cancel stays
        // silent now. Literal-key switch (the i18n linter forbids `t(variable)`).
        switch (failureCategory) {
          case 'user_cancelled':
            break;
          case 'unavailable':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unavailable'));
            break;
          case 'board_not_found':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.boardNotFound'));
            break;
          case 'service_missing':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.serviceMissing'));
            break;
          case 'connect_failed':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.connectFailed'));
            break;
          default:
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unknownError'));
        }

        track(SHARED_EVENTS.BluetoothConnectionFailed, {
          boardName,
          layoutId,
          sizeId,
          failureReason: failureCategory === 'unknown' ? classifyBleFailureReason(error) : failureCategory,
        });
      } finally {
        connectInFlightRef.current = false;
        setLoading(false);
      }

      return false;
    },
    [
      handleDisconnection,
      boardName,
      layoutId,
      sizeId,
      setIds,
      boardUuid,
      analyticsBoardId,
      onConnectionChange,
      onConnectSuccess,
      getConnectedViaMismatchOverride,
      sendFramesToBoard,
      sanitizedColorOverrides,
      colorSignature,
      devicePicker,
      t,
      tCommon,
    ],
  );

  const teardownConnection = useCallback(async () => {
    // Suppress native-connection adoption until the next deliberate connect:
    // the native disconnect below is async, so a backgrounding/foregrounding
    // app could otherwise see getConnectedDevice still report the device this
    // teardown is closing and silently re-adopt it.
    adoptionSuppressedRef.current = true;
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    configuredDeviceNameRef.current = undefined;
    connectedConfigKeyRef.current = null;
    // Cancel every in-flight and queued write of this connection generation,
    // and unblock the write chain for the next connect.
    writeAbortRef.current?.abort();
    writeAbortRef.current = null;
    writeChainRef.current = Promise.resolve();
    setIsConnected(false);
    onConnectionChange?.(false);
    clearBleDiagnosticsTags();
    await adapter?.disconnect();
  }, [onConnectionChange]);

  const disconnect = useCallback(async () => {
    // A deliberate disconnect forgets the board — only an involuntary drop or a
    // config switch keeps the silent same-board reconnect memory alive.
    setLastConnectedBoard(null);
    await teardownConnection();
  }, [teardownConnection]);

  // If the active board config changes while a connection is live, tear it down.
  // BluetoothProvider is mounted once globally; without this a board/layout/size
  // switch would keep the old physical link but encode sends with the NEW
  // config's LED placement map — wrong-format packets streamed to the OLD wall.
  useEffect(() => {
    const connectedKey = connectedConfigKeyRef.current;
    if (!adapterRef.current || !connectedKey) return;
    const activeKey =
      boardName && layoutId !== undefined && sizeId !== undefined ? boardConfigKey(boardName, layoutId, sizeId) : null;
    if (activeKey === connectedKey) return;
    // teardownConnection sets adoptionSuppressedRef on purpose: the named-device
    // adopt guard is boardType-granular only, so a same-family layout switch
    // (kilter/8/17 -> kilter/8/25) could otherwise race the async native
    // disconnect and re-adopt the old wall. A deliberate connect re-arms
    // adoption. lastConnectedBoard is PRESERVED so switching back offers a silent
    // reconnect (reconnectSerialForCurrentBoard self-guards on configKey).
    void teardownConnection().catch(() => {});
    // isConnected is a dep so a config switch that lands while a connect is
    // still in flight (adapterRef not yet set when this effect last ran) is
    // re-checked the moment the connect completes and flips isConnected.
    // clearConnectionAfterDrop can also race here: if a native drop already
    // nulled adapterRef.current the early-return above prevents a double
    // teardown, which is intentional.
  }, [boardName, layoutId, sizeId, isConnected, teardownConnection]);

  // iOS-only: adopt a connection the native BoardBleManager established
  // outside JS — the Dynamic Island lightbulb's reconnect-by-last-known-board,
  // or CoreBluetooth state restoration after a relaunch. Without this the wall
  // re-lights (native drives it) but the in-app lightbulb stays dark and climb
  // navigation stops pushing until the user taps it again. Listens for the
  // bridged `connected` event and re-checks on foreground (events fired while
  // JS was suspended are missed). No-op on Android and on binaries older than
  // the `getConnectedDevice` surface.
  useEffect(() => {
    const adopt = (deviceId: string, rawDeviceName?: string) => {
      // The bridge sends '' for a missing name — normalise so name parsing
      // (board type, serial, API level) sees undefined instead.
      const deviceName = rawDeviceName || undefined;
      // JS already has (or is establishing) its own adapter — nothing to adopt.
      if (adapterRef.current || connectInFlightRef.current) return;
      // The user explicitly disconnected; don't re-adopt the connection the
      // (possibly still in-flight) native disconnect is tearing down.
      if (adoptionSuppressedRef.current) return;
      if (!boardName || layoutId === undefined || sizeId === undefined) return;
      // Only adopt a device positively identified as the active config's board
      // type, or a nameless native reconnect for the exact config we most
      // recently paired. The latter covers CoreBluetooth retrieval/state
      // restoration paths that can become write-ready without a fresh
      // advertisement name.
      const adoptedBoardType = parseAnyBoardTypeFromDeviceName(deviceName);
      const currentConfigKey = boardConfigKey(boardName, layoutId, sizeId);
      const rememberedBoard = lastConnectedBoardRef.current;
      const canAdoptNamelessRememberedBoard = !adoptedBoardType && rememberedBoard?.configKey === currentConfigKey;
      if (
        (!adoptedBoardType && !canAdoptNamelessRememberedBoard) ||
        (adoptedBoardType && adoptedBoardType !== boardName)
      ) {
        return;
      }

      const adapter = createBluetoothAdapter(devicePicker, scanFamilyForBoard(boardName));
      if (!isNativeIosBleAdapter(adapter) || typeof adapter.configureBoard !== 'function') return;
      adapter.adoptConnection(deviceId);
      apiLevelRef.current = parseApiLevel(deviceName);
      configuredDeviceNameRef.current = deviceName;
      // New connection generation: re-arm the one-shot disconnect record and
      // default its label to 'dropped' (the send path raises it to 'stolen').
      disconnectRecordedRef.current = false;
      pendingDisconnectKindRef.current = 'dropped';
      unsubDisconnectRef.current = adapter.onDisconnect(handleDisconnection);
      adapterRef.current = adapter;
      void adapter
        .configureBoard({
          boardName,
          layoutId,
          sizeId,
          apiLevel: apiLevelRef.current,
          deviceName,
          colorOverrides: sanitizedColorOverrides,
        })
        .catch(() => {});

      const serial = deviceName ? (parseSerialNumber(deviceName) ?? null) : (rememberedBoard?.serial ?? null);
      if (serial) {
        setLastConnectedBoard({ serial, configKey: currentConfigKey });
      }
      connectedConfigKeyRef.current = currentConfigKey;
      setIsConnected(true);
      onConnectionChange?.(true);
      onConnectSuccess?.(serial);
      // Surface this adopted connection's write diagnostics to Sentry too
      // (widget reconnect / state restoration paths, not just JS connect).
      // Fire-and-forget; a native rejection is intentionally ignored.
      void getNativeBleConnectedDevice()
        .then(setBleDiagnosticsTags)
        .catch(() => {});
    };

    const connectedSubscription = subscribeNativeBleConnected((payload) => {
      adopt(payload.deviceId, payload.deviceName);
    });
    // null = platform/binary without the adoption surface — nothing to do.
    if (!connectedSubscription) return;

    // The subscriptions are removed in the cleanup, but an in-flight
    // getConnectedDevice promise can't be cancelled — without this flag it
    // would adopt (create an adapter, setState) after the effect was torn
    // down by an unmount or a config change.
    let cancelled = false;
    const checkNativeConnection = () => {
      void getNativeBleConnectedDevice().then((device) => {
        if (cancelled) return;
        if (device) adopt(device.deviceId, device.name);
      });
    };

    checkNativeConnection();
    const appStateSubscription = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') checkNativeConnection();
    });

    return () => {
      cancelled = true;
      connectedSubscription.remove();
      appStateSubscription.remove();
    };
  }, [
    boardName,
    layoutId,
    sizeId,
    devicePicker,
    handleDisconnection,
    onConnectionChange,
    onConnectSuccess,
    sanitizedColorOverrides,
  ]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !isNativeIosBleAdapter(adapter) || typeof adapter.configureBoard !== 'function' || !isConnected) {
      return;
    }
    if (!boardName || layoutId === undefined || sizeId === undefined) return;
    void adapter
      .configureBoard({
        boardName,
        layoutId,
        sizeId,
        apiLevel: apiLevelRef.current,
        deviceName: configuredDeviceNameRef.current,
        colorOverrides: sanitizedColorOverrides,
      })
      .catch(() => {});
  }, [boardName, layoutId, sizeId, isConnected, sanitizedColorOverrides]);

  // Serial to silently reconnect to for the board currently in view, or null
  // when nothing is remembered or the user switched boards (in which case the
  // caller opens the device picker instead).
  //
  // Deliberately keyed on board+layout+size only — NOT set_ids, which web's
  // boardIdentityKey also folds in. The mobile BluetoothProvider is handed a
  // single global activeBoard (no set_ids), and the LED placement map keys on
  // layout+size alone, so a same-board reconnect renders identically regardless
  // of set_ids. Don't thread set_ids in here without also passing it to the
  // provider.
  const currentConfigKey =
    boardName && layoutId !== undefined && sizeId !== undefined ? boardConfigKey(boardName, layoutId, sizeId) : null;
  const reconnectSerialForCurrentBoard =
    lastConnectedBoard && currentConfigKey && lastConnectedBoard.configKey === currentConfigKey
      ? lastConnectedBoard.serial
      : null;

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Reject with the explicit user-cancel signature so a connect that's
      // still awaiting the picker classifies as `user_cancelled` (silent)
      // rather than popping an alert over whatever screen comes next.
      pickerRejectRef.current?.(new Error('Device selection cancelled'));
      pickerRejectRef.current = null;
      unsubDisconnectRef.current?.();
      writeAbortRef.current?.abort();
      void adapterRef.current?.disconnect();
    };
  }, []);

  return {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    pickerState,
    reconnectSerialForCurrentBoard,
    connectInitialSendRef,
  };
}
