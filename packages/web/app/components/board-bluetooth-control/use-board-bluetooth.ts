'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import {
  classifyBleFailure,
  classifyBleFailureReason,
  type BleSendFailureReason,
} from '@boardsesh/ble-protocol/connection-error';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { normaliseSetIds } from '@/app/lib/ble/board-config-match';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { RECORD_BOARD_SERIAL } from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { track } from '@/app/lib/analytics';
import * as Sentry from '@sentry/nextjs';
import type { BoardDetails } from '@/app/lib/types';
import { getAuroraBluetoothPacket, parseApiLevel, parseSerialNumber, type LedColorOverrides } from './bluetooth-aurora';
import { getMoonboardBluetoothPacket } from './bluetooth-moonboard';
import type { HoldRenderData } from '../board-renderer/types';
import { useWakeLock } from './use-wake-lock';
import type { BluetoothAdapter, DevicePickerFn, DiscoveredDevice } from '@/app/lib/ble/types';
import { createBluetoothAdapter } from '@/app/lib/ble/adapter-factory';
import { incrementBluetoothSends, maybeFireFeedbackPromptEvent } from '@/app/lib/feedback-prompt-db';
import { supportsCapacitorBleManualScan, supportsNativeIosBoardBle } from '@/app/lib/ble/capacitor-utils';

export type PickerState = {
  devices: DiscoveredDevice[];
  handleSelect: (deviceId: string) => void;
  handleCancel: () => void;
};

// Module-level cache for Aurora LED placements loader to avoid repeated dynamic import overhead
type GetLedPlacementsFn = (boardName: string, layoutId: number, sizeId: number) => Record<number, number>;
let cachedGetLedPlacements: GetLedPlacementsFn | null = null;

export const convertToMirroredFramesString = (frames: string, holdsData: HoldRenderData[]): string => {
  // Create a map for quick lookup of mirroredHoldId
  const holdIdToMirroredIdMap = new Map<number, number>();
  holdsData.forEach((hold) => {
    if (hold.mirroredHoldId) {
      holdIdToMirroredIdMap.set(hold.id, hold.mirroredHoldId);
    }
  });

  return frames
    .split('p') // Split into hold data entries
    .filter((hold) => hold) // Remove empty entries
    .map((holdData) => {
      const [holdId, stateCode] = holdData.split('r').map((str) => Number(str)); // Split hold data into holdId and stateCode
      const mirroredHoldId = holdIdToMirroredIdMap.get(holdId);

      if (mirroredHoldId === undefined) {
        throw new Error(`Mirrored hold ID is not defined for hold ID ${holdId}.`);
      }

      // Construct the mirrored hold data
      return `p${mirroredHoldId}r${stateCode}`;
    })
    .join(''); // Reassemble into a single string
};

type UseBoardBluetoothOptions = {
  boardDetails?: BoardDetails;
  /** Saved board UUID when on a /b/{slug}/... route — used to link the recorded serial mapping. */
  boardUuid?: string;
  onConnectionChange?: (connected: boolean) => void;
  /** Per-state hex colour overrides applied at packet build time. Changing
   * this re-creates `sendFramesToBoard` so the auto-sender repaints the
   * current climb with the new colours. */
  ledColorOverrides?: LedColorOverrides;
  analyticsBoardId?: number | null;
  /** Fires once per successful connect with the parsed BLE serial (null when
   * the device name didn't carry one — e.g., moonboard). Used by
   * BluetoothProvider to broadcast SessionBoardSerialChanged into the party
   * session so other mobile participants can auto-connect to the same board. */
  onConnectSuccess?: (serial: string | null) => void;
};

/**
 * Fire-and-forget GraphQL mutation recording the (serial, board config, API
 * level) the user was on when connecting. Failures are swallowed — connect must
 * not block on this. The mutation requires auth, so a missing token is skipped
 * rather than fired (a guaranteed 401), matching the mobile path.
 */
