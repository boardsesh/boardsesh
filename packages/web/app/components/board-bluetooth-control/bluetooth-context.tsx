'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'next/navigation';
import { track } from '@/app/lib/analytics';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
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
import { BoardConfigMismatchDialog } from './board-config-mismatch-dialog';
import { AutoConnectHandler } from './auto-connect-handler';
import { parseSerialNumber } from './bluetooth-aurora';
import { useSnackbar } from '../providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { resolveSerialNumbers, type ResolvedBoardEntry } from '@/app/lib/ble/resolve-serials';
import { buildSwitchUrl, decidePickerSelection, type ResolvedBoardConfig } from '@/app/lib/ble/board-config-match';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { DiscoveredDevice } from '@/app/lib/ble/types';
import type { PickerState } from './use-board-bluetooth';
import { useLedColorOverrides, type LedColorOverrides } from '@/app/lib/led-color-overrides-db';

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
  /** Send a "clear all LEDs" packet to the connected board. */
  clearBoard: () => Promise<boolean | undefined>;
  /** Board configuration for the current route — exposed so light-show
   * features (party mode) can read holdsData and edge bounds. */
  boardDetails: BoardDetails;
  /** Which non-queue light show is driving the board, if any. The
   * auto-sender stops emitting queue frames whenever this is non-'off'.
   * 'glyphs' spells BOARDSESH across the wall; 'disco' strobes the
   * current climb's holds through random role colours. */
  partyMode: 'off' | 'glyphs' | 'disco';
  setPartyMode: (mode: 'off' | 'glyphs' | 'disco') => void;
  /** Per-state hex colour overrides for HAND/FOOT/FINISH LEDs. Persisted in
   * IndexedDB; consumers update via setLedColorOverrides which re-renders
   * the auto-sender so the current climb repaints. */
  ledColorOverrides: LedColorOverrides;
  setLedColorOverrides: (next: LedColorOverrides) => void;
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
  boardUuid,
  children,
}: {
  boardDetails: BoardDetails;
  /** Saved board UUID when this provider sits under a /b/{slug}/... route. */
  boardUuid?: string;
  children: React.ReactNode;
}) {
  const [ledColorOverrides, setLedColorOverrides] = useLedColorOverrides();

  const { isConnected, loading, connect, disconnect, sendFramesToBoard, pickerState } = useBoardBluetooth({
    boardDetails,
    boardUuid,
    ledColorOverrides,
  });
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('settings');

  const [partyMode, setPartyMode] = useState<'off' | 'glyphs' | 'disco'>('off');
  const clearBoard = useCallback(() => sendFramesToBoard(''), [sendFramesToBoard]);

  // Stop any active light show the moment the board disconnects so a
  // reconnect doesn't immediately resume an orphaned interval in the drawer.
  useEffect(() => {
    if (!isConnected && partyMode !== 'off') setPartyMode('off');
  }, [isConnected, partyMode]);

  // Both `[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...` and
  // `/b/{slug}/{angle}/...` routes carry `[angle]` as a dynamic segment.
  // Read it here instead of taking it as a prop so the provider isn't
  // coupled to the route shape at the call site — only the mismatch
  // dialog's "switch URL" builder needs it. Stays `null` when absent so
  // the switch handler can warn instead of routing the user to angle 0.
  const params = useParams<{ angle?: string }>();
  const parsedAngle = params?.angle != null ? Number(params.angle) : Number.NaN;
  const routeAngle: number | null = Number.isFinite(parsedAngle) ? parsedAngle : null;

  const [isBluetoothSupported, setIsBluetoothSupported] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  // Resolve BLE device serial numbers to known boards or to auto-recorded configs.
  const [resolvedBoards, setResolvedBoards] = useState<Map<string, ResolvedBoardEntry>>(new Map());
  const resolvedSerialsRef = useRef<string>('');

  // Test-only escape hatch for app-store screenshot generation. When the
  // sessionStorage flag is present, render the picker with three plausible
  // Aurora-named devices and pre-resolved UserBoards so the BLE pairing
  // screenshot shows named boards with proper thumbnails (Web Bluetooth is
  // unavailable in headless Chromium, and the demo serials don't exist in
  // the dev DB so the real resolver wouldn't match them).
  const [demoPickerState, setDemoPickerState] = useState<PickerState | null>(null);
  const [demoResolvedBoards, setDemoResolvedBoards] = useState<Map<string, ResolvedBoardEntry> | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // oxlint-disable-next-line no-restricted-globals -- e2e flag must be read synchronously during render
    if (sessionStorage.getItem('boardsesh:e2e-bluetooth-picker') !== '1') return;

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
    const wrap = (board: UserBoard): ResolvedBoardEntry => ({ kind: 'saved', board });
    const boardsBySerial = new Map<string, ResolvedBoardEntry>([
      [
        '751737',
        wrap(
          makeBoard({
            boardType: 'kilter',
            layoutId: 8,
            sizeId: 25,
            setIds: '28,29,26,27',
            name: "Marco's Board",
            serialNumber: '751737',
            angle: 35,
          }),
        ),
      ],
      [
        '751970',
        wrap(
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
        ),
      ],
      [
        '480221',
        wrap(
          makeBoard({
            boardType: 'tension',
            layoutId: 10,
            sizeId: 6,
            setIds: '12,13',
            name: '9 Degrees Chatswood',
            serialNumber: '480221',
          }),
        ),
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

  // Derive a stable key from the *set* of serials in the picker. The
  // pickerState object identity changes on every BLE advertisement (RSSI
  // updates, etc.), but the resolver only needs to re-run when the serial
  // set actually changes.
  const sortedSerialsKey = useMemo(() => {
    if (!activePickerState) return '';
    const serials: string[] = [];
    for (const device of activePickerState.devices) {
      const serial = parseSerialNumber(device.name);
      if (serial) serials.push(serial);
    }
    return [...serials].sort().join(',');
  }, [activePickerState]);

  useEffect(() => {
    if (!sortedSerialsKey || !token) return;
    if (sortedSerialsKey === resolvedSerialsRef.current) return;

    resolveSerialNumbers(token, sortedSerialsKey.split(','), { isAuthenticated })
      .then((boardMap) => {
        // Only mark as resolved on success so transient failures allow retries
        resolvedSerialsRef.current = sortedSerialsKey;
        setResolvedBoards(boardMap);
      })
      .catch((err) => {
        console.error('[BLE] Failed to resolve serial numbers:', err);
      });
  }, [sortedSerialsKey, token, isAuthenticated]);

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
      clearBoard,
      boardDetails,
      partyMode,
      setPartyMode,
      ledColorOverrides,
      setLedColorOverrides,
      isBluetoothSupported,
      isIOS,
    }),
    [
      isConnected,
      loading,
      connect,
      disconnect,
      sendFramesToBoard,
      clearBoard,
      boardDetails,
      partyMode,
      setPartyMode,
      ledColorOverrides,
      setLedColorOverrides,
      isBluetoothSupported,
      isIOS,
    ],
  );

  // Mismatch interception: when the user picks a controller whose resolved
  // config doesn't match the route they're on, hold the picker promise open
  // and surface the BoardConfigMismatchDialog. The picker only emits the
  // selection — this provider decides whether to forward, switch, or cancel.
  const router = useLocaleRouter();
  const [mismatch, setMismatch] = useState<{
    deviceId: string;
    serial: string;
    config: ResolvedBoardConfig;
  } | null>(null);

  const handlePickerSelect = useCallback(
    (deviceId: string) => {
      if (!activePickerState) return;
      const decision = decidePickerSelection(deviceId, activePickerState.devices, activeResolvedBoards, boardDetails);
      if (decision.kind === 'forward') {
        activePickerState.handleSelect(deviceId);
        return;
      }
      setMismatch({ deviceId, serial: decision.serial, config: decision.config });
    },
    [activePickerState, activeResolvedBoards, boardDetails],
  );

  const handleMismatchConnectAnyway = useCallback(() => {
    if (mismatch && activePickerState) {
      activePickerState.handleSelect(mismatch.deviceId);
    }
    setMismatch(null);
  }, [mismatch, activePickerState]);

  const handleMismatchCancel = useCallback(() => {
    setMismatch(null);
  }, []);

  const handleMismatchSwitch = useCallback(() => {
    if (!mismatch) return;
    if (routeAngle == null) {
      // Provider mounted on a route that doesn't carry an [angle] segment.
      // Silently building a URL at angle 0 would yank the user to a fake
      // angle they never picked — surface the issue and let them choose.
      showMessage(t('bluetoothMismatch.switchNoAngleToast'), 'warning');
      return;
    }
    const target = buildSwitchUrl(mismatch.config, routeAngle);
    if (!target) {
      // Couldn't resolve a switch URL (unknown layout/size, missing slug data).
      // Don't silently close both dialogs and strand the user — surface the
      // failure so they can pick "Connect anyway" or cancel deliberately.
      showMessage(t('bluetoothMismatch.switchUrlFailedToast'), 'warning');
      return;
    }
    setMismatch(null);
    // Cancel the in-flight picker promise; the new route will mount a fresh
    // BluetoothProvider that auto-connects via the ?autoConnect serial param.
    activePickerState?.handleCancel();
    router.push(`${target}?autoConnect=${encodeURIComponent(mismatch.serial)}`);
  }, [mismatch, routeAngle, activePickerState, router, showMessage, t]);

  return (
    <BluetoothContext.Provider value={value}>
      {isConnected && partyMode === 'off' && (
        <BluetoothAutoSender sendFramesToBoard={sendFramesToBoard} layoutName={boardDetails.layout_name ?? ''} />
      )}
      {activePickerState && (
        <DevicePickerDialog
          devices={activePickerState.devices}
          onSelect={handlePickerSelect}
          onCancel={activePickerState.handleCancel}
          resolvedBoards={activeResolvedBoards}
        />
      )}
      {mismatch && boardDetails && (
        <BoardConfigMismatchDialog
          open
          currentBoardDetails={boardDetails}
          recordedConfig={mismatch.config}
          onSwitch={handleMismatchSwitch}
          onConnectAnyway={handleMismatchConnectAnyway}
          onCancel={handleMismatchCancel}
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
