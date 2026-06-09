import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { emitWallConfirm } from '@boardsesh/play-view';
import { useBoardBluetooth } from '../lib/ble/use-board-bluetooth';
import { registerBluetoothConnection } from '../lib/ble/bluetooth-status-store';
import { useQueue, useQueueSessionControls } from './queue-provider';
import { hapticSuccess } from '../lib/haptics';
import { DevicePickerSheet } from '../components/ble/DevicePickerSheet';
import { track } from '../lib/analytics';

type BluetoothContextValue = {
  isConnected: boolean;
  loading: boolean;
  connect: (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  sendFramesToBoard: (frames: string, mirrored?: boolean, signal?: AbortSignal) => Promise<boolean | undefined>;
  clearBoard: () => Promise<boolean | undefined>;
  /**
   * Force the auto-sender to re-push the current climb to the wall once, even
   * when the rendered pixels are byte-identical to the last send (which it
   * normally dedups). The lightbulb tap calls this so re-taking control of an
   * unchanged climb re-lights the wall — and, if the link is secretly dead, the
   * failing write trips disconnect detection. No-op until called.
   */
  reassertWall: () => void;
  /**
   * Serial to silently reconnect to for the board currently in view, or null
   * when nothing is remembered or the user switched boards — in which case
   * callers open the device picker instead.
   */
  reconnectSerialForCurrentBoard: string | null;
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
 * - Deduplicates byte-identical broadcasts via `lastSentSignatureRef` (keyed on
 *   uuid + frames + mirror, so a mirror toggle or hold edit on the same climb
 *   re-pushes), and a `reassertNonce` bump punches through the dedup once.
 */
function BluetoothAutoSender({
  sendFramesToBoard,
  onWallConfirmed,
  reassertNonce,
}: {
  sendFramesToBoard: (frames: string, mirrored?: boolean, signal?: AbortSignal) => Promise<boolean | undefined>;
  onWallConfirmed: (climbUuid: string) => void;
  reassertNonce: number;
}) {
  const { state } = useQueue();
  const { currentClimbQueueItem } = state;
  const onWallConfirmedRef = useRef(onWallConfirmed);
  useEffect(() => {
    onWallConfirmedRef.current = onWallConfirmed;
  }, [onWallConfirmed]);

  const isWritingRef = useRef(false);
  const pendingClimbRef = useRef<ClimbQueueItem | null>(null);
  // The signature of the last climb actually pushed to the wall: uuid + rendered
  // frames + mirror state. Re-broadcasts with the same signature skip the
  // physical write (the board is idempotent, but we'd double-fire haptics);
  // changing any of the three re-pushes.
  const lastSentSignatureRef = useRef<string | null>(null);
  // Last `reassertNonce` acted on. When the incoming nonce differs, a one-shot
  // re-push is requested so the current climb re-fires even if unchanged.
  const lastReassertNonceRef = useRef(reassertNonce);
  // Set when a reassert is requested, consumed inside the drain loop. A ref
  // (not just clearing the signature in the effect) so a reassert landing
  // *during* an in-flight write survives: the completing write re-sets the
  // signature, and clearing it again at the top of the next loop iteration is
  // what actually forces the re-push.
  const reassertPendingRef = useRef(false);

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

    // A reassert request (lightbulb re-take) forces a fresh write of the current
    // climb even when the pixels are byte-identical. Flag it; the drain loop
    // clears the dedup signature when it picks the climb up, which also covers
    // a reassert that lands while a write is already in flight.
    if (reassertNonce !== lastReassertNonceRef.current) {
      lastReassertNonceRef.current = reassertNonce;
      reassertPendingRef.current = true;
    }

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

          // Honour a pending reassert exactly when the climb is picked up —
          // clearing the signature here (rather than in the effect) survives an
          // in-flight write that re-set it on completion.
          if (reassertPendingRef.current) {
            reassertPendingRef.current = false;
            lastSentSignatureRef.current = null;
          }

          // Deduplicate byte-identical re-broadcasts (same climb, frames and
          // mirror). The board is idempotent so a re-send is functionally fine,
          // but we'd double-fire haptics. A mirror toggle or hold edit changes
          // the signature and re-pushes.
          const sendSignature = `${item.climb.uuid}::${item.climb.frames}::${item.climb.mirrored ? 1 : 0}`;
          if (sendSignature === lastSentSignatureRef.current) {
            onWallConfirmedRef.current(item.climb.uuid);
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
              lastSentSignatureRef.current = sendSignature;
              onWallConfirmedRef.current(item.climb.uuid);
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
  }, [currentClimbQueueItem, sendFramesToBoard, reassertNonce]);

  return null;
}

type BluetoothProviderProps = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  children: React.ReactNode;
};

