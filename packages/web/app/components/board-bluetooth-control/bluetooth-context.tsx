'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'next/navigation';
import { track } from '@/app/lib/analytics';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useBoardBluetooth } from './use-board-bluetooth';
import { useCurrentClimb } from '../graphql-queue';
import type { BoardDetails } from '@/app/lib/types';
import type { ClimbQueueItem } from '../queue-control/types';
import {
  isCapacitor,
  isCapacitorWebView,
  waitForCapacitor,
  CAPACITOR_BRIDGE_TIMEOUT_MS,
} from '@/app/lib/ble/capacitor-utils';
import {
  registerBluetoothConnection,
  registerManualSender,
  setActiveBluetoothSerial,
  type ManualSender,
} from './bluetooth-status-store';
import { DevicePickerDialog } from './device-picker-dialog';
import { BoardConfigMismatchDialog } from './board-config-mismatch-dialog';
import { AutoConnectHandler } from './auto-connect-handler';
import { parseSerialNumber } from './bluetooth-aurora';
import { emitWallConfirm } from './wall-confirm-bus';
import { usePersistentSessionActions, usePersistentSessionState } from '@/app/components/persistent-session';
import { useSnackbar } from '../providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { resolveSerialNumbers, type ResolvedBoardEntry } from '@/app/lib/ble/resolve-serials';
import { buildSwitchUrl, decidePickerSelection, type ResolvedBoardConfig } from '@/app/lib/ble/board-config-match';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { DiscoveredDevice } from '@/app/lib/ble/types';
import type { PickerState } from './use-board-bluetooth';
import { useLedColorOverrides, type LedColorOverrides } from '@/app/lib/led-color-overrides-db';
import { useRecordBoardSend } from '@/app/hooks/use-record-board-send';