function recordBoardSerial(
  serialNumber: string,
  boardDetails: BoardDetails,
  boardUuid: string | undefined,
  apiLevel: number,
  token: string | null,
): void {
  // Sort + dedupe before joining so the recording is canonical regardless of
  // how the route emitted set_ids — `matchesBoardDetails` also normalises on
  // read, but keeping the stored value canonical means recorded entries
  // produced by different routes are byte-equal.
  const setIds = [...new Set(boardDetails.set_ids)].sort((a, b) => a - b).join(',');
  // Empty set_ids would serialise to "" and the input Zod schema rejects empty
  // strings — the mutation would error and the `.catch` would swallow it, so
  // the serial would never get recorded. Skip the call deliberately instead.
  if (!setIds) return;
  // Skip when signed out — the mutation is auth-gated, so firing it without a
  // token is a guaranteed 401 round-trip on every anonymous connect.
  if (!token) return;
  const client = createGraphQLHttpClient(token);
  void client
    .request(RECORD_BOARD_SERIAL, {
      input: {
        serialNumber,
        boardName: boardDetails.board_name,
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        setIds,
        apiLevel,
        boardUuid,
      },
    })
    .catch(() => {});
}

type BoardConfigurationRequest = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  apiLevel: number;
  deviceName: string | undefined;
  colorOverrides: LedColorOverrides | undefined;
};

// Identity of the physical board a serial maps to: board name + the route's
// layout/size/set config. Used to decide whether a remembered (serial, board)
// pair still applies — if the user has since switched to a different board the
// key won't match and we fall back to the picker instead of silently grabbing
// the old board. Deliberately NOT createBoardConfigurationKey (that also keys on
// device name + colour overrides, which aren't part of board identity).
function boardIdentityKey(boardDetails: BoardDetails): string {
  return [
    boardDetails.board_name,
    boardDetails.layout_id,
    boardDetails.size_id,
    normaliseSetIds(boardDetails.set_ids.join(',')),
  ].join('::');
}

function createBoardConfigurationKey(configuration: BoardConfigurationRequest): string {
  const sortedColorOverrides = Object.entries(configuration.colorOverrides ?? {}).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return JSON.stringify([
    configuration.boardName,
    configuration.layoutId,
    configuration.sizeId,
    configuration.apiLevel,
    configuration.deviceName ?? null,
    sortedColorOverrides,
  ]);
}

