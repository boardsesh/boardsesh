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
import { registerBluetoothConnection } from './bluetooth-status-store';
import { DevicePickerDialog } from './device-picker-dialog';
import { BoardConfigMismatchDialog } from './board-config-mismatch-dialog';
import { AutoConnectHandler } from './auto-connect-handler';
import { parseSerialNumber } from './bluetooth-aurora';
import { emitWallConfirm } from '@boardsesh/play-view';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { usePersistentSessionActions, usePersistentSessionState } from '@/app/components/persistent-session';
import { toClimbQueueItemInput } from '@/app/components/persistent-session/types';
import { useBoardPresenceControls, useOptionalWallReport } from '../board-presence/board-presence-context';
import { useSnackbar } from '../providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { resolveSerialNumbers, type ResolvedBoardEntry } from '@/app/lib/ble/resolve-serials';
import { buildSwitchUrl, decidePickerSelection, type ResolvedBoardConfig } from '@/app/lib/ble/board-config-match';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardPresenceClimb, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import type { DiscoveredDevice } from '@/app/lib/ble/types';
import type { PickerState } from './use-board-bluetooth';
import type { BleSendFailureReason } from '@boardsesh/ble-protocol/connection-error';
import { useLedColorOverrides, type LedColorOverrides } from '@/app/lib/led-color-overrides-db';
import { accumulateFramesToMaps, accumulatedMapsToFrameStrings } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';

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
  /** Board configuration for the current route, or null when the single
   * root-level provider is mounted off a board route. Consumers that need a
   * guaranteed board (e.g. the light-show drawer) take it as a prop from a
   * board-scoped parent instead of reading it here. */
  boardDetails: BoardDetails | null;
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
  /**
   * Force the auto-sender to re-push the current climb to the wall once, even
   * when the pixels are byte-identical to the last send (which it normally
   * dedups). The solo lightbulb tap calls this so re-taking control of an
   * unchanged climb actually re-lights the wall — and, if the link is secretly
   * dead, the failing write trips disconnect detection. No-op until called.
   */
  reassertWall: () => void;
  /**
   * Serial to silently reconnect to for the board currently in view (native
   * shells only), or null when nothing is remembered or the user switched
   * boards — in which case callers open the device picker instead.
   */
  reconnectSerialForCurrentBoard: string | null;
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

function getSendSignature(item: ClimbQueueItem): string {
  const rawFrames = item.climb.frames ?? '';
  const mirrored = !!item.climb.mirrored;
  return `${item.climb.uuid}::${rawFrames}::${mirrored ? 1 : 0}`;
}

function getFirstBleFrame(rawFrames: string, boardName: BoardName): string {
  const isSingleFrame = rawFrames.length > 0 && !rawFrames.includes(',') && !rawFrames.includes('x');
  return isSingleFrame
    ? rawFrames
    : (accumulatedMapsToFrameStrings(accumulateFramesToMaps(rawFrames, boardName), boardName)[0] ?? '');
}

function presenceClimbToQueueItemInput(presenceClimb: BoardPresenceClimb): ClimbQueueItemInput {
  return {
    uuid: presenceClimb.queueItemUuid ?? presenceClimb.climbUuid,
    climb: {
      uuid: presenceClimb.climbUuid,
      setter_username: presenceClimb.setter ?? '',
      name: presenceClimb.name ?? '',
      frames: presenceClimb.frames ?? '',
      angle: presenceClimb.angle ?? 0,
      ascensionist_count: 0,
      difficulty: presenceClimb.grade ?? '',
      quality_average: '',
      stars: 0,
      difficulty_error: '',
      mirrored: false,
    },
  };
}

