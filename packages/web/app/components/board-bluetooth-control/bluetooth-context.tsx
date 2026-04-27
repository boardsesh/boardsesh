'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@/app/lib/analytics';
import { useBoardBluetooth } from './use-board-bluetooth';
import { useCurrentClimb } from '../graphql-queue';
import type { BoardDetails } from '@/app/lib/types';
import {
  isCapacitor,
  isCapacitorWebView,
  waitForCapacitor,
  CAPACITOR_BRIDGE_TIMEOUT_MS,
} from '@/app/lib/ble/capacitor-utils';
import { registerBluetoothConnection } from './bluetooth-status-store';
import { DevicePickerDialog } from './device-picker-dialog';
import { AutoConnectHandler } from './auto-connect-handler';
import { parseSerialNumber } from './bluetooth-aurora';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { resolveSerialNumbers } from '@/app/lib/ble/resolve-serials';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { DiscoveredDevice } from '@/app/lib/ble/types';
import type { PickerState } from './use-board-bluetooth';

type BluetoothContextValue = {
  isConnected: boolean;
  loading: boolean;
  connect: (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>;
  disconnect: () => void;
  sendFramesToBoard: (
    frames: string,
    mirrored?: boolean,
    signal?: AbortSignal,
    climbUuid?: string,
  ) => Promise<boolean | undefined>;
  isBluetoothSupported: boolean;
  isIOS: boolean;
};

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

/**
 * Isolated child component that subscribes to CurrentClimbContext and auto-sends
 * climb data over BLE. Only mounted when isConnected is true so BluetoothProvider
 * itself never subscribes to the climb context — preventing re-renders of the
 * entire component tree on every climb change when BT is disconnected.
 */
function BluetoothAutoSender({
  sendFramesToBoard,
  layoutName,
}: {
  sendFramesToBoard: (
    frames: string,
    mirrored?: boolean,
    signal?: AbortSignal,
    climbUuid?: string,
  ) => Promise<boolean | undefined>;
  layoutName: string;
}) {
  const { currentClimbQueueItem } = useCurrentClimb();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!currentClimbQueueItem) return;

    // Abort any in-flight BLE write from the previous climb
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const sendClimb = async () => {
      try {
        const result = await sendFramesToBoard(
          currentClimbQueueItem.climb.frames,
          !!currentClimbQueueItem.climb.mirrored,
          controller.signal,
          currentClimbQueueItem.climb.uuid,
        );

        // Skip analytics if this send was aborted (rapid swiping)
        if (controller.signal.aborted) return;

        if (result === true) {
          track('Climb Sent to Board Success', {
            climbUuid: currentClimbQueueItem.climb?.uuid,
            boardLayout: layoutName,
          });
        } else if (result === false) {
          track('Climb Sent to Board Failure', {
            climbUuid: currentClimbQueueItem.climb?.uuid,
            boardLayout: layoutName,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Error sending climb to board:', error);
        track('Climb Sent to Board Failure', {
          climbUuid: currentClimbQueueItem.climb?.uuid,
          boardLayout: layoutName,
        });
      }
    };
    void sendClimb();

    return () => {
      controller.abort();
    };
  }, [currentClimbQueueItem, sendFramesToBoard, layoutName]);

  return null;
}

export function BluetoothProvider({
  boardDetails,
  children,
}: {
  boardDetails: BoardDetails;
  children: React.ReactNode;
}) {
  const { isConnected, loading, connect, disconnect, sendFramesToBoard, pickerState } = useBoardBluetooth({
    boardDetails,
  });
  const { token } = useWsAuthToken();

  const [isBluetoothSupported, setIsBluetoothSupported] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  // Resolve BLE device serial numbers to known boards
  const [resolvedBoards, setResolvedBoards] = useState<Map<string, UserBoard>>(new Map());
  const resolvedSerialsRef = useRef<string>('');

  // Test-only escape hatch for app-store screenshot generation. When the
  // sessionStorage flag is present, render the picker with three plausible
  // Aurora-named devices and pre-resolved UserBoards so the BLE pairing
  // screenshot shows named boards with proper thumbnails (Web Bluetooth is
  // unavailable in headless Chromium, and the demo serials don't exist in
  // the dev DB so the real resolver wouldn't match them).
  const [demoPickerState, setDemoPickerState] = useState<PickerState | null>(null);
  const [demoResolvedBoards, setDemoResolvedBoards] = useState<Map<string, UserBoard> | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem('boardsesh:e2e-bluetooth-picker') !== '1') return;

    // Real boards (and where available, real serials) sourced from
    // production user_boards.json so the picker shows authentic-looking
    // names + thumbnails. The Tension board has no real serial in the
    // dataset, so a synthetic one is used purely to drive the resolver.
    const dummyDevices: DiscoveredDevice[] = [
      { deviceId: 'demo-kilter-marco', name: 'Kilter Board#751737@3', rssi: -45 },
      { deviceId: 'demo-kilter-rise', name: 'Kilter Board#751970@3', rssi: -62 },
      { deviceId: 'demo-tension-9d', name: 'Tension Board#480221@2', rssi: -78 },
    ];
    const makeBoard = (
      overrides: Partial<UserBoard> &
        Pick<UserBoard, 'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'name' | 'serialNumber'>,
    ): UserBoard => ({
      uuid: `demo-${overrides.serialNumber}`,
      slug: `demo-${overrides.serialNumber}`,
      ownerId: 'demo-owner',
      isPublic: false,
      isUnlisted: true,
      hideLocation: true,
      isOwned: true,
      angle: 40,
      isAngleAdjustable: true,
      createdAt: new Date(0).toISOString(),
      totalAscents: 0,
      uniqueClimbers: 0,
      followerCount: 0,
      commentCount: 0,
      isFollowedByMe: false,
      ...overrides,
    });
    const boardsBySerial = new Map<string, UserBoard>([
      [
        '751737',
        makeBoard({
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          setIds: '28,29,26,27',
          name: "Marco's Board",
          serialNumber: '751737',
          angle: 35,
        }),
      ],
      [
        '751970',
        makeBoard({
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 22,
          setIds: '26',
          name: 'Rise and Grind',
          serialNumber: '751970',
          locationName: 'Denver, CO',
          angle: 25,
        }),
      ],
      [
        '480221',
        makeBoard({
          boardType: 'tension',
          layoutId: 10,
          sizeId: 6,
          setIds: '12,13',
          name: '9 Degrees Chatswood',
          serialNumber: '480221',
        }),
      ],
    ]);
    setDemoResolvedBoards(boardsBySerial);
    setDemoPickerState({
      devices: dummyDevices,
      handleSelect: () => setDemoPickerState(null),
      handleCancel: () => setDemoPickerState(null),
    });
  }, []);

  const activePickerState = pickerState ?? demoPickerState;
  const activeResolvedBoards = demoResolvedBoards ?? resolvedBoards;

  useEffect(() => {
    if (!activePickerState || activePickerState.devices.length === 0 || !token) {
      return;
    }

    const serials: string[] = [];
    for (const device of activePickerState.devices) {
      const serial = parseSerialNumber(device.name);
      if (serial) serials.push(serial);
    }

    if (serials.length === 0) return;

    // Check if we already resolved these serials (resolveSerialNumbers deduplicates internally)
    const sortedSerials = [...serials].sort();
    const serialsKey = sortedSerials.join(',');
    if (serialsKey === resolvedSerialsRef.current) return;

    resolveSerialNumbers(token, sortedSerials)
      .then((boardMap) => {
        // Only mark as resolved on success so transient failures allow retries
        resolvedSerialsRef.current = serialsKey;
        setResolvedBoards(boardMap);
      })
      .catch((err) => {
        console.error('[BLE] Failed to resolve serial numbers:', err);
      });
  }, [activePickerState, token]);

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
      void waitForCapacitor(CAPACITOR_BRIDGE_TIMEOUT_MS).then((found) => {
        if (!cancelled && found) {
          setIsBluetoothSupported(true);
        }
      });
      cancelPolling = () => {
        cancelled = true;
      };
    }

    if (
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod/i.test(navigator.userAgent || (navigator as { vendor?: string }).vendor || '')
    ) {
      setIsIOS(true);
    }

    return () => cancelPolling?.();
  }, []);

  // Register with the module-level status store so consumers rendered
  // outside this provider (the root bottom tab bar, board switch guard)
  // can observe BT connection state and trigger disconnect.
  useEffect(() => {
    if (!isConnected) return;
    const release = registerBluetoothConnection(disconnect);
    return release;
  }, [isConnected, disconnect]);

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
    [isConnected, loading, connect, disconnect, sendFramesToBoard, isBluetoothSupported, isIOS],
  );

  return (
    <BluetoothContext.Provider value={value}>
      {isConnected && (
        <BluetoothAutoSender sendFramesToBoard={sendFramesToBoard} layoutName={boardDetails.layout_name ?? ''} />
      )}
      {activePickerState && (
        <DevicePickerDialog
          devices={activePickerState.devices}
          onSelect={activePickerState.handleSelect}
          onCancel={activePickerState.handleCancel}
          resolvedBoards={activeResolvedBoards}
        />
      )}
      <AutoConnectHandler connect={connect} isBluetoothSupported={isBluetoothSupported} />
      {children}
    </BluetoothContext.Provider>
  );
}

export function useBluetoothContext() {
  const context = useContext(BluetoothContext);
  if (!context) {
    throw new Error('useBluetoothContext must be used within a BluetoothProvider');
  }
  return context;
}

export { BluetoothContext };
