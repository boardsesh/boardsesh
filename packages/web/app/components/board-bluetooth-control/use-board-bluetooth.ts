'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { track } from '@vercel/analytics';
import { BoardDetails } from '@/app/lib/types';
import { getBluetoothPacket } from './bluetooth';
import { HoldRenderData } from '../board-renderer/types';
import { useWakeLock } from './use-wake-lock';
import type { BluetoothAdapter } from '@/app/lib/ble/types';
import { createBluetoothAdapter } from '@/app/lib/ble/adapter-factory';

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

  // Store the BLE adapter across renders
  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);

  // Handler for device disconnection
  const handleDisconnection = useCallback(() => {
    setIsConnected(false);
    onConnectionChange?.(false);
  }, [onConnectionChange]);

  // Function to send frames string to the board
  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false) => {
      if (!adapterRef.current || !frames || !boardDetails) return;

      let framesToSend = frames;
      // Lazy-load LED placements data (~50KB) only when actually sending to board
      const { getLedPlacements } = await import('@/app/lib/__generated__/led-placements-data');
      const placementPositions = getLedPlacements(boardDetails.board_name, boardDetails.layout_id, boardDetails.size_id);

      if (Object.keys(placementPositions).length === 0) {
        console.error(
          `[BLE] LED placement map is empty for ${boardDetails.board_name} layout=${boardDetails.layout_id} size=${boardDetails.size_id}. ` +
          'Board configuration may be incorrect or LED data may need regeneration.',
        );
        showMessage('Could not send to board — LED data missing for this board configuration.', 'error');
        return false;
      }

      if (mirrored) {
        if (!boardDetails.holdsData || Object.keys(boardDetails.holdsData).length === 0) {
          console.error('Cannot mirror frames: holdsData is missing or empty');
          return false;
        }
        framesToSend = convertToMirroredFramesString(frames, boardDetails.holdsData);
      }

      const bluetoothPacket = getBluetoothPacket(framesToSend, placementPositions, boardDetails.board_name);

      try {
        await adapterRef.current.write(bluetoothPacket);
        return true;
      } catch (error) {
        console.error('Error sending frames to board:', error);
        return false;
      }
    },
    [boardDetails],
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
        // Create a fresh adapter for each connection attempt
        const adapter = await createBluetoothAdapter();

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

        // Connect via the adapter
        await adapter.requestAndConnect();

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
    [handleDisconnection, boardDetails, onConnectionChange, sendFramesToBoard, showMessage],
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
  };
}
