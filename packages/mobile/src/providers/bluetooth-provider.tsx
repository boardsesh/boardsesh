import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useBoardBluetooth } from '../lib/ble/use-board-bluetooth';
import { registerBluetoothConnection } from '../lib/ble/bluetooth-status-store';
import { useQueue } from './queue-provider';
import { hapticSuccess, hapticError } from '../lib/haptics';
import { DevicePickerSheet } from '../components/ble/DevicePickerSheet';

type BluetoothContextValue = {
  isConnected: boolean;
  loading: boolean;
  disconnectedUnexpectedly: boolean;
  connect: (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  sendFramesToBoard: (frames: string, mirrored?: boolean, signal?: AbortSignal) => Promise<boolean | undefined>;
  clearBoard: () => Promise<boolean | undefined>;
};

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

/**
 * Isolated child component that subscribes to the queue's currentClimbQueueItem
 * and auto-sends climb data over BLE. Only mounted when isConnected is true so
 * the BluetoothProvider itself never subscribes to the climb context, preventing
 * re-renders of the entire component tree on every climb change when BT is
 * disconnected.
 *
 * Uses a latest-wins drain loop for writes:
 * - `isWritingRef` tracks if a write is in progress
 * - `pendingClimbRef` stores the most recent pending climb
 * - When a new climb arrives during a write, it replaces the pending climb
 * - When the current write completes, the drain loop picks up whatever's pending
 * - Deduplicates same-uuid broadcasts via `lastSentUuidRef`
 */
function BluetoothAutoSender({
  sendFramesToBoard,
}: {
  sendFramesToBoard: (frames: string, mirrored?: boolean, signal?: AbortSignal) => Promise<boolean | undefined>;
}) {
  const { state } = useQueue();
  const { currentClimbQueueItem } = state;

  const isWritingRef = useRef(false);
  const pendingClimbRef = useRef<ClimbQueueItem | null>(null);
  const lastSentUuidRef = useRef<string | null>(null);

  // Single AbortController scoped to the AutoSender's lifetime. Aborted
  // exactly once on unmount so the in-flight drain loop cancels the
  // underlying adapter.write and returns before firing post-send side
  // effects for a climb the user has navigated away from.
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!currentClimbQueueItem) return;
    const signal = abortControllerRef.current?.signal;
    if (signal?.aborted) return;

    if (isWritingRef.current) {
      pendingClimbRef.current = currentClimbQueueItem;
      return;
    }

    isWritingRef.current = true;

    const drain = async () => {
      let toSend: ClimbQueueItem | null = currentClimbQueueItem;
      try {
        while (toSend) {
          if (signal?.aborted) return;
          const item = toSend;

          // Deduplicate same-uuid re-broadcasts. The board is idempotent so
          // a re-send is functionally fine, but we'd double-fire haptics.
          if (item.climb.uuid === lastSentUuidRef.current) {
            toSend = pendingClimbRef.current;
            pendingClimbRef.current = null;
            continue;
          }

          try {
            const result = await sendFramesToBoard(item.climb.frames, !!item.climb.mirrored, signal);

            // After the await, the AutoSender may have unmounted — skip
            // post-send side effects.
            if (signal?.aborted) return;

            if (result === true) {
              lastSentUuidRef.current = item.climb.uuid;
              hapticSuccess();
            }
          } catch (error) {
            if (signal?.aborted) return;
            console.error('Error sending climb to board:', error);
          }

          toSend = pendingClimbRef.current;
          pendingClimbRef.current = null;
        }
      } finally {
        isWritingRef.current = false;
      }
    };

    void drain();
  }, [currentClimbQueueItem, sendFramesToBoard]);

  return null;
}

type BluetoothProviderProps = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  children: React.ReactNode;
};

