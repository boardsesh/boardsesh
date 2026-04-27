'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { track } from '@/app/lib/analytics';
import * as Sentry from '@sentry/nextjs';
import type { BoardDetails } from '@/app/lib/types';
import { getAuroraBluetoothPacket, parseApiLevel } from './bluetooth-aurora';
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
  onConnectionChange?: (connected: boolean) => void;
};

export function useBoardBluetooth({ boardDetails, onConnectionChange }: UseBoardBluetoothOptions) {
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

  // Function to send frames string to the board
  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal, climbUuid?: string) => {
      if (!adapterRef.current || !frames || !boardDetails) return;

      try {
        if (boardDetails.board_name === 'moonboard') {
          const bluetoothPacket = getMoonboardBluetoothPacket(frames);
          await adapterRef.current.write(bluetoothPacket, signal);
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
    [boardDetails, showMessage],
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
    [handleDisconnection, boardDetails, onConnectionChange, sendFramesToBoard, showMessage, devicePicker],
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