function BluetoothAutoSender({
  sendFramesToBoard,
  lastSendFailureReasonRef,
  layoutName,
  boardName,
  boardId,
  onWallConfirmed,
  reassertNonce,
}: {
  sendFramesToBoard: (
    frames: string,
    mirrored?: boolean,
    signal?: AbortSignal,
    climbUuid?: string,
  ) => Promise<boolean | undefined>;
  /**
   * The reason the hook's most recent `sendFramesToBoard` returned `false`,
   * read synchronously on the `false` branch below to label the failure with
   * its real cause. See the ref's declaration in `use-board-bluetooth.ts`.
   */
  lastSendFailureReasonRef: React.RefObject<BleSendFailureReason | null>;
  layoutName: string;
  boardName: BoardName;
  boardId: number | null;
  /**
   * Fires after a successful BLE write (or a deduped re-broadcast). Always
   * emits onto the local wall-confirm bus (so the same phone's drawer timer
   * dismisses); in party mode it additionally broadcasts via
   * `confirmClimbOnWall`, and it reports the lit climb to the board's wall feed
   * (board presence is always-on). Receives the full lit queue item so the
   * consumer can build both the local confirm (uuid) and the wall report
   * (ClimbQueueItemInput). Keeping all paths in one callback means
   * BluetoothAutoSender doesn't need to know whether a session is active.
   */
  onWallConfirmed: (item: ClimbQueueItem, sendSignature: string) => void;
  /**
   * Bumped by `reassertWall()` to force a one-shot re-send of the current
   * climb that bypasses the byte-identical dedup below. Each new value clears
   * the last-sent signature exactly once so the wall re-lights even when the
   * climb hasn't changed.
   */
  reassertNonce: number;
}) {
  const { currentClimbQueueItem } = useCurrentClimb();
  // Mirror onWallConfirmed so the send loop doesn't re-run when
  // sessionId-derived callback identity changes mid-send.
  const onWallConfirmedRef = useRef(onWallConfirmed);
  useEffect(() => {
    onWallConfirmedRef.current = onWallConfirmed;
  }, [onWallConfirmed]);

  // Serialize BLE writes with a latest-wins queue. Web Bluetooth on Android
  // can't actually cancel an in-flight GATT operation when the JS AbortSignal
  // fires — the OS-level write keeps going, so a second adapter.write
  // started before it completes throws "GATT operation already in progress."
  // With my recent reducer fix that lets duplicate server broadcasts through
  // (so the BLE phone re-sends on every CurrentClimbChanged, including
  // lightbulb re-assert re-broadcasts of the same climb), this hits
  // any time two broadcasts land in quick succession.
  //
  // Pattern: while a write is in flight, store the most recent pending
  // climb. When the current write resolves, the drain loop picks up
  // whatever's pending and sends that, repeating until pending is empty.
  // Intermediate climbs that got overwritten are skipped — same end state
  // as the old abort-and-restart pattern, but no overlapping GATT calls.
  const isWritingRef = useRef(false);
  const pendingClimbRef = useRef<ClimbQueueItem | null>(null);
  // Deduplicate truly-identical re-broadcasts. The reducer lets duplicate
  // CurrentClimbChanged events through (so the BLE phone re-sends on each
  // event) — but the wall is already showing those exact pixels, so re-sending
  // would double-count analytics and double-fire confirmClimbOnWall. We key the
  // skip on the *rendered payload* (climb uuid + frames + mirror), NOT the uuid
  // alone: a mirror toggle, a hold edit (create form), or a driver hand-off all
  // keep the same uuid while needing a fresh write, and a uuid-only key swallows
  // them (the wall would only update after a disconnect/reconnect reset this
  // ref — exactly the regression users reported). A genuine duplicate (same
  // uuid, frames, and mirror) still skips the write but re-emits the wall-confirm
  // so a hand-off taker's 2s timer clears even though no physical re-send ran.
  const lastSentSignatureRef = useRef<string | null>(null);
  // Last `reassertNonce` we've acted on. When the incoming nonce differs, the
  // send effect clears the dedup signature once so the current climb is
  // physically re-written even if its pixels are byte-identical to the last
  // send (the solo lightbulb "re-take" path).
  const lastReassertNonceRef = useRef(reassertNonce);
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
    // A reassert request (lightbulb re-take) forces a fresh write of the
    // current climb: drop the dedup signature so the byte-identical skip below
    // doesn't suppress it. Record the nonce so we punch through exactly once.
    if (reassertNonce !== lastReassertNonceRef.current) {
      lastReassertNonceRef.current = reassertNonce;
      lastSentSignatureRef.current = null;
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
          // For variable-speed climbs (`frames` is a sequence of comma-
          // separated delta frames using `p<id>r<role>` for sets and
          // `x<id>` for offs) the BLE encoder doesn't understand commas
          // or x-tokens and would emit a garbage packet. Accumulate the
          // deltas, take the first frame's snapshot, and re-emit it as a
          // flat sequence of `p<id>r<role>` pairs the encoder can parse.
          //
          // Single-frame climbs (no commas, no `x` tokens) are passed
          // through verbatim — round-tripping rewrites their role codes
          // to STATE_TO_PRIMARY_CODE['kilter'] (Product 7: 42/43/44/45),
          // which would silently break climbs encoded for any other
          // Kilter product (Product 1: 12/13/14/15, Product 2: 20-23, …)
          // by lighting the wrong colours. The playback engine on /play
          // handles subsequent ticks for multi-frame climbs.
          const rawFrames = item.climb.frames ?? '';
          const mirrored = !!item.climb.mirrored;
          // Skip only a byte-identical re-broadcast (same climb, same frames,
          // same mirror). A changed climb, an edited hold, or a flipped mirror
          // all change this signature and fall through to a real write.
          const sendSignature = getSendSignature(item);
          if (sendSignature === lastSentSignatureRef.current) {
            // Same pixels already on the wall — skip the physical write (so we
            // don't double-count analytics) but still confirm so a hand-off
            // taker's 2s wall-confirm timer clears; the wall already shows it.
            onWallConfirmedRef.current(item, sendSignature);
            toSend = pendingClimbRef.current;
            pendingClimbRef.current = null;
            continue;
          }
          const firstFrame = getFirstBleFrame(rawFrames, boardName);
          const climbHoldCount = countClimbHolds(firstFrame);
          try {
            const result = await sendFramesToBoard(firstFrame, mirrored, signal, item.climb.uuid);
            // After the await, the AutoSender may have unmounted — skip the
            // post-send side effects so a navigated-away climb doesn't fire
            // analytics or confirmClimbOnWall for a session the user has left.
            if (signal?.aborted) return;
            if (result === true) {
              lastSentSignatureRef.current = sendSignature;
              track('Climb Sent to Board Success', {
                climbUuid: item.climb?.uuid,
                boardLayout: layoutName,
                boardId: boardId ?? undefined,
              });
              // Wall actually received the climb — emit confirmation so the
              // drawer's lightbulb timer dismisses (locally on this phone,
              // and via WS broadcast for other party members).
              onWallConfirmedRef.current(item, sendSignature);
            } else if (result === false) {
              // The hook set this synchronously on its failing path right before
              // returning false; we read it here in the same microtask the await
              // resolved in, so the real cause — usually `disconnected` after a
              // mid-session board drop — is recorded instead of the old catch-all
              // `characteristic_unavailable`.
              const failureReason = lastSendFailureReasonRef.current ?? 'unknown';
              track('Climb Sent to Board Failure', {
                climbUuid: item.climb?.uuid,
                boardLayout: layoutName,
                boardId: boardId ?? undefined,
                failureReason,
                climbHoldCount,
              });
            }
          } catch (error) {
            if (signal?.aborted) return;
            console.error('Error sending climb to board:', error);
            track('Climb Sent to Board Failure', {
              climbUuid: item.climb?.uuid,
              boardLayout: layoutName,
              boardId: boardId ?? undefined,
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
  }, [currentClimbQueueItem, sendFramesToBoard, layoutName, boardName, boardId, reassertNonce]);

  return null;
}

export function BluetoothProvider({
  boardDetails,
  boardUuid,
  children,
}: {
  /** Null when the single root-level provider is mounted off a board route;
   * BLE stays inert (connect/send are no-ops) until a board route supplies it. */
  boardDetails: BoardDetails | null;
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
  const { confirmClimbOnWall, setSessionBoardSerial, reportWallDisconnect } = persistentSessionActions;
  // Mirror the live sessionId into a ref so the BLE-connect callback
  // (created during useBoardBluetooth init) reads the current value, not a
  // stale snapshot from the first render.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  // Mirror reportWallDisconnect into a ref so the BLE connection-change
  // callback stays identity-stable while still calling the latest action.
  const reportWallDisconnectRef = useRef(reportWallDisconnect);
  reportWallDisconnectRef.current = reportWallDisconnect;

  // Board presence ("now on the wall"). Inert until a board is bound: `boardId`
  // is null, `resolveAndBindBoard` no-ops while no presence client exists, and
  // the safe wall-report no-ops for a null board — so the BLE flow below behaves
  // exactly as today until a serial resolves.
  const {
    boardId: presenceBoardId,
    resolveAndBindBoard,
    reportDisconnect: reportBoardDisconnect,
  } = useBoardPresenceControls();
  const { currentClimb: currentWallClimb, reportClimb: reportWallClimb } = useOptionalWallReport();
  // Live refs so the connect / wall-confirm callbacks stay identity-stable while
  // still reading the latest board / report fn.
  const presenceBoardIdRef = useRef(presenceBoardId);
  presenceBoardIdRef.current = presenceBoardId;
  const resolveAndBindBoardRef = useRef(resolveAndBindBoard);
  resolveAndBindBoardRef.current = resolveAndBindBoard;
  const reportBoardDisconnectRef = useRef(reportBoardDisconnect);
  reportBoardDisconnectRef.current = reportBoardDisconnect;

  // When this client's own BLE link to the wall drops, release both signals,
  // matching mobile's releaseBoardHolder: (1) the session-scoped
  // `reportWallDisconnect` so every member's wall-confirmed lightbulb clears
  // (no-op in solo), and (2) the board-presence holder via `reportDisconnect`
  // so the "who's on the wall" holder doesn't go stale (else the lightbulb's
  // board-presence-holder OR keeps it lit after we've dropped). The `connected`
  // flag is false on an involuntary drop (gattserverdisconnected) AND an
  // explicit user disconnect; both should release.
  const handleConnectionChange = useCallback((connected: boolean) => {
    if (connected) return;
    if (sessionIdRef.current) {
      void reportWallDisconnectRef.current();
    }
    const boardId = presenceBoardIdRef.current;
    if (boardId !== null) {
      void reportBoardDisconnectRef.current(boardId);
    }
  }, []);
  const reportWallClimbRef = useRef(reportWallClimb);
  reportWallClimbRef.current = reportWallClimb;
  const currentWallClimbRef = useRef<BoardPresenceClimb | null>(currentWallClimb);
  currentWallClimbRef.current = currentWallClimb;
  // Accepted reports are deduped by the same rendered payload signature as BLE
  // writes, not just climb uuid. A hold edit or mirror flip under the same uuid
  // needs a fresh report so watchers see the same frames the wall received.
  const lastAcceptedReportSignatureRef = useRef<string | null>(null);
  const pendingReportSignatureRef = useRef<string | null>(null);
  const resetReportDedup = useCallback(() => {
    lastAcceptedReportSignatureRef.current = null;
    pendingReportSignatureRef.current = null;
  }, []);
  useEffect(() => {
    resetReportDedup();
  }, [presenceBoardId, resetReportDedup]);

  // Snapshot the most recently observed lastConnectedBoardSerial so the
  // connect-success callback can compute `previousSerialKnown` for the Phase 5
  // `Session Board Serial Set` event without taking the live session object as
  // a dep (which would re-create the callback on every event).
  const lastConnectedBoardSerialRef = useRef<string | null>(
    persistentSessionState.session?.lastConnectedBoardSerial ?? null,
  );
  useEffect(() => {
    lastConnectedBoardSerialRef.current = persistentSessionState.session?.lastConnectedBoardSerial ?? null;
  }, [persistentSessionState.session?.lastConnectedBoardSerial]);

  const handleConnectSuccess = useCallback(
    (serial: string | null) => {
      resetReportDedup();
      // Resolve+bind the shared board for this serial so the wall feed
      // subscribes. Runs even in solo (the feed is not session-gated). Coexists
      // with the session board-serial write below.
      if (boardDetails) {
        void resolveAndBindBoardRef
          .current({
            serial,
            boardType: boardDetails.board_name,
            layoutId: boardDetails.layout_id,
            sizeId: boardDetails.size_id,
            setIds: boardDetails.set_ids.join(','),
          })
          .catch((error) => {
            resetReportDedup();
            console.warn('[board-presence] failed to resolve board on BLE connect', error);
          });
      }
      if (!serial) return;
      if (!sessionIdRef.current) return;
      const previousSerial = lastConnectedBoardSerialRef.current;
      // Open Q5 defensive clear: every successful pick overwrites whatever
      // the session held — so a stale lastConnectedBoardSerial pointing at a
      // board that has since moved gyms gets replaced as soon as anyone
      // re-pairs against a different board. Skip the WS round-trip when the
      // new serial matches what the session already has (and skip the
      // analytics emit too — same-serial reconnect isn't a state change).
      if (previousSerial === serial) return;
      // Update the ref synchronously so back-to-back reconnects (a quick
      // disconnect → reconnect to the same board before the WS round-trip
      // lands SessionBoardSerialChanged) don't re-fire the mutation. The
      // useEffect above will re-sync once the event arrives — same value,
      // safe no-op.
      lastConnectedBoardSerialRef.current = serial;
      void setSessionBoardSerial(serial);
      // Pivot Phase 5: sanity check that the field gets populated on real
      // sessions. Always 'party' here — the surrounding sessionIdRef gate
      // already excludes solo. `previousSerialKnown` distinguishes the
      // first pairing of a session from a re-pair / board swap.
      track('Session Board Serial Set', {
        mode: 'party',
        previousSerialKnown: previousSerial != null,
        boardLayout: boardDetails?.layout_name ?? '',
        boardId: presenceBoardIdRef.current ?? undefined,
      });
    },
    [setSessionBoardSerial, boardDetails, resetReportDedup],
  );

  const {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    lastSendFailureReasonRef,
    pickerState,
    reconnectSerialForCurrentBoard,
  } = useBoardBluetooth({
    boardDetails: boardDetails ?? undefined,
    boardUuid,
    ledColorOverrides,
    analyticsBoardId: presenceBoardId,
    onConnectSuccess: handleConnectSuccess,
    onConnectionChange: handleConnectionChange,
  });

  // Bumped by reassertWall() to force the auto-sender to re-push the current
  // climb once even when it's byte-identical to the last send.
  const [reassertNonce, setReassertNonce] = useState(0);
  const reassertWall = useCallback(() => setReassertNonce((nonce) => nonce + 1), []);

  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('settings');
  const { t: tSession } = useTranslation('session');
  // Pre-resolve the Undo-snackbar copy here (a statically-analysable `t` call)
  // and mirror it + the snackbar opener into refs, so the wall-confirm callback
  // (which must stay identity-stable for the AutoSender) reads them without
  // listing them as deps.
  const wallChangedText = tSession('boardPresence.wallChanged');
  const undoText = tSession('boardPresence.undo');
  const wallSnackbarCopyRef = useRef({ wallChangedText, undoText });
  wallSnackbarCopyRef.current = { wallChangedText, undoText };
  const showMessageRef = useRef(showMessage);
  showMessageRef.current = showMessage;

  // Always emit on the local wall-confirm bus (so the same phone's drawer
  // dismisses its 2s fallback timer); fire the party WS confirm when a session
  // exists (solo has no peers to notify); and report the lit climb to the
  // board's wall feed so a solo climber's sends feed the wall, with a one-tap
  // Undo of the wall change they just caused.
  const restoreWallClimb = useCallback(
    async (previousClimb: BoardPresenceClimb | null) => {
      resetReportDedup();
      if (!previousClimb || presenceBoardIdRef.current === null || !boardDetails) {
        return;
      }
      try {
        const rawFrames = previousClimb.frames ?? '';
        const firstFrame = getFirstBleFrame(rawFrames, boardDetails.board_name);
        const result = await sendFramesToBoard(firstFrame, false, undefined, previousClimb.climbUuid);
        if (result !== true) {
          resetReportDedup();
          return;
        }
        const restoredClimbInput = presenceClimbToQueueItemInput(previousClimb);
        const accepted = await reportWallClimbRef.current(restoredClimbInput, previousClimb.angle ?? null);
        if (accepted) {
          lastAcceptedReportSignatureRef.current = `${previousClimb.climbUuid}::${rawFrames}::0`;
        } else {
          resetReportDedup();
        }
      } catch (error) {
        resetReportDedup();
        console.warn('[board-presence] failed to restore previous wall climb', error);
      }
    },
    [boardDetails, resetReportDedup, sendFramesToBoard],
  );

  const handleWallConfirmed = useCallback(
    (item: ClimbQueueItem, sendSignature: string) => {
      const climbUuid = item.climb.uuid;
      emitWallConfirm(climbUuid);
      if (sessionIdRef.current) {
        void confirmClimbOnWall(climbUuid);
      }
      // Report to the board-presence channel regardless of session, only on a
      // real change to the wall (skip a deduped re-broadcast of the same climb).
      if (presenceBoardIdRef.current === null) return;
      if (
        lastAcceptedReportSignatureRef.current === sendSignature ||
        pendingReportSignatureRef.current === sendSignature
      ) {
        return;
      }
      const previousWallClimb = currentWallClimbRef.current;
      const boardIdAtReport = presenceBoardIdRef.current;
      pendingReportSignatureRef.current = sendSignature;
      const climbInput = toClimbQueueItemInput(item);
      const angle = item.climb.angle ?? null;
      void reportWallClimbRef
        .current(climbInput, angle)
        .then((accepted) => {
          if (pendingReportSignatureRef.current === sendSignature) {
            pendingReportSignatureRef.current = null;
          }
          if (!accepted) {
            resetReportDedup();
            return;
          }
          lastAcceptedReportSignatureRef.current = sendSignature;
          track(SHARED_EVENTS.BoardClimbReported, {
            boardId: boardIdAtReport,
            climbUuid,
            inSession: sessionIdRef.current != null,
          });
          // Offer a one-tap Undo of the wall change YOU just caused — the
          // deliberate replacement for the dropped pre-send confirm step. The
          // action re-sends the climb that was on the wall before this report,
          // then re-reports it after the BLE write succeeds.
          const { wallChangedText: changedCopy, undoText: undoCopy } = wallSnackbarCopyRef.current;
          showMessageRef.current(
            changedCopy,
            'info',
            { label: undoCopy, onClick: () => void restoreWallClimb(previousWallClimb) },
            8000,
          );
        })
        .catch((error) => {
          if (pendingReportSignatureRef.current === sendSignature) {
            pendingReportSignatureRef.current = null;
          }
          resetReportDedup();
          console.warn('[board-presence] failed to report lit climb', error);
        });
    },
    [confirmClimbOnWall, resetReportDedup, restoreWallClimb],
  );

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
      reassertWall,
      reconnectSerialForCurrentBoard,
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
      reassertWall,
      reconnectSerialForCurrentBoard,
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
      // No board on this route → nothing to match against; the picker can't be
      // open here anyway (connect needs boardDetails), so bail defensively.
      if (!activePickerState || !boardDetails) return;
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
      {isConnected && partyMode === 'off' && boardDetails && (
        <BluetoothAutoSender
          sendFramesToBoard={sendFramesToBoard}
          lastSendFailureReasonRef={lastSendFailureReasonRef}
          layoutName={boardDetails.layout_name ?? ''}
          boardName={boardDetails.board_name}
          boardId={presenceBoardId}
          onWallConfirmed={handleWallConfirmed}
          reassertNonce={reassertNonce}
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

/**
 * Like `useBluetoothContext` but does NOT throw when no provider is mounted: it
 * returns the context's default value, which is `null` (see
 * `createContext<BluetoothContextValue | null>(null)` above). For components
 * (e.g. the create-climb form) that render both inside the app shell (provider
 * present) and in isolated unit tests (no provider). Callers must null-check
 * the result. Mirrors `useOptionalQueueActions`.
 */
export function useOptionalBluetoothContext(): BluetoothContextValue | null {
  return useContext(BluetoothContext);
}

export { BluetoothContext };
