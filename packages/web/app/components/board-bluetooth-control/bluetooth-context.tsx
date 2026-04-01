'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { track } from '@vercel/analytics';
import { useBoardBluetooth } from './use-board-bluetooth';
import { useQueueContext } from '../graphql-queue';
import type { BoardDetails } from '@/app/lib/types';
import { hasCapacitorPlugin } from '@/app/lib/ble/capacitor-utils';

const BLUETOOTH_SUPPORT_PROBE_INTERVAL_MS = 100;
const BLUETOOTH_SUPPORT_PROBE_TIMEOUT_MS = 1500;

function hasWebBluetooth(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

function hasNativeBlePlugin(): boolean {
  return hasCapacitorPlugin('BluetoothLe');
}

function probeBluetoothSupport(): boolean {
  return hasWebBluetooth() || hasNativeBlePlugin();
}

interface BluetoothContextValue {
  isConnected: boolean;
  loading: boolean;
  connect: (initialFrames?: string, mirrored?: boolean) => Promise<boolean>;
  disconnect: () => void;
  sendFramesToBoard: (frames: string, mirrored?: boolean) => Promise<boolean | undefined>;
  isBluetoothSupported: boolean;
  isBluetoothSupportResolved: boolean;
  isIOS: boolean;
}

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

export function BluetoothProvider({
  boardDetails,
  children,
}: {
  boardDetails: BoardDetails;
  children: React.ReactNode;
}) {
  const { currentClimbQueueItem } = useQueueContext();
  const { isConnected, loading, connect, disconnect, sendFramesToBoard } =
    useBoardBluetooth({ boardDetails });

  const [isBluetoothSupported, setIsBluetoothSupported] = useState(() => probeBluetoothSupport());
  const [isBluetoothSupportResolved, setIsBluetoothSupportResolved] = useState(() =>
    probeBluetoothSupport(),
  );
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    if (
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod/i.test(
        navigator.userAgent || (navigator as { vendor?: string }).vendor || '',
      )
    ) {
      setIsIOS(true);
    }

    let cancelled = false;
    let elapsedMs = 0;

    const updateBluetoothSupport = () => {
      if (cancelled) return true;

      const supported = probeBluetoothSupport();
      if (supported) {
        setIsBluetoothSupported(true);
        setIsBluetoothSupportResolved(true);
        return true;
      }

      elapsedMs += BLUETOOTH_SUPPORT_PROBE_INTERVAL_MS;
      if (elapsedMs >= BLUETOOTH_SUPPORT_PROBE_TIMEOUT_MS) {
        setIsBluetoothSupported(false);
        setIsBluetoothSupportResolved(true);
        return true;
      }

      return false;
    };

    if (updateBluetoothSupport()) {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      if (updateBluetoothSupport()) {
        window.clearInterval(intervalId);
      }
    }, BLUETOOTH_SUPPORT_PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // Auto-send climb when currentClimbQueueItem changes (only if connected)
  useEffect(() => {
    if (isConnected && currentClimbQueueItem) {
      const sendClimb = async () => {
        try {
          const result = await sendFramesToBoard(
            currentClimbQueueItem.climb.frames,
            !!currentClimbQueueItem.climb.mirrored,
          );
          // undefined means send was not attempted (missing characteristic/frames/boardDetails)
          // Only track analytics for explicit success (true) or failure (false)
          if (result === true) {
            track('Climb Sent to Board Success', {
              climbUuid: currentClimbQueueItem.climb?.uuid,
              boardLayout: `${boardDetails.layout_name}`,
            });
          } else if (result === false) {
            track('Climb Sent to Board Failure', {
              climbUuid: currentClimbQueueItem.climb?.uuid,
              boardLayout: `${boardDetails.layout_name}`,
            });
          }
        } catch (error) {
          console.error('Error sending climb to board:', error);
          track('Climb Sent to Board Failure', {
            climbUuid: currentClimbQueueItem.climb?.uuid,
            boardLayout: `${boardDetails.layout_name}`,
          });
        }
      };
      sendClimb();
    }
  }, [currentClimbQueueItem, isConnected, sendFramesToBoard, boardDetails.layout_name]);

  const value = useMemo(
    () => ({
      isConnected,
      loading,
      connect,
      disconnect,
      sendFramesToBoard,
      isBluetoothSupported,
      isBluetoothSupportResolved,
      isIOS,
    }),
    [
      isConnected,
      loading,
      connect,
      disconnect,
      sendFramesToBoard,
      isBluetoothSupported,
      isBluetoothSupportResolved,
      isIOS,
    ],
  );

  return (
    <BluetoothContext.Provider value={value}>
      {children}
    </BluetoothContext.Provider>
  );
}

export function useBluetoothContext() {
  const context = useContext(BluetoothContext);
  if (!context) {
    throw new Error(
      'useBluetoothContext must be used within a BluetoothProvider',
    );
  }
  return context;
}

export { BluetoothContext };