type BluetoothContextValue = {
  isConnected: boolean;
  loading: boolean;
  connect: (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>;
  disconnect: () => void;
  /**
   * Send LED frames to the connected board. The `signal` parameter is plumbed
   * through to the underlying BLE adapter write — primarily used internally by
   * `BluetoothAutoSender` (mounted by this provider) to abort in-flight writes
   * when the provider unmounts mid-send so post-send side effects (analytics,
   * `confirmClimbOnWall`) are skipped for a navigated-away climb. The
   * parameter remains on the public context type for future external callers
   * that need cancellation.
   */
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
  /** BLE-reported serial of the connected controller — null when no board
   * is connected or when the controller did not expose a parsable serial
   * (e.g. MoonBoard). Drives the per-board history room key. */
  connectedSerial: string | null;
};

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

/**
 * Isolated child component that subscribes to CurrentClimbContext and auto-sends
 * climb data over BLE. Only mounted when isConnected is true so BluetoothProvider
 * itself never subscribes to the climb context — preventing re-renders of the
 * entire component tree on every climb change when BT is disconnected.
 */
function countClimbHolds(frames: string | undefined | null): number {
  if (!frames) return 0;
  return frames.split('p').length - 1;
}

function BluetoothAutoSender({
  sendFramesToBoard,
  layoutName,
  onWallConfirmed,
  boardSerial,
  sessionId,
  sharedPlaylistMode,
}: {
  sendFramesToBoard: (
    frames: string,
    mirrored?: boolean,
    signal?: AbortSignal,
    climbUuid?: string,
  ) => Promise<boolean | undefined>;
  layoutName: string;
  /**
   * Fires after a successful BLE write. Always emits onto the local
   * wall-confirm bus (so the same phone's drawer timer dismisses); in party
   * mode it additionally broadcasts via `confirmClimbOnWall` so non-BLE
   * participants see the confirmation. Keeping both paths in one callback
   * means BluetoothAutoSender doesn't need to know whether a session exists.
   */
  onWallConfirmed: (climbUuid: string) => void;
  /** BLE-reported serial of the connected controller. Null for boards
   * that don't expose a serial (MoonBoard) — `recordBoardSend` skips
   * when missing because the per-board room is keyed by serial. */
  boardSerial: string | null;
  /** Active party session id, if any. Recorded as context on the history row. */
  sessionId: string | null;
  /** Whether the shared-playlist queue was active at send time. */
  sharedPlaylistMode: boolean;
}) {
  const { currentClimbQueueItem } = useCurrentClimb();
  const { recordSend } = useRecordBoardSend();
  // Mirror onWallConfirmed so the send loop doesn't re-run when
  // sessionId-derived callback identity changes mid-send.
  const onWallConfirmedRef = useRef(onWallConfirmed);

  // Latest-wins refs so the send effect doesn't fire purely because the
  // surrounding session/serial changed; the effect's dep array stays focused
  // on the climb itself.
  const recordContextRef = useRef({ boardSerial, sessionId, sharedPlaylistMode, recordSend });
  recordContextRef.current = { boardSerial, sessionId, sharedPlaylistMode, recordSend };

  // Latest-wins refs for the manual-send path. The "Send your pick" CTA in
  // the play-view drawer header lives outside this provider's tree (the
  // queue control bar is mounted at the root), so the only way for it to
  // drive a send is through the module-level manual-sender registry.
  const manualSendContextRef = useRef({ currentClimbQueueItem, sendFramesToBoard, layoutName });
  manualSendContextRef.current = { currentClimbQueueItem, sendFramesToBoard, layoutName };

  // Register a manual-send callback on every render so the closure always
  // sees the freshest context refs. `registerManualSender` is last-wins —
  // the latest registration replaces the previous, and unmount releases.
  useEffect(() => {
    const sender: ManualSender = async () => {
      const ctx = manualSendContextRef.current;
      const queueItem = ctx.currentClimbQueueItem;
      if (!queueItem) return false;
      const { climb } = queueItem;

      try {
        const result = await ctx.sendFramesToBoard(climb.frames, !!climb.mirrored, undefined, climb.uuid);
        if (result === true) {
          track('Climb Sent to Board Success', {
            climbUuid: climb.uuid,
            boardLayout: ctx.layoutName,
            source: 'manual-resend',
          });
          const recordCtx = recordContextRef.current;
          if (recordCtx.boardSerial) {
            void recordCtx.recordSend({
              boardSerial: recordCtx.boardSerial,
              boardId: null,
              climbUuid: climb.uuid,
              angle: climb.angle,
              isMirror: !!climb.mirrored,
              frames: climb.frames,
              source: 'BLE_SEND',
              sessionId: recordCtx.sessionId,
              sharedPlaylistMode: recordCtx.sharedPlaylistMode,
            });
          }
          // Manual re-send also clears any pending wall-confirm fallback
          // timer and broadcasts to non-BLE peers, mirroring the auto-send
          // path.
          onWallConfirmedRef.current(climb.uuid);
          return true;
        }
        if (result === false) {
          track('Climb Sent to Board Failure', {
            climbUuid: climb.uuid,
            boardLayout: ctx.layoutName,
            source: 'manual-resend',
          });
        }
        return false;
      } catch (error) {
        console.error('[BluetoothAutoSender] manual re-send failed:', error);
        track('Climb Sent to Board Failure', {
          climbUuid: climb.uuid,
          boardLayout: ctx.layoutName,
          source: 'manual-resend',
        });
        return false;
      }
    };
    const release = registerManualSender(sender);
    return release;
  }, []);

  useEffect(() => {
    onWallConfirmedRef.current = onWallConfirmed;
  }, [onWallConfirmed]);

  // Serialize BLE writes with a latest-wins queue. Web Bluetooth on Android
  // can't actually cancel an in-flight GATT operation when the JS AbortSignal
  // fires — the OS-level write keeps going, so a second adapter.write
  // started before it completes throws "GATT operation already in progress."
  // With my recent reducer fix that lets duplicate server broadcasts through
  // (so the BLE phone re-sends on every CurrentClimbChanged, including
  // takeControl(currentClimb) re-broadcasts of the same climb), this hits
  // any time two broadcasts land in quick succession.
  //
  // Pattern: while a write is in flight, store the most recent pending
  // climb. When the current write resolves, the drain loop picks up
  // whatever's pending and sends that, repeating until pending is empty.
  // Intermediate climbs that got overwritten are skipped — same end state
  // as the old abort-and-restart pattern, but no overlapping GATT calls.
  const isWritingRef = useRef(false);
  const pendingClimbRef = useRef<ClimbQueueItem | null>(null);
  // Deduplicate same-uuid broadcasts. The reducer now lets duplicate
  // CurrentClimbChanged events through (so the BLE phone re-sends on each
  // event), but the wall is already showing the climb — re-sending double-
  // counts analytics and double-fires confirmClimbOnWall. Skip the send when
  // the pending uuid matches the last one we actually wrote.
  const lastSentUuidRef = useRef<string | null>(null);
  // Single AbortController lives across the AutoSender's lifetime. Aborted
  // exactly once on unmount so the in-flight drain loop (a) cancels the
  // underlying adapter.write via the signal, and (b) returns before firing
  // analytics / confirmClimbOnWall for a climb the user has navigated away
  // from. Scoping per-effect would abort on every climb change and break
  // the latest-wins drain pattern.
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
          // Deduplicate same-uuid re-broadcasts. The board is idempotent so a
          // re-send is functionally fine, but we'd double-fire analytics and
          // confirmClimbOnWall — skip the send entirely instead.
          if (item.climb.uuid === lastSentUuidRef.current) {
            toSend = pendingClimbRef.current;
            pendingClimbRef.current = null;
            continue;
          }
          const climbHoldCount = countClimbHolds(item.climb.frames);
          try {
            const result = await sendFramesToBoard(item.climb.frames, !!item.climb.mirrored, signal, item.climb.uuid);
            // After the await, the AutoSender may have unmounted — skip the
            // post-send side effects so a navigated-away climb doesn't fire
            // analytics or confirmClimbOnWall for a session the user has left.
            if (signal?.aborted) return;
            if (result === true) {
              lastSentUuidRef.current = item.climb.uuid;
              track('Climb Sent to Board Success', {
                climbUuid: item.climb?.uuid,
                boardLayout: layoutName,
              });
              // Append to the per-board history log. The hook is fire-and-forget
              // — failures land in console.warn so they don't disrupt the BLE
              // session. We only fire when a serial is known: MoonBoard sends
              // (serial=null) cannot key into the per-board room, and unauth'd
              // users hit the soft pairing gate server-side anyway. Skipping at
              // the call site keeps the log clean.
              const recordCtx = recordContextRef.current;
              if (recordCtx.boardSerial) {
                void recordCtx.recordSend({
                  boardSerial: recordCtx.boardSerial,
                  boardId: null,
                  climbUuid: item.climb.uuid,
                  angle: item.climb.angle,
                  isMirror: !!item.climb.mirrored,
                  frames: item.climb.frames,
                  source: 'BLE_SEND',
                  sessionId: recordCtx.sessionId,
                  sharedPlaylistMode: recordCtx.sharedPlaylistMode,
                });
              }
              // Wall actually received the climb — emit confirmation so the
              // drawer's lightbulb timer dismisses (locally on this phone,
              // and via WS broadcast for other party members).
              onWallConfirmedRef.current(item.climb.uuid);
            } else if (result === false) {
              track('Climb Sent to Board Failure', {
                climbUuid: item.climb?.uuid,
                boardLayout: layoutName,
                failureReason: 'characteristic_unavailable',
                climbHoldCount,
              });
            }
          } catch (error) {
            if (signal?.aborted) return;
            console.error('Error sending climb to board:', error);
            track('Climb Sent to Board Failure', {
              climbUuid: item.climb?.uuid,
              boardLayout: layoutName,
              failureReason: 'write_aborted',
              climbHoldCount,
            });
          }
          toSend = pendingClimbRef.current;
          pendingClimbRef.current = null;
        }
      } finally {
        isWritingRef.current = false;
      }
    };
    void drain();
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

  // Party-session hooks pulled here so the AutoSender (mounted only when
  // connected) and the connect callback share the same references. The
  // BluetoothProvider always mounts inside a PersistentSessionProvider in
  // the live tree, so these calls always resolve. Tests must provide a mock.
  const persistentSessionActions = usePersistentSessionActions();
  const persistentSessionState = usePersistentSessionState();
  const sessionId = persistentSessionState.session?.id ?? null;
  const { confirmClimbOnWall, setSessionBoardSerial } = persistentSessionActions;
  // Mirror the live sessionId into a ref so the BLE-connect callback
  // (created during useBoardBluetooth init) reads the current value, not a
  // stale snapshot from the first render.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const handleConnectSuccess = useCallback(
    (serial: string | null) => {
      if (!serial) return;
      if (sessionIdRef.current) {
        void setSessionBoardSerial(serial);
      }
    },
    [setSessionBoardSerial],
  );

  const { isConnected, loading, connect, disconnect, sendFramesToBoard, pickerState, connectedSerial } =
    useBoardBluetooth({
      boardDetails,
      boardUuid,
      ledColorOverrides,
      onConnectSuccess: handleConnectSuccess,
    });

  // Always emit on the local wall-confirm bus (so the same phone's drawer
  // dismisses its 2s fallback timer); only fire the WS mutation when a
  // session exists (solo has no peers to notify).
  const handleWallConfirmed = useCallback(
    (climbUuid: string) => {
      emitWallConfirm(climbUuid);
      if (sessionIdRef.current) {
        void confirmClimbOnWall(climbUuid);
      }
    },
    [confirmClimbOnWall],
  );
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('settings');
  // Read activeSession for board-history attribution. The same
  // persistentSessionState read above (line 358) is reused — both call sites
  // mount BluetoothProvider inside PersistentSessionProvider (root layout via
  // PersistentSessionWrapper), so this is safe.
  const { activeSession } = persistentSessionState;

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

  // Publish the connected serial into the module-level store so the
  // BoardHistoryProvider (mounted above BluetoothProvider in the tree) can
  // pick the right per-board room without subscribing to this context.
  // Reset on unmount/disconnect so a stale serial doesn't leak between
  // provider mounts.
  useEffect(() => {
    setActiveBluetoothSerial(isConnected ? connectedSerial : null);
    return () => {
      setActiveBluetoothSerial(null);
    };
  }, [isConnected, connectedSerial]);

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
      connectedSerial,
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
      connectedSerial,
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
        <BluetoothAutoSender
          sendFramesToBoard={sendFramesToBoard}
          layoutName={boardDetails.layout_name ?? ''}
          onWallConfirmed={handleWallConfirmed}
          boardSerial={connectedSerial}
          sessionId={activeSession?.sessionId ?? null}
          // `?? true` mirrors the queue-bridge default for legacy IDB rows
          // that predate the field — they're treated as shared playlists on.
          sharedPlaylistMode={activeSession ? (activeSession.sharedPlaylistEnabled ?? true) : false}
        />
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