export function useBoardBluetooth({
  boardDetails,
  boardUuid,
  onConnectionChange,
  ledColorOverrides,
  analyticsBoardId,
  onConnectSuccess,
}: UseBoardBluetoothOptions) {
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('common');
  // Auth token for the fire-and-forget serial recording mutation. Kept in a ref
  // so the stable `connect` callback reads the latest value without re-creating.
  const { token: wsAuthToken } = useWsAuthToken();
  const authTokenRef = useRef<string | null>(null);
  authTokenRef.current = wsAuthToken;
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  // The board this device last successfully connected to, with the identity of
  // the board config it was paired against. Drives the solo lightbulb's silent
  // reconnect: after an involuntary drop a tap reconnects straight to this
  // serial (no picker) — but only while the current board still matches, so
  // switching boards falls back to the picker. Survives an involuntary drop;
  // cleared on an explicit user disconnect.
  const [lastConnectedBoard, setLastConnectedBoard] = useState<{ serial: string; configKey: string } | null>(null);

  // Prevent device from sleeping while connected to the board
  useWakeLock(isConnected);

  // Store the BLE adapter and API level across renders
  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const deviceNameRef = useRef<string | undefined>(undefined);
  const configuredBoardKeyRef = useRef<string | null>(null);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);
  // Serialises every adapter.write across all callers of sendFramesToBoard.
  // Web Bluetooth on Android can't cancel an in-flight GATT operation and
  // throws "GATT operation already in progress" the moment a second write
  // starts before the previous resolves. The AutoSender (first frame on climb
  // change) and the play-view drawer drain (subsequent frames) both call
  // sendFramesToBoard against the same characteristic, so without a mutex
  // here their independent latest-wins loops can still collide at the GATT
  // boundary. Cleared on disconnect so a fresh adapter starts unblocked.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  // Timestamp of the most recent successful BLE connect — drives the
  // duration_connected_ms property on Bluetooth Disconnected events.
  const connectedAtRef = useRef<number | null>(null);
  // Holds the latest `connect` so handleDisconnection can offer a one-tap
  // reconnect without a declaration cycle (connect depends on
  // handleDisconnection). Wired up by the effect below.
  const connectRef = useRef<
    ((initialFrames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>) | null
  >(null);
  // Guards against stacking duplicate "take it back" prompts — a flapping
  // connection can fire several disconnects in a row. Reset once we reconnect
  // (or the user explicitly disconnects) so the next genuine drop prompts again.
  const boardTakenPromptShownRef = useRef(false);
  // True from the moment a connect attempt starts until it settles — and the
  // device picker being open counts as in-flight. A second concurrent connect()
  // would start a second native scan and trip "Already scanning. Stopping now."
  // on iOS (e.g. the wall-confirm 2s fallback firing while the user is still
  // choosing a board in the picker). A ref, not the `loading` state, because
  // state updates are async: two rapid calls both read the stale `false`.
  const connectInFlightRef = useRef(false);
  // Latest config-matched reconnect serial, mirrored from the derived value
  // below so handleDisconnection's "take it back" action can silently reconnect
  // to the same board without taking the derived value (or boardDetails) as a
  // dep, which would re-create the callback and re-register the disconnect
  // listener on every change.
  const reconnectSerialRef = useRef<string | null>(null);

  // The reason the most recent `sendFramesToBoard` returned `false`. The
  // AutoSender reads this synchronously right after its own `await` resolves to
  // `false` to label `Climb Sent to Board Failure` with the real cause —
  // `disconnected` dominates, not the old catch-all `characteristic_unavailable`.
  // Set immediately before EVERY `return false` below (never reset elsewhere);
  // the AutoSender only reads it on the `false` branch, so a stale value left by
  // a prior successful send is never observed. Writes serialise through
  // `writeChainRef`, so a concurrent play-view send can't overwrite this between
  // a failing call resolving and the AutoSender's same-microtask read.
  const lastSendFailureReasonRef = useRef<BleSendFailureReason | null>(null);

  // Device picker state for custom Capacitor scanning.
  // pickerRejectRef holds the pending promise's reject so unmount cleanup
  // can drain it, which causes the adapter's finally block to call stopLEScan.
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const pickerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Stable device picker function for the Capacitor adapter
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

      setPickerState({ devices: [], handleSelect, handleCancel });

      subscribe((devices) => {
        setPickerState((prev) => (prev ? { ...prev, devices } : null));
      });
    });
  }, []);

  // Handler for device disconnection — fires when the adapter reports a
  // gattserverdisconnected event. User-initiated disconnects via disconnect()
  // null `unsubDisconnectRef` first, so this only ever runs on unexpected
  // drops (signal loss, board power-off, OS BLE stack reset).
  const handleDisconnection = useCallback(() => {
    const connectedAt = connectedAtRef.current;
    connectedAtRef.current = null;
    configuredBoardKeyRef.current = null;
    if (connectedAt !== null) {
      const connectionDurationSec = Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
      track('Bluetooth Disconnected', {
        reason: 'lost',
        duration_connected_ms: Date.now() - connectedAt,
        // Hardware/OS-side drop. Can't reliably distinguish out-of-range from
        // GATT error from this signal alone — default to 'gatt_error'.
        disconnectReason: 'gatt_error',
        connectionDurationSec,
      });
    }
    setIsConnected(false);
    onConnectionChange?.(false);

    // The connection is gone, so drop the dead adapter now. The take-back
    // reconnect builds a fresh adapter, so leaving the dead one in place would
    // only make connect() call disconnect() on an already-torn-down peripheral
    // (which can reject and surface a spurious error toast).
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    adapterRef.current = null;
    // Reset the GATT write chain so a fresh adapter starts unblocked.
    writeChainRef.current = Promise.resolve();

    // These boards are last-connection-wins and always advertise, so an
    // unexpected drop usually means another phone grabbed the board. Tell the
    // user instead of going silent, and offer a take-back. We deliberately don't
    // *auto*-reconnect — that would ping-pong with the other app and flicker the
    // wall — but the take-back is user-initiated, so it reconnects to the board
    // they were on (matching the lightbulb tap). On native that's silent; the
    // adapter falls back to the picker if that board isn't found, so gyms with
    // several boards in range still get a deliberate choice. On web the serial
    // is ignored and the picker shows. Dedup so a flapping link doesn't stack
    // prompts.
    if (boardTakenPromptShownRef.current) return;
    boardTakenPromptShownRef.current = true;
    showMessage(
      t('bluetooth.boardTaken'),
      'warning',
      {
        label: t('bluetooth.takeItBack'),
        onClick: () => {
          void connectRef.current?.(undefined, undefined, reconnectSerialRef.current ?? undefined);
        },
      },
      10000,
    );
  }, [onConnectionChange, showMessage, t]);

  // Serialise a GATT write behind the in-flight chain. The chain itself is
  // never rejected — each link swallows the previous error so a failed write
  // doesn't poison every subsequent caller — but `serialisedWrite` re-throws
  // its own error to the caller so `sendFramesToBoard`'s catch block runs
  // unchanged.
  const serialisedWrite = useCallback(async (adapter: BluetoothAdapter, data: Uint8Array, signal?: AbortSignal) => {
    const previous = writeChainRef.current;
    let resolveLink!: () => void;
    const link = new Promise<void>((resolve) => {
      resolveLink = resolve;
    });
    writeChainRef.current = link;
    try {
      await previous;
    } catch {
      // Previous caller's failure is its own problem.
    }
    try {
      await adapter.write(data, signal);
    } finally {
      resolveLink();
    }
  }, []);

  // Function to send frames string to the board.
  // An empty `frames` string is the "clear all LEDs" path: Aurora's packet
  // builder already returns a zero-length placement set, which the board
  // interprets as "no LEDs lit", overwriting whatever was on the wall.
  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal, climbUuid?: string) => {
      if (!adapterRef.current || !boardDetails) return;

      try {
        if (boardDetails.board_name === 'moonboard') {
          // MoonBoard's packet format isn't designed to encode "clear" via an
          // empty frame string — skip the write rather than send a malformed
          // packet to the board.
          if (!frames) return;
          const moonResult = getMoonboardBluetoothPacket(frames);
          const moonSkipped = moonResult.skippedRoleCount + moonResult.skippedPositionCount;

          if (moonSkipped > 0 && moonResult.totalPlacements === moonSkipped) {
            Sentry.captureMessage(
              `[BLE] All ${moonResult.totalPlacements} MoonBoard placements skipped — climb data may be corrupted`,
              {
                level: 'warning',
                tags: { board: 'moonboard' },
                extra: {
                  climbUuid,
                  skippedRoleCount: moonResult.skippedRoleCount,
                  skippedPositionCount: moonResult.skippedPositionCount,
                },
              },
            );
            showMessage('This climb has unrecognised hold data and cannot be sent to the board.', 'error');
            lastSendFailureReasonRef.current = 'incompatible_climb';
            return false;
          }

          if (moonSkipped > 0) {
            Sentry.captureMessage(
              `[BLE] ${moonSkipped} of ${moonResult.totalPlacements} MoonBoard placements skipped`,
              {
                level: 'warning',
                tags: { board: 'moonboard' },
                extra: {
                  climbUuid,
                  skippedRoleCount: moonResult.skippedRoleCount,
                  skippedPositionCount: moonResult.skippedPositionCount,
                },
              },
            );
          }

          await serialisedWrite(adapterRef.current, moonResult.packet, signal);
          void incrementBluetoothSends().then(maybeFireFeedbackPromptEvent);
          return true;
        }

        // Empty frames is the "clear all LEDs" path. Skip mirroring and the
        // LED-placement load entirely — the Aurora packet builder produces a
        // standalone clear packet that doesn't depend on placement data.
        if (frames === '') {
          const clearResult = getAuroraBluetoothPacket('', {}, boardDetails.board_name, apiLevelRef.current);
          await serialisedWrite(adapterRef.current, clearResult.packet, signal);
          void incrementBluetoothSends().then(maybeFireFeedbackPromptEvent);
          return true;
        }

        let framesToSend = frames;

        if (mirrored && boardDetails.supportsMirroring === true) {
          if (!boardDetails.holdsData || Object.keys(boardDetails.holdsData).length === 0) {
            console.error('Cannot mirror frames: holdsData is missing or empty');
            lastSendFailureReasonRef.current = 'missing_mirror_data';
            return false;
          }
          framesToSend = convertToMirroredFramesString(frames, boardDetails.holdsData);
        }

        if (!cachedGetLedPlacements) {
          const mod = await import('@boardsesh/board-constants/led-placements');
          cachedGetLedPlacements = mod.getLedPlacements as GetLedPlacementsFn;
        }
        const getLedPlacementsFn = cachedGetLedPlacements;
        const placementPositions = getLedPlacementsFn(
          boardDetails.board_name,
          boardDetails.layout_id,
          boardDetails.size_id,
        );

        if (Object.keys(placementPositions).length === 0) {
          console.error(
            `[BLE] LED placement map is empty for ${boardDetails.board_name} layout=${boardDetails.layout_id} size=${boardDetails.size_id}. ` +
              'Board configuration may be incorrect or LED data may need regeneration.',
          );
          showMessage('Could not send to board — LED data missing for this board configuration.', 'error');
          lastSendFailureReasonRef.current = 'missing_led_placements';
          return false;
        }

        const result = getAuroraBluetoothPacket(
          framesToSend,
          placementPositions,
          boardDetails.board_name,
          apiLevelRef.current,
          ledColorOverrides,
        );

        const skippedCount = result.skippedPositionCount + result.skippedRoleCount;

        if (skippedCount > 0 && result.packet.length === 0) {
          // Every placement was skipped — completely wrong board config
          Sentry.captureMessage(
            `[BLE] All ${result.totalPlacements} placements skipped — climb incompatible with board`,
            {
              level: 'warning',
              tags: { board: boardDetails.board_name, layout: boardDetails.layout_id, size: boardDetails.size_id },
              extra: {
                climbUuid,
                layoutId: boardDetails.layout_id,
                sizeId: boardDetails.size_id,
                setIds: boardDetails.set_ids,
                skippedPositionCount: result.skippedPositionCount,
                skippedRoleCount: result.skippedRoleCount,
              },
            },
          );
          showMessage('This climb is for a different board configuration.', 'error');
          lastSendFailureReasonRef.current = 'incompatible_climb';
          return false;
        }

        if (skippedCount > 0) {
          // Partial miss — some holds couldn't be lit but we can still send
          Sentry.captureMessage(`[BLE] ${skippedCount} of ${result.totalPlacements} placements skipped`, {
            level: 'warning',
            tags: { board: boardDetails.board_name, layout: boardDetails.layout_id, size: boardDetails.size_id },
            extra: {
              climbUuid,
              layoutId: boardDetails.layout_id,
              sizeId: boardDetails.size_id,
              setIds: boardDetails.set_ids,
              skippedPositionCount: result.skippedPositionCount,
              skippedRoleCount: result.skippedRoleCount,
            },
          });
          showMessage(
            `${skippedCount} hold${skippedCount > 1 ? 's' : ''} couldn't be lit — your board may be a different size than this climb was set for.`,
            'warning',
          );
        }

        await serialisedWrite(adapterRef.current, result.packet, signal);
        void incrementBluetoothSends().then(maybeFireFeedbackPromptEvent);
        return true;
      } catch (error) {
        // AbortError is now the primary unmount-mid-write path — the
        // BluetoothAutoSender scopes a single AbortController to its
        // lifetime and aborts it on unmount, so the adapter.write above
        // surfaces an AbortError. Swallow it silently; the drain loop
        // already returns before firing analytics / confirmClimbOnWall.
        // External callers that pass their own signal also land here.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Error sending frames to board:', error);
        const failureReason = classifyBleFailureReason(error);
        lastSendFailureReasonRef.current = failureReason;
        // A write that fails because the GATT link is gone (the board dropped or
        // another device grabbed it — these boards are last-connection-wins) is
        // the only signal we get when the adapter's disconnect event never
        // fires. Record the tug-of-war (mirrors mobile's BluetoothConnectionStolen)
        // and mark the connection lost so the lightbulb stops showing "connected"
        // and a deliberate reconnect can run. handleDisconnection dedups its own
        // take-back prompt, so a burst of failing writes is safe.
        if (failureReason === 'disconnected') {
          track(SHARED_EVENTS.BluetoothConnectionStolen, {
            boardLayout: `${boardDetails.layout_name}`,
            boardId: analyticsBoardId ?? undefined,
          });
          handleDisconnection();
        }
        return false;
      }
    },
    [boardDetails, showMessage, ledColorOverrides, serialisedWrite, handleDisconnection, analyticsBoardId],
  );

  const configureConnectedBoard = useCallback(
    async (adapter: BluetoothAdapter) => {
      if (!boardDetails) return;
      const boardConfiguration = {
        boardName: boardDetails.board_name,
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        apiLevel: apiLevelRef.current,
        deviceName: deviceNameRef.current,
        colorOverrides: ledColorOverrides,
      };
      const boardConfigurationKey = createBoardConfigurationKey(boardConfiguration);
      if (configuredBoardKeyRef.current === boardConfigurationKey) return;
      if (adapter.configureBoard) {
        await adapter.configureBoard(boardConfiguration);
      }
      configuredBoardKeyRef.current = boardConfigurationKey;
    },
    [boardDetails, ledColorOverrides],
  );

  // Handle connection initiation
  const connect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => {
      if (!boardDetails) {
        console.error('Cannot connect to Bluetooth without board details');
        return false;
      }

      // A connect attempt (possibly with the device picker still open) is
      // already running. Starting a second one here scans again while the first
      // scan is live, which trips "Already scanning. Stopping now." on the
      // native iOS shell. Ignore the re-entrant call; the in-flight attempt
      // stands. Sequential connects (reconnect to a different board) still work
      // — the flag clears in `finally` below.
      if (connectInFlightRef.current) {
        return false;
      }
      connectInFlightRef.current = true;

      setLoading(true);

      // Tracks which stage of the pairing flow we're in so the catch block
      // can tag the Pairing Failed event with the actual failure point.
      let pairingStage: 'scan' | 'user_cancelled' | 'gatt_connect' | 'service_discover' | 'first_write' | 'unknown' =
        'scan';

      try {
        // Create a fresh adapter for each connection attempt.
        // Only inject our custom picker when the native BLE bridge supports
        // manual scan APIs. Older app installs stay on requestDevice().
        const adapter = await createBluetoothAdapter(
          boardDetails.board_name,
          supportsCapacitorBleManualScan() || supportsNativeIosBoardBle() ? devicePicker : undefined,
        );

        const available = await adapter.isAvailable();
        if (!available) {
          showMessage(t('bluetooth.unavailable'), 'error');
          return false;
        }

        // Clean up any existing adapter. Emit Bluetooth Disconnected for the
        // outgoing session before we tear it down so the prior connection's
        // duration isn't silently discarded from the reliability funnel.
        if (adapterRef.current) {
          const previousConnectedAt = connectedAtRef.current;
          connectedAtRef.current = null;
          configuredBoardKeyRef.current = null;
          unsubDisconnectRef.current?.();
          if (previousConnectedAt !== null) {
            const connectionDurationSec = Math.max(0, Math.round((Date.now() - previousConnectedAt) / 1000));
            track('Bluetooth Disconnected', {
              reason: 'reconnect',
              duration_connected_ms: Date.now() - previousConnectedAt,
              disconnectReason: 'user_initiated',
              connectionDurationSec,
            });
          }
          await adapterRef.current.disconnect();
        }

        // Connect via the adapter and parse API level from device name
        pairingStage = 'gatt_connect';
        const connection = await adapter.requestAndConnect(targetSerial);
        deviceNameRef.current = connection.deviceName;
        apiLevelRef.current = parseApiLevel(connection.deviceName);
        pairingStage = 'service_discover';
        await configureConnectedBoard(adapter);

        // Set up disconnection listener
        unsubDisconnectRef.current = adapter.onDisconnect(handleDisconnection);
        adapterRef.current = adapter;

        connectedAtRef.current = Date.now();
        track('Bluetooth Connection Success', {
          boardLayout: `${boardDetails.layout_name}`,
          boardId: analyticsBoardId ?? undefined,
        });

        // Auto-record the (serial, current config) mapping for serial→config lookups.
        // Aurora boards only — moonboard device names don't carry a serial in this format.
        let parsedSerial: string | null = null;
        if (boardDetails.board_name !== 'moonboard') {
          parsedSerial = parseSerialNumber(connection.deviceName) ?? null;
          if (parsedSerial) {
            recordBoardSerial(parsedSerial, boardDetails, boardUuid, apiLevelRef.current, authTokenRef.current);
            // Remember the board (and which config it was paired against) so a
            // later involuntary drop can be recovered with a silent reconnect.
            setLastConnectedBoard({ serial: parsedSerial, configKey: boardIdentityKey(boardDetails) });
          }
        }

        // Send initial frames if provided
        if (initialFrames) {
          pairingStage = 'first_write';
          await sendFramesToBoard(initialFrames, mirrored);
        }

        setIsConnected(true);
        onConnectionChange?.(true);
        onConnectSuccess?.(parsedSerial);
        return true;
      } catch (error) {
        console.error('Error connecting to Bluetooth:', error);
        configuredBoardKeyRef.current = null;
        setIsConnected(false);

        const domError = error instanceof DOMException ? error : null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = domError?.name ?? (error instanceof Error ? error.name : undefined);

        // Classify the failure into actionable user copy. Previously every
        // failure except "Bluetooth off" was silent, so a failed (re)connect
        // looked like a dead tap.
        const category = classifyBleFailure(error, pairingStage);
        const stage = category === 'user_cancelled' ? 'user_cancelled' : pairingStage;

        track('Bluetooth Connection Failed', {
          boardLayout: `${boardDetails.layout_name}`,
        });
        track('Pairing Failed', {
          boardType: boardDetails.board_name,
          stage,
          errorCode: errorName,
          errorMessage,
        });

        // Literal-key switch (the i18n linter forbids `t(variable)`).
        // `user_cancelled` stays silent — dismissing the picker isn't a failure.
        switch (category) {
          case 'board_not_found':
            showMessage(t('bluetooth.boardNotFound'), 'error');
            break;
          case 'connect_failed':
            showMessage(t('bluetooth.connectFailed'), 'error');
            break;
          case 'service_missing':
            showMessage(t('bluetooth.serviceMissing'), 'error');
            break;
          case 'unavailable':
            showMessage(t('bluetooth.unavailable'), 'error');
            break;
          case 'user_cancelled':
            break;
          default:
            showMessage(t('bluetooth.unknownError'), 'error');
        }
      } finally {
        setLoading(false);
        // Release the re-entrancy guard so the next deliberate connect (or a
        // take-back reconnect) can run.
        connectInFlightRef.current = false;
        // Re-arm the take-back prompt once a connect attempt finishes, whether
        // it succeeded or failed. Resetting only on success would leave the
        // guard stuck true after a failed take-back, so a later genuine drop
        // would never prompt again. The dedup still holds between drops because
        // no connect attempt runs (and thus no reset) until the user acts.
        boardTakenPromptShownRef.current = false;
      }

      return false;
    },
    [
      handleDisconnection,
      boardDetails,
      boardUuid,
      analyticsBoardId,
      onConnectionChange,
      onConnectSuccess,
      sendFramesToBoard,
      showMessage,
      t,
      devicePicker,
      configureConnectedBoard,
    ],
  );

  // Keep the latest connect in a ref so handleDisconnection's "Take it back"
  // action can reconnect without creating a declaration cycle.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (!isConnected || !adapterRef.current) return;
    void configureConnectedBoard(adapterRef.current);
  }, [isConnected, configureConnectedBoard]);

  // Disconnect from the board — update state synchronously for immediate UI
  // feedback, then await the native BLE disconnect in the background.
  const disconnect = useCallback(async () => {
    const connectedAt = connectedAtRef.current;
    connectedAtRef.current = null;
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    deviceNameRef.current = undefined;
    configuredBoardKeyRef.current = null;
    writeChainRef.current = Promise.resolve();
    // The user chose to disconnect — clear the take-back prompt guard so a
    // later genuine drop can prompt again, and forget the board so a later tap
    // opens the picker rather than silently grabbing this board back.
    boardTakenPromptShownRef.current = false;
    setLastConnectedBoard(null);
    setIsConnected(false);
    onConnectionChange?.(false);
    if (connectedAt !== null) {
      const connectionDurationSec = Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
      track('Bluetooth Disconnected', {
        reason: 'user',
        duration_connected_ms: Date.now() - connectedAt,
        disconnectReason: 'user_initiated',
        connectionDurationSec,
      });
    }
    await adapter?.disconnect();
  }, [onConnectionChange]);

  // Clean up on unmount — reject any pending picker promise so the adapter's
  // finally block calls stopLEScan, then tear down the BLE connection.
  // If the connection is still live at unmount (e.g. user navigated away with
  // a board paired), emit a Bluetooth Disconnected event so the reliability
  // funnel has a third category beyond user-initiated and hardware drops.
  // explicit-disconnect via disconnect() and hardware drops via
  // handleDisconnection both clear connectedAtRef first, so this only fires
  // for genuine "still connected at unmount" paths.
  useEffect(() => {
    return () => {
      pickerRejectRef.current?.(new Error('Component unmounted'));
      pickerRejectRef.current = null;
      const connectedAt = connectedAtRef.current;
      connectedAtRef.current = null;
      configuredBoardKeyRef.current = null;
      unsubDisconnectRef.current?.();
      if (connectedAt !== null) {
        const connectionDurationSec = Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
        track('Bluetooth Disconnected', {
          reason: 'navigation',
          duration_connected_ms: Date.now() - connectedAt,
          disconnectReason: 'unknown',
          connectionDurationSec,
        });
      }
      void adapterRef.current?.disconnect();
    };
  }, []);

  // Serial to silently reconnect to for the board currently in view — only when
  // the remembered board still matches the route's config. Null when nothing is
  // remembered or the user has switched boards, so callers fall back to the
  // picker. (Silent reconnect to a serial only works on native shells; web
  // callers gate on that and ignore the serial.)
  const reconnectSerialForCurrentBoard =
    lastConnectedBoard && boardDetails && lastConnectedBoard.configKey === boardIdentityKey(boardDetails)
      ? lastConnectedBoard.serial
      : null;

  // Mirror into a ref so handleDisconnection's "take it back" action reads the
  // current value without taking it as a dep.
  useEffect(() => {
    reconnectSerialRef.current = reconnectSerialForCurrentBoard;
  }, [reconnectSerialForCurrentBoard]);

  return {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    lastSendFailureReasonRef,
    pickerState,
    reconnectSerialForCurrentBoard,
  };
}
