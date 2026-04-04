'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { track } from '@vercel/analytics';
import { useBoardBluetooth } from './use-board-bluetooth';
import { useQueueContext } from '../graphql-queue';
import type { BoardDetails } from '@/app/lib/types';
import { isCapacitor, isCapacitorWebView, waitForCapacitor, CAPACITOR_BRIDGE_TIMEOUT_MS } from '@/app/lib/ble/capacitor-utils';

interface BluetoothContextValue {
  isConnected: boolean;
  loading: boolean;
  connect: (initialFrames?: string, mirrored?: boolean) => Promise<boolean>;
  disconnect: () => void;
  sendFramesToBoard: (frames: string, mirrored?: boolean) => Promise<boolean | undefined>;
  isBluetoothSupported: boolean;
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

  const [isBluetoothSupported, setIsBluetoothSupported] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    let cancelPolling: (() => void) | undefined;

    if (isCapacitor()) {
      // Bridge already available — confirmed native environment
      setIsBluetoothSupported(true);
    } else if (typeof navigator !== 'undefined' && !!navigator.bluetooth) {
      // Web Bluetooth API present (Chrome, Edge, etc.)
      setIsBluetoothSupported(true);
    } else if (isCapacitorWebView()) {
      // UA looks like a native WebView — bridge may not be injected yet.
      // Poll for window.Capacitor; only confirm support once the bridge appears.
      let cancelled = false;
      waitForCapacitor(CAPACITOR_BRIDGE_TIMEOUT_MS).then((found) => {
        if (!cancelled && found) {
          setIsBluetoothSupported(true);
        }
      });
      cancelPolling = () => { cancelled = true; };
    }

    if (
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod/i.test(
        navigator.userAgent || (navigator as { vendor?: string }).vendor || '',
      )
    ) {
      setIsIOS(true);
    }

    return () => cancelPolling?.();
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
      isIOS,
    }),
    [
      isConnected,
      loading,
      connect,
      disconnect,
      sendFramesToBoard,
      isBluetoothSupported,
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
