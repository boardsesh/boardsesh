'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { track } from '@vercel/analytics';
import * as Sentry from '@sentry/nextjs';
import { BoardDetails } from '@/app/lib/types';
import { getAuroraBluetoothPacket, parseApiLevel } from './bluetooth-aurora';
import { getMoonboardBluetoothPacket } from './bluetooth-moonboard';
import { HoldRenderData } from '../board-renderer/types';
import { useWakeLock } from './use-wake-lock';
import type { BluetoothAdapter, DevicePickerFn, DiscoveredDevice } from '@/app/lib/ble/types';
import { createBluetoothAdapter } from '@/app/lib/ble/adapter-factory';
import { isCapacitor } from '@/app/lib/ble/capacitor-utils';

export interface PickerState {
  devices: DiscoveredDevice[];
  onSelect: (deviceId: string) => void;
  onCancel: () => void;
}

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

interface UseBoardBluetoothOptions {
  boardDetails?: BoardDetails;
  onConnectionChange?: (connected: boolean) => void;
}

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

  // Device picker state for custom Capacitor scanning
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const pickerResolveRef = useRef<((deviceId: string) => void) | null>(null);
  const pickerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Stable device picker function for the Capacitor adapter
  const devicePicker = useCallback<DevicePickerFn>((subscribe) => {
    return new Promise<string>((resolve, reject) => {
      pickerResolveRef.current = resolve;
      pickerRejectRef.current = reject;

      const handleSelect = (deviceId: string) => {
        pickerResolveRef.current = null;
        pickerRejectRef.current = null;
        setPickerState(null);
        resolve(deviceId);
      };

      const handleCancel = () => {
        pickerResolveRef.current = null;
        pickerRejectRef.current = null;
        setPickerState(null);
        reject(new Error('Device selection cancelled'));
      };

      setPickerState({ devices: [], onSelect: handleSelect, onCancel: handleCancel });

      subscribe((devices) => {
        setPickerState((prev) =>
          prev ? { ...prev, devices } : null,
        );
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
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal) => {
      if (!adapterRef.current || !frames || !boardDetails) return;

      try {
        if (boardDetails.board_name === 'moonboard') {
          const bluetoothPacket = getMoonboardBluetoothPacket(frames);
          await adapterRef.current.write(bluetoothPacket, signal);
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

        // getAuroraBluetoothPacket throws if any placements can't be resolved.
        // Catch separately so we can report to Sentry without crashing the UI.
        let bluetoothPacket: Uint8Array;
        try {
          bluetoothPacket = getAuroraBluetoothPacket(
            framesToSend,
            placementPositions,
            boardDetails.board_name,
            apiLevelRef.current,
          );
        } catch (error) {
          Sentry.captureException(error, {
            tags: { board: boardDetails.board_name, layout: boardDetails.layout_id, size: boardDetails.size_id },
          });
          console.error('[BLE] Packet generation failed:', error);
          showMessage('This climb is not compatible with your board.', 'error');
          return false;
        }

        await adapterRef.current.write(bluetoothPacket, signal);
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
    async (initialFrames?: string, mirrored?: boolean) => {
      if (!boardDetails) {
        console.error('Cannot connect to Bluetooth without board details');
        return false;
      }

      setLoading(true);

      try {
        // Create a fresh adapter for each connection attempt.
        // On Capacitor, inject our custom device picker so we control
        // the scan UI and can deduplicate discovered devices.
        const adapter = await createBluetoothAdapter(
          boardDetails.board_name,
          isCapacitor() ? devicePicker : undefined,
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
        const connection = await adapter.requestAndConnect();
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

  // Disconnect from the board
  const disconnect = useCallback(() => {
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    adapterRef.current?.disconnect();
    adapterRef.current = null;
    setIsConnected(false);
    onConnectionChange?.(false);
  }, [onConnectionChange]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      unsubDisconnectRef.current?.();
      adapterRef.current?.disconnect();
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
