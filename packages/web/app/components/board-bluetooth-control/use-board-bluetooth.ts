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
import { supportsCapacitorBleManualScan } from '@/app/lib/ble/capacitor-utils';

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

export function useBoardBluetooth({
  boardDetails,
  boardUuid,
  onConnectionChange,
  ledColorOverrides,
}: UseBoardBluetoothOptions) {
  const { showMessage } = useSnackbar();
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // Prevent device from sleeping while connected to the board
  useWakeLock(isConnected);

  // Store the BLE adapter and API level across renders
  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);

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

  // Handler for device disconnection
  const handleDisconnection = useCallback(() => {
    setIsConnected(false);
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
        // Abort errors are expected during rapid swiping — don't log or show them
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Error sending frames to board:', error);
        return false;
      }
    },
    [boardDetails, showMessage, ledColorOverrides],
  );

  // Handle connection initiation
  const connect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => {
      if (!boardDetails) {
        console.error('Cannot connect to Bluetooth without board details');
        return false;
      }

      setLoading(true);

      try {
        // Create a fresh adapter for each connection attempt.
        // Only inject our custom picker when the native BLE bridge supports
        // manual scan APIs. Older app installs stay on requestDevice().
        const adapter = await createBluetoothAdapter(
          boardDetails.board_name,
          supportsCapacitorBleManualScan() ? devicePicker : undefined,
        );

        const available = await adapter.isAvailable();
        if (!available) {
          showMessage('Bluetooth is not available on this device.', 'error');
          return false;
        }

        // Clean up any existing adapter
        if (adapterRef.current) {
          unsubDisconnectRef.current?.();
          await adapterRef.current.disconnect();
        }

        // Connect via the adapter and parse API level from device name
        const connection = await adapter.requestAndConnect(targetSerial);
        apiLevelRef.current = parseApiLevel(connection.deviceName);

        // Set up disconnection listener
        unsubDisconnectRef.current = adapter.onDisconnect(handleDisconnection);
        adapterRef.current = adapter;

        track('Bluetooth Connection Success', {
          boardLayout: `${boardDetails.layout_name}`,
        });

        // Auto-record the (serial, current config) mapping for serial→config lookups.
        // Aurora boards only — moonboard device names don't carry a serial in this format.
        if (boardDetails.board_name !== 'moonboard') {
          const serialNumber = parseSerialNumber(connection.deviceName);
          if (serialNumber) {
            recordBoardSerial(serialNumber, boardDetails, boardUuid);
          }
        }

        // Send initial frames if provided
        if (initialFrames) {
          await sendFramesToBoard(initialFrames, mirrored);
        }

        setIsConnected(true);
        onConnectionChange?.(true);
        return true;
      } catch (error) {
        console.error('Error connecting to Bluetooth:', error);
        setIsConnected(false);
        track('Bluetooth Connection Failed', {
          boardLayout: `${boardDetails.layout_name}`,
        });
      } finally {
        setLoading(false);
      }

      return false;
    },
    [handleDisconnection, boardDetails, boardUuid, onConnectionChange, sendFramesToBoard, showMessage, devicePicker],
  );

  // Disconnect from the board — update state synchronously for immediate UI
  // feedback, then await the native BLE disconnect in the background.
  const disconnect = useCallback(async () => {
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    setIsConnected(false);
    onConnectionChange?.(false);
    await adapter?.disconnect();
  }, [onConnectionChange]);

  // Clean up on unmount — reject any pending picker promise so the adapter's
  // finally block calls stopLEScan, then tear down the BLE connection.
  useEffect(() => {
    return () => {
      pickerRejectRef.current?.(new Error('Component unmounted'));
      pickerRejectRef.current = null;
      unsubDisconnectRef.current?.();
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
  };
}
