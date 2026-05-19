'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
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
  /** Fires once per successful connect with the parsed BLE serial (null when
   * the device name didn't carry one — e.g., moonboard). Used by
   * BluetoothProvider to broadcast SessionBoardSerialChanged into the party
   * session so other mobile participants can auto-connect to the same board. */
  onConnectSuccess?: (serial: string | null) => void;
};

/**
 * Fire-and-forget POST to record the (serial, board config) mapping for the
 * authenticated user. Failures are swallowed — connect must not block on this.
 */
function recordBoardSerial(serialNumber: string, boardDetails: BoardDetails, boardUuid: string | undefined): void {
  // Sort + dedupe before joining so the recording is canonical regardless of
  // how the route emitted set_ids — `matchesBoardDetails` also normalises on
  // read, but keeping the stored value canonical means recorded entries
  // produced by different routes are byte-equal.
  const setIds = [...new Set(boardDetails.set_ids)].sort((a, b) => a - b).join(',');
  // Empty set_ids would serialise to "" and the route's Zod schema rejects
  // empty strings — the POST 400s and the `.catch` swallows it silently, so
  // the serial would never get recorded. Skip the call deliberately instead.
  if (!setIds) return;
  void fetch('/api/internal/board-serials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serialNumber,
      boardName: boardDetails.board_name,
      layoutId: boardDetails.layout_id,
      sizeId: boardDetails.size_id,
      setIds,
      boardUuid,
    }),
  }).catch(() => {});
}

type BoardConfigurationRequest = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  apiLevel: number;
  deviceName: string | undefined;
  colorOverrides: LedColorOverrides | undefined;
};

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
  onConnectSuccess,
}: UseBoardBluetoothOptions) {
  const { showMessage } = useSnackbar();
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  // BLE-reported serial of the connected controller. Parsed from the device
  // name during `connect()` (Aurora boards only — moonboard device names
  // don't carry a serial in this format) and surfaced for downstream wiring
  // (board-history room key, recordBoardSend payload). Null when no board
  // is connected or when the controller did not expose a parsable serial.
  const [connectedSerial, setConnectedSerial] = useState<string | null>(null);

  // Prevent device from sleeping while connected to the board
  useWakeLock(isConnected);

  // Store the BLE adapter and API level across renders
  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const deviceNameRef = useRef<string | undefined>(undefined);
  const configuredBoardKeyRef = useRef<string | null>(null);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);
  // Timestamp of the most recent successful BLE connect — drives the
  // duration_connected_ms property on Bluetooth Disconnected events.
  const connectedAtRef = useRef<number | null>(null);

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
    setConnectedSerial(null);
    onConnectionChange?.(false);
  }, [onConnectionChange]);

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
          const bluetoothPacket = getMoonboardBluetoothPacket(frames);
          await adapterRef.current.write(bluetoothPacket, signal);
          void incrementBluetoothSends().then(maybeFireFeedbackPromptEvent);
          return true;
        }

        // Empty frames is the "clear all LEDs" path. Skip mirroring and the
        // LED-placement load entirely — the Aurora packet builder produces a
        // standalone clear packet that doesn't depend on placement data.
        if (frames === '') {
          const clearResult = getAuroraBluetoothPacket('', {}, boardDetails.board_name, apiLevelRef.current);
          await adapterRef.current.write(clearResult.packet, signal);
          void incrementBluetoothSends().then(maybeFireFeedbackPromptEvent);
          return true;
        }

        let framesToSend = frames;

        if (mirrored && boardDetails.supportsMirroring === true) {
          if (!boardDetails.holdsData || Object.keys(boardDetails.holdsData).length === 0) {
            console.error('Cannot mirror frames: holdsData is missing or empty');
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

        await adapterRef.current.write(result.packet, signal);
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
        return false;
      }
    },
    [boardDetails, showMessage, ledColorOverrides],
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
          showMessage('Bluetooth is not available on this device.', 'error');
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
        });

        // Auto-record the (serial, current config) mapping for serial→config lookups.
        // Aurora boards only — moonboard device names don't carry a serial in this format.
        // The parsed serial also drives `connectedSerial` (board-history room key,
        // recordBoardSend payload). MoonBoard stays null.
        let parsedSerial: string | null = null;
        if (boardDetails.board_name !== 'moonboard') {
          parsedSerial = parseSerialNumber(connection.deviceName) ?? null;
          if (parsedSerial) {
            recordBoardSerial(parsedSerial, boardDetails, boardUuid);
            setConnectedSerial(parsedSerial);
          } else {
            setConnectedSerial(null);
          }
        } else {
          setConnectedSerial(null);
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
        setConnectedSerial(null);

        const domError = error instanceof DOMException ? error : null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = domError?.name ?? (error instanceof Error ? error.name : undefined);
        const isUserCancel =
          domError?.name === 'NotFoundError' ||
          /user cancelled|cancel/i.test(errorMessage) ||
          /Device selection cancelled/i.test(errorMessage);
        const stage = isUserCancel ? 'user_cancelled' : pairingStage;

        track('Bluetooth Connection Failed', {
          boardLayout: `${boardDetails.layout_name}`,
        });
        track('Pairing Failed', {
          boardType: boardDetails.board_name,
          stage,
          errorCode: errorName,
          errorMessage,
        });
      } finally {
        setLoading(false);
      }

      return false;
    },
    [
      handleDisconnection,
      boardDetails,
      boardUuid,
      onConnectionChange,
      onConnectSuccess,
      sendFramesToBoard,
      showMessage,
      devicePicker,
      configureConnectedBoard,
    ],
  );

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
    setIsConnected(false);
    setConnectedSerial(null);
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

  return {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    pickerState,
    connectedSerial,
  };
}