export function BluetoothProvider({ boardName, layoutId, sizeId, children }: BluetoothProviderProps) {
  const { sessionId, confirmClimbOnWall, setSessionBoardSerial, lastConnectedBoardSerial } = useQueueSessionControls();
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const lastConnectedBoardSerialRef = useRef(lastConnectedBoardSerial);
  useEffect(() => {
    lastConnectedBoardSerialRef.current = lastConnectedBoardSerial;
  }, [lastConnectedBoardSerial]);

  const handleWallConfirmed = useCallback(
    (climbUuid: string) => {
      emitWallConfirm(climbUuid);
      if (sessionIdRef.current) {
        void confirmClimbOnWall(climbUuid);
      }
    },
    [confirmClimbOnWall],
  );

  const handleConnectSuccess = useCallback(
    (serial: string | null) => {
      if (!serial) return;
      if (!sessionIdRef.current) return;
      const previousSerial = lastConnectedBoardSerialRef.current;
      if (previousSerial === serial) return;
      lastConnectedBoardSerialRef.current = serial;
      void setSessionBoardSerial(serial);
      track('Session Board Serial Set', {
        mode: 'party',
        previousSerialKnown: previousSerial != null,
        boardLayout: boardName ?? '',
      });
    },
    [boardName, setSessionBoardSerial],
  );

  const { isConnected, loading, connect, disconnect, sendFramesToBoard, pickerState, reconnectSerialForCurrentBoard } =
    useBoardBluetooth({
      boardName,
      layoutId,
      sizeId,
      onConnectSuccess: handleConnectSuccess,
    });

  const clearBoard = useCallback(() => sendFramesToBoard(''), [sendFramesToBoard]);

  // Bumped by `reassertWall()` to force the auto-sender to re-push the current
  // climb once, bypassing the byte-identical dedup.
  const [reassertNonce, setReassertNonce] = useState(0);
  const reassertWall = useCallback(() => setReassertNonce((nonce) => nonce + 1), []);

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

  // Detect an unexpected drop (connected → disconnected without a user-initiated
  // disconnect) for telemetry only. `isUserDisconnectRef` suppresses deliberate ones.
  const wasConnectedRef = useRef(false);
  const isUserDisconnectRef = useRef(false);

  // Wrap disconnect to track user-initiated disconnects
  const wrappedDisconnect = useCallback(async () => {
    isUserDisconnectRef.current = true;
    track(SHARED_EVENTS.BluetoothDisconnected, { boardName, reason: 'user', inSession: sessionIdRef.current != null });
    try {
      await disconnect();
    } finally {
      isUserDisconnectRef.current = false;
    }
  }, [disconnect, boardName]);

  // Losing the BLE link is expected (RF noise, or another climber grabbing the
  // last-connection-wins board), so an unexpected drop just lets the lightbulb go
  // unlit (driven by isConnected) — we never auto-reconnect, buzz an error, or pop
  // the device picker. Reconnecting stays a deliberate lightbulb tap. Recorded so
  // drop frequency stays visible in analytics.
  useEffect(() => {
    if (wasConnectedRef.current && !isConnected && !isUserDisconnectRef.current) {
      track(SHARED_EVENTS.BluetoothDisconnected, {
        boardName,
        reason: 'unexpected',
        inSession: sessionIdRef.current != null,
      });
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, boardName]);

  const value = useMemo<BluetoothContextValue>(
    () => ({
      isConnected,
      loading,
      connect,
      disconnect: wrappedDisconnect,
      sendFramesToBoard,
      clearBoard,
      reassertWall,
      reconnectSerialForCurrentBoard,
    }),
    [
      isConnected,
      loading,
      connect,
      wrappedDisconnect,
      sendFramesToBoard,
      clearBoard,
      reassertWall,
      reconnectSerialForCurrentBoard,
    ],
  );

  return (
    <BluetoothContext.Provider value={value}>
      {isConnected && (
        <BluetoothAutoSender
          sendFramesToBoard={sendFramesToBoard}
          onWallConfirmed={handleWallConfirmed}
          reassertNonce={reassertNonce}
        />
      )}
      {children}
      {pickerState && (
        <DevicePickerSheet
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