export function BluetoothProvider({ boardName, layoutId, sizeId, children }: BluetoothProviderProps) {
  // Track the last connected serial number for auto-reconnect on foreground
  const lastConnectedSerialRef = useRef<string | null>(null);
  const handleConnectSuccess = useCallback((serial: string | null) => {
    lastConnectedSerialRef.current = serial;
  }, []);

  const { isConnected, loading, connect, disconnect, sendFramesToBoard, pickerState } = useBoardBluetooth({
    boardName,
    layoutId,
    sizeId,
    onConnectSuccess: handleConnectSuccess,
  });

  const clearBoard = useCallback(() => sendFramesToBoard(''), [sendFramesToBoard]);

  // Register with the module-level status store so consumers rendered
  // outside this provider (e.g. the root tab bar) can observe BT connection
  // state and trigger disconnect. The store expects () => void, so wrap the
  // async disconnect.
  useEffect(() => {
    if (!isConnected) return;
    const release = registerBluetoothConnection(() => {
      void disconnect();
    });
    return release;
  }, [isConnected, disconnect]);

  // Fire haptic error on unexpected disconnect. Track via ref so we only
  // fire when isConnected transitions from true to false without a user-
  // initiated disconnect() call.
  const wasConnectedRef = useRef(false);
  const isUserDisconnectRef = useRef(false);
  const [disconnectedUnexpectedly, setDisconnectedUnexpectedly] = useState(false);

  // Wrap disconnect to track user-initiated disconnects
  const wrappedDisconnect = useCallback(async () => {
    isUserDisconnectRef.current = true;
    lastConnectedSerialRef.current = null;
    setDisconnectedUnexpectedly(false);
    try {
      await disconnect();
    } finally {
      isUserDisconnectRef.current = false;
    }
  }, [disconnect]);

  // Track app state across effect re-runs so foreground transitions
  // are never missed when `isConnected` or `connect` identity changes.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Auto-reconnect when the app returns to foreground after a background
  // disconnect. iOS CBCentralManager restoration handles keeping the
  // connection alive in most cases, but if the OS killed the connection
  // while backgrounded, this re-establishes it automatically.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasBackground = appStateRef.current === 'background' || appStateRef.current === 'inactive';
      const isNowActive = nextState === 'active';

      if (wasBackground && isNowActive && !isConnected && lastConnectedSerialRef.current) {
        void connect(undefined, undefined, lastConnectedSerialRef.current);
      }

      appStateRef.current = nextState;
    });

    return () => {
      subscription.remove();
    };
  }, [isConnected, connect]);

  useEffect(() => {
    if (wasConnectedRef.current && !isConnected && !isUserDisconnectRef.current) {
      // Unexpected disconnect — fire haptic error and expose to consumers
      hapticError();
      setDisconnectedUnexpectedly(true);
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  // Clear unexpected-disconnect flag when reconnecting
  const wrappedConnect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => {
      setDisconnectedUnexpectedly(false);
      return connect(initialFrames, mirrored, targetSerial);
    },
    [connect],
  );

  const value = useMemo<BluetoothContextValue>(
    () => ({
      isConnected,
      loading,
      disconnectedUnexpectedly,
      connect: wrappedConnect,
      disconnect: wrappedDisconnect,
      sendFramesToBoard,
      clearBoard,
    }),
    [isConnected, loading, disconnectedUnexpectedly, wrappedConnect, wrappedDisconnect, sendFramesToBoard, clearBoard],
  );

  return (
    <BluetoothContext.Provider value={value}>
      {isConnected && <BluetoothAutoSender sendFramesToBoard={sendFramesToBoard} />}
      {children}
      {pickerState && (
        <DevicePickerSheet
          visible
          devices={pickerState.devices}
          onSelect={pickerState.handleSelect}
          onDismiss={pickerState.handleCancel}
          isScanning={pickerState.isScanning}
        />
      )}
    </BluetoothContext.Provider>
  );
}

export function useBluetoothContext(): BluetoothContextValue {
  const context = useContext(BluetoothContext);
  if (!context) {
    throw new Error('useBluetoothContext must be used within a BluetoothProvider');
  }
  return context;
}

/**
 * Returns the BluetoothContextValue if rendered inside a BluetoothProvider,
 * or null otherwise. Useful for components that may render before a board
 * is selected (and therefore before BluetoothProvider is mounted).
 */
export function useOptionalBluetoothContext(): BluetoothContextValue | null {
  return useContext(BluetoothContext);
}

export { BluetoothContext };
