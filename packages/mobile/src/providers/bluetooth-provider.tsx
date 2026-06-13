import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { formatBoardDisplayName, toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useBoardPresenceCurrent } from '@boardsesh/board-presence-react';
import type { BoardPresenceClimb, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { emitWallConfirm } from '@boardsesh/play-view';
import { useBoardBluetooth, boardConfigKey } from '../lib/ble/use-board-bluetooth';
import { useResolvedBleDeviceBoards } from '../lib/ble/resolve-serials';
import {
  decideBlePickerSelection,
  type BleBoardConfig,
  type PickerSelectionDecision,
} from '../lib/ble/board-config-match';
import { summarizePickerResolution, type PickerResolutionStats } from '../lib/ble/picker-resolution-stats';
import { useSetActiveBoard } from '../lib/graphql/use-active-board';
import { getHttpClient } from '../lib/graphql/client';
import { GET_BOARD } from '../lib/graphql/operations';
import type { GetBoardQueryResponse } from '../lib/graphql/operations';
import { getBoardRenderData } from '../lib/board-details';
import { registerBluetoothConnection } from '../lib/ble/bluetooth-status-store';
import { deriveIsWallWriter } from '@boardsesh/queue-runtime';
import { useIsPartyPreviewOnly, useQueue, useQueueSessionControls } from './queue-provider';
import { useBoardPresenceControls } from './board-presence-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';
import { toClimbInput } from '../lib/climb-to-queue-item';
import { hapticSuccess } from '../lib/haptics';
import { DevicePickerSheet } from '../components/ble/DevicePickerSheet';
import { track } from '../lib/analytics';
import { getBluetoothColorOverrides, useHoldColorOverrides } from '../lib/hold-color-overrides';

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
   * Restore the climb captured before this device's latest accepted wall report.
   * The platform relights it over BLE first, then reports it to board presence.
   */
  undoWallChange: () => Promise<boolean>;
  /**
   * Show the undo affordance for the next accepted wall report only. UI control
   * surfaces call this immediately before a deliberate control-gain action.
   */
  armUndoWallChangeToast: () => void;
  /**
   * Serial to silently reconnect to for the board currently in view, or null
   * when nothing is remembered or the user switched boards — in which case
   * callers open the device picker instead.
   */
  reconnectSerialForCurrentBoard: string | null;
};

const BluetoothContext = createContext<BluetoothContextValue | null>(null);
const EMPTY_PICKER_DEVICES: [] = [];
// How long a switch-to-config auto-connect request stays armed waiting for the
// switched board's props to reach this provider before it is dropped.
const PENDING_AUTO_CONNECT_TTL_MS = 15_000;
const UNDO_WALL_CHANGE_TOAST_ARM_TTL_MS = 10_000;

function formatPickerBoardConfig(t: TFunction<'settings'>, config: BleBoardConfig): string {
  return t('boardConfigMismatch.mobileConfigValue', {
    board: formatBoardDisplayName(config.boardName),
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds,
  });
}

type PendingWallReport = {
  item: ClimbQueueItem;
  undoTarget: BoardPresenceClimb | null;
  undoToastArmId: number | null;
};

function queueItemReportSignature(item: ClimbQueueItem): string {
  return `${item.climb.uuid}:${item.climb.frames}:${item.climb.angle ?? ''}`;
}

function presenceClimbReportSignature(climb: BoardPresenceClimb | null): string | null {
  if (!climb) return null;
  return `${climb.climbUuid}:${climb.frames ?? ''}:${climb.angle ?? ''}`;
}

function presenceClimbToQueueInput(climb: BoardPresenceClimb): ClimbQueueItemInput {
  return {
    uuid: climb.queueItemUuid ?? `undo:${climb.climbUuid}:${climb.seq}`,
    climb: {
      uuid: climb.climbUuid,
      setter_username: climb.setter ?? '',
      name: climb.name ?? '',
      frames: climb.frames ?? '',
      angle: climb.angle ?? 0,
      ascensionist_count: 0,
      difficulty: climb.grade ?? '',
      quality_average: '',
      stars: 0,
      difficulty_error: '',
    },
  };
}

/**
 * Isolated child component that subscribes to the queue's currentClimbQueueItem
 * and auto-sends climb data over BLE. Only mounted when isConnected is true so
 * the BluetoothProvider itself never subscribes to the climb context, preventing
 * re-renders of the entire component tree on every climb change when BT is
 * disconnected.
 *
 * Uses a latest-wins drain loop for writes:
 * - `isWritingRef` tracks if a write is in progress
 * - `pendingSendRef` stores the most recent pending climb plus colour state
 * - When a new climb or colour state arrives during a write, it replaces the pending send
 * - When the current write completes, the drain loop picks up whatever's pending
 * - Deduplicates byte-identical broadcasts via `lastSentSignatureRef` (keyed on
 *   uuid + frames + mirror + color signature, so a mirror toggle, hold edit, or
 *   colour override change on the same climb re-pushes), and a `reassertNonce`
 *   bump punches through the dedup once.
 */
function BluetoothAutoSender({
  sendFramesToBoard,
  onWallConfirmed,
  reassertNonce,
  connectInitialSendRef,
  colorSignature,
}: {
  sendFramesToBoard: (frames: string, mirrored?: boolean, signal?: AbortSignal) => Promise<boolean | undefined>;
  /**
   * Fired once a climb is on the wall (a fresh write or a deduped re-broadcast).
   * Receives the full lit queue item so consumers can both emit the local
   * confirm (uuid only) and report the climb to the board-presence channel.
   */
  onWallConfirmed: (item: ClimbQueueItem) => void;
  reassertNonce: number;
  // One-shot seed: what connect() already wrote as initialFrames, so the
  // freshly mounted AutoSender doesn't repeat a byte-identical first send.
  connectInitialSendRef: React.MutableRefObject<{ frames: string; mirrored: boolean; colorSignature: string } | null>;
  colorSignature: string;
}) {
  type AutoSendRequest = {
    item: ClimbQueueItem;
    sendFramesToBoard: (frames: string, mirrored?: boolean, signal?: AbortSignal) => Promise<boolean | undefined>;
    colorSignature: string;
  };

  const { state } = useQueue();
  const { currentClimbQueueItem } = state;
  const onWallConfirmedRef = useRef(onWallConfirmed);
  useEffect(() => {
    onWallConfirmedRef.current = onWallConfirmed;
  }, [onWallConfirmed]);

  const isWritingRef = useRef(false);
  const pendingSendRef = useRef<AutoSendRequest | null>(null);
  // The signature of the last climb actually pushed to the wall: uuid + rendered
  // frames + mirror state + colour override state. Re-broadcasts with the same
  // signature skip the physical write (the board is idempotent, but we'd
  // double-fire haptics); changing any piece re-pushes.
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

    const sendRequest: AutoSendRequest = {
      item: currentClimbQueueItem,
      sendFramesToBoard,
      colorSignature,
    };

    if (isWritingRef.current) {
      pendingSendRef.current = sendRequest;
      return;
    }

    isWritingRef.current = true;

    const drain = async () => {
      let toSend: AutoSendRequest | null = sendRequest;
      try {
        while (toSend) {
          if (signal?.aborted) return;
          const { item, sendFramesToBoard: requestSendFramesToBoard, colorSignature: requestColorSignature } = toSend;

          // connect() may have just written these exact frames as its
          // initialFrames (connect-and-light flows like the play drawer).
          // Seed the dedup signature so this freshly mounted AutoSender
          // doesn't immediately repeat the byte-identical write and
          // double-fire the success haptic. One-shot — and a pending
          // reassert below still wins and forces a re-push.
          const connectSend = connectInitialSendRef.current;
          if (connectSend) {
            connectInitialSendRef.current = null;
            if (
              lastSentSignatureRef.current === null &&
              connectSend.frames === item.climb.frames &&
              connectSend.mirrored === !!item.climb.mirrored &&
              connectSend.colorSignature === requestColorSignature
            ) {
              lastSentSignatureRef.current = `${item.climb.uuid}::${item.climb.frames}::${item.climb.mirrored ? 1 : 0}::${requestColorSignature}`;
            }
          }

          // Honour a pending reassert exactly when the climb is picked up —
          // clearing the signature here (rather than in the effect) survives an
          // in-flight write that re-set it on completion.
          if (reassertPendingRef.current) {
            reassertPendingRef.current = false;
            lastSentSignatureRef.current = null;
          }

          // Deduplicate byte-identical re-broadcasts (same climb, frames,
          // mirror, and colours). The board is idempotent so a re-send is
          // functionally fine, but we'd double-fire haptics. A mirror toggle,
          // hold edit, or colour change updates the signature and re-pushes.
          const sendSignature = `${item.climb.uuid}::${item.climb.frames}::${item.climb.mirrored ? 1 : 0}::${requestColorSignature}`;
          if (sendSignature === lastSentSignatureRef.current) {
            onWallConfirmedRef.current(item);
            toSend = pendingSendRef.current;
            pendingSendRef.current = null;
            continue;
          }

          try {
            const result = await requestSendFramesToBoard(item.climb.frames, !!item.climb.mirrored, signal);

            // After the await, the AutoSender may have unmounted — skip
            // post-send side effects.
            if (signal?.aborted) return;

            if (result === true) {
              lastSentSignatureRef.current = sendSignature;
              onWallConfirmedRef.current(item);
              hapticSuccess();
            }
          } catch (error) {
            if (signal?.aborted) return;
            console.error('Error sending climb to board:', error);
          }

          toSend = pendingSendRef.current;
          pendingSendRef.current = null;
        }
      } finally {
        isWritingRef.current = false;
      }
    };

    void drain();
  }, [currentClimbQueueItem, sendFramesToBoard, reassertNonce, colorSignature]);

  return null;
}

type BluetoothProviderProps = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  boardUuid?: string;
  children: React.ReactNode;
};

export function BluetoothProvider({
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardUuid,
  children,
}: BluetoothProviderProps) {
  const {
    sessionId,
    participantId,
    confirmClimbOnWall,
    setSessionBoardSerial,
    lastConnectedBoardSerial,
    announceWallLink,
    revokeWallLink,
    wallConnectionsByBoard,
  } = useQueueSessionControls();
  const isPartyPreviewOnly = useIsPartyPreviewOnly();
  const { t } = useTranslation('settings');
  // Board presence ("now on the wall"). All of these are inert when the
  // `board-presence` flag is off: `enabled` is false, `boardId` is null, and the
  // shared wall context's report/undo no-op for a null board — so the BLE flow
  // below behaves exactly as today.
  const {
    enabled: presenceEnabled,
    boardId: presenceBoardId,
    resolveAndBindBoard,
    resolveAndBindBoardByConfig,
    reportClimbForBoard,
  } = useBoardPresenceControls();

  // The BLE connection is the writer token: the member holding the connection to
  // this board is the single frame writer. deriveIsWallWriter falls back to
  // "writer" when solo, no board is resolved, or nobody holds the slot — so this
  // only suppresses writes when a confirmed OTHER member holds the connection.
  // Belt-and-suspenders with isPartyPreviewOnly while the driver model coexists.
  const isWallWriter = deriveIsWallWriter({
    isPersistentSessionActive: sessionId !== null,
    participantId,
    wallConnectionsByBoard,
    boardId: presenceBoardId,
  });
  // The board this phone announced a wall link for, so disconnect can revoke it
  // (the backend only frees the slot on session-leave, not on BLE drop).
  const announcedWallBoardIdRef = useRef<number | null>(null);
  const { currentClimb: wallCurrentClimb } = useBoardPresenceCurrent();
  const { showUndoWallChangeSnackbar } = useQueueSnackbar();
  const { overrides: holdColorOverrides, signature: holdColorSignature } = useHoldColorOverrides();
  const bluetoothColorOverrides = useMemo(
    () => getBluetoothColorOverrides(holdColorOverrides),
    // Marker-only accessibility edits must not churn the BLE sender.
    // The color signature is the complete BLE-visible override identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdColorSignature],
  );

  // Mirror the board config props so the empty-dep-ish connect callback resolves
  // the serial against the board currently in view without churning identity.
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;
  const layoutIdRef = useRef(layoutId);
  layoutIdRef.current = layoutId;
  const sizeIdRef = useRef(sizeId);
  sizeIdRef.current = sizeId;
  const setIdsRef = useRef(setIds);
  setIdsRef.current = setIds;
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const lastConnectedBoardSerialRef = useRef(lastConnectedBoardSerial);
  useEffect(() => {
    lastConnectedBoardSerialRef.current = lastConnectedBoardSerial;
  }, [lastConnectedBoardSerial]);

  // Live refs so handleWallConfirmed stays identity-stable while still reading
  // the latest flag/board/report fn (it's mirrored into the AutoSender via a ref).
  const presenceEnabledRef = useRef(presenceEnabled);
  presenceEnabledRef.current = presenceEnabled;
  const presenceBoardIdRef = useRef(presenceBoardId);
  presenceBoardIdRef.current = presenceBoardId;
  const reportClimbForBoardRef = useRef(reportClimbForBoard);
  reportClimbForBoardRef.current = reportClimbForBoard;
  const wallCurrentClimbRef = useRef<BoardPresenceClimb | null>(wallCurrentClimb);
  wallCurrentClimbRef.current = wallCurrentClimb;
  const showUndoWallChangeSnackbarRef = useRef(showUndoWallChangeSnackbar);
  showUndoWallChangeSnackbarRef.current = showUndoWallChangeSnackbar;
  // Last accepted report signature. Set only after the server accepts a report,
  // and only used to skip a byte-identical local re-broadcast while the feed
  // still shows that same signature.
  const lastAcceptedReportSignatureRef = useRef<string | null>(null);
  const lastAcceptedWallSignatureRef = useRef<string | null>(null);
  const pendingReportSignatureRef = useRef<string | null>(null);
  const pendingWallReportRef = useRef<PendingWallReport | null>(null);
  const pendingPresenceResolveRef = useRef(false);
  const resolvedPresenceBoardIdRef = useRef<number | null>(presenceBoardId);
  const undoWallChangeTargetRef = useRef<BoardPresenceClimb | null>(null);
  const previousPresenceBoardIdRef = useRef<number | null>(presenceBoardId);
  const boardConfigIdentity = `${boardName ?? ''}:${layoutId ?? ''}:${sizeId ?? ''}:${setIds ?? ''}`;
  const previousBoardConfigIdentityRef = useRef(boardConfigIdentity);
  const undoWallChangeToastArmIdRef = useRef<number | null>(null);
  const nextUndoWallChangeToastArmIdRef = useRef(0);
  const undoWallChangeToastArmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndoWallChangeToastArm = useCallback(() => {
    undoWallChangeToastArmIdRef.current = null;
    if (undoWallChangeToastArmTimeoutRef.current) {
      clearTimeout(undoWallChangeToastArmTimeoutRef.current);
      undoWallChangeToastArmTimeoutRef.current = null;
    }
  }, []);

  const armUndoWallChangeToast = useCallback(() => {
    clearUndoWallChangeToastArm();
    const armId = nextUndoWallChangeToastArmIdRef.current + 1;
    nextUndoWallChangeToastArmIdRef.current = armId;
    undoWallChangeToastArmIdRef.current = armId;
    undoWallChangeToastArmTimeoutRef.current = setTimeout(() => {
      undoWallChangeToastArmIdRef.current = null;
      undoWallChangeToastArmTimeoutRef.current = null;
    }, UNDO_WALL_CHANGE_TOAST_ARM_TTL_MS);
  }, [clearUndoWallChangeToastArm]);

  const getUndoWallChangeToastArmId = useCallback(() => undoWallChangeToastArmIdRef.current, []);

  const consumeUndoWallChangeToastArm = useCallback(
    (armId: number | null) => {
      if (armId === null || undoWallChangeToastArmIdRef.current !== armId) {
        return false;
      }
      clearUndoWallChangeToastArm();
      return true;
    },
    [clearUndoWallChangeToastArm],
  );

  const clearPendingWallReportAndUndoToastArm = useCallback(() => {
    pendingWallReportRef.current = null;
    clearUndoWallChangeToastArm();
  }, [clearUndoWallChangeToastArm]);

  // Cleanup-only effect: drop any one-shot arm timer when the provider unmounts.
  useEffect(() => clearUndoWallChangeToastArm, [clearUndoWallChangeToastArm]);

  useEffect(() => {
    const previousBoardConfigIdentity = previousBoardConfigIdentityRef.current;
    previousBoardConfigIdentityRef.current = boardConfigIdentity;
    if (previousBoardConfigIdentity !== boardConfigIdentity) {
      clearPendingWallReportAndUndoToastArm();
    }
  }, [boardConfigIdentity, clearPendingWallReportAndUndoToastArm]);

  useEffect(() => {
    if (presenceBoardId !== null) {
      resolvedPresenceBoardIdRef.current = presenceBoardId;
    } else if (!pendingPresenceResolveRef.current) {
      resolvedPresenceBoardIdRef.current = null;
    }
  }, [presenceBoardId]);

  useEffect(() => {
    const currentWallSignature = presenceClimbReportSignature(wallCurrentClimb);
    if (
      lastAcceptedReportSignatureRef.current !== null &&
      currentWallSignature !== null &&
      currentWallSignature !== lastAcceptedReportSignatureRef.current &&
      currentWallSignature !== lastAcceptedWallSignatureRef.current
    ) {
      lastAcceptedReportSignatureRef.current = null;
      lastAcceptedWallSignatureRef.current = null;
    }
  }, [wallCurrentClimb]);

  useEffect(() => {
    const previousBoardId = previousPresenceBoardIdRef.current;
    previousPresenceBoardIdRef.current = presenceBoardId;
    if (previousBoardId === presenceBoardId) {
      return;
    }
    if (previousBoardId !== null || presenceBoardId === null) {
      lastAcceptedReportSignatureRef.current = null;
      lastAcceptedWallSignatureRef.current = null;
      pendingReportSignatureRef.current = null;
      undoWallChangeTargetRef.current = null;
      clearPendingWallReportAndUndoToastArm();
    }
  }, [clearPendingWallReportAndUndoToastArm, presenceBoardId]);

  const reportWallClimb = useCallback(
    async (
      item: ClimbQueueItem,
      boardId: number,
      undoTarget: BoardPresenceClimb | null,
      undoToastArmId: number | null,
    ) => {
      const reportSignature = queueItemReportSignature(item);
      if (lastAcceptedReportSignatureRef.current === reportSignature) {
        const currentWallSignature = presenceClimbReportSignature(wallCurrentClimbRef.current);
        if (
          currentWallSignature === null ||
          currentWallSignature === reportSignature ||
          currentWallSignature === lastAcceptedWallSignatureRef.current
        ) {
          consumeUndoWallChangeToastArm(undoToastArmId);
          return true;
        }
        lastAcceptedReportSignatureRef.current = null;
        lastAcceptedWallSignatureRef.current = null;
      }
      if (pendingReportSignatureRef.current === reportSignature) {
        return true;
      }

      const climbInput = { uuid: item.uuid, climb: toClimbInput(item.climb) };
      const angle = item.climb.angle ?? null;
      pendingReportSignatureRef.current = reportSignature;
      const accepted = await reportClimbForBoardRef.current(boardId, climbInput, angle).catch((error: unknown) => {
        console.warn('[board-presence] reportBoardClimb failed', error);
        return false;
      });
      if (pendingReportSignatureRef.current === reportSignature) {
        pendingReportSignatureRef.current = null;
      }

      if (!accepted) {
        lastAcceptedReportSignatureRef.current = null;
        return false;
      }

      lastAcceptedReportSignatureRef.current = reportSignature;
      lastAcceptedWallSignatureRef.current = presenceClimbReportSignature(wallCurrentClimbRef.current);
      undoWallChangeTargetRef.current = undoTarget;
      const showUndoToast = consumeUndoWallChangeToastArm(undoToastArmId);
      track(SHARED_EVENTS.BoardClimbReported, {
        boardId,
        climbUuid: item.climb.uuid,
        inSession: sessionIdRef.current != null,
      });
      if (showUndoToast && undoTarget?.frames) {
        showUndoWallChangeSnackbarRef.current();
      }
      return true;
    },
    [consumeUndoWallChangeToastArm],
  );

  const replayPendingWallReport = useCallback(
    (boardId: number) => {
      const pendingReport = pendingWallReportRef.current;
      if (!pendingReport) return;
      pendingWallReportRef.current = null;
      void reportWallClimb(pendingReport.item, boardId, pendingReport.undoTarget, pendingReport.undoToastArmId);
    },
    [reportWallClimb],
  );

  const handleWallConfirmed = useCallback(
    (item: ClimbQueueItem) => {
      emitWallConfirm(item.climb.uuid);
      if (sessionIdRef.current) {
        void confirmClimbOnWall(item.climb.uuid);
      }
      // Report the lit climb to the board-presence channel regardless of
      // session. Dedup is feed/signature-aware and only arms after an accepted
      // report, so failed reports and two-phone relights can retry.
      if (!presenceEnabledRef.current) return;
      const boardId = pendingPresenceResolveRef.current
        ? null
        : (presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current);
      const undoTarget = wallCurrentClimbRef.current;
      const undoToastArmId = getUndoWallChangeToastArmId();
      if (boardId === null) {
        if (pendingPresenceResolveRef.current) {
          pendingWallReportRef.current = { item, undoTarget, undoToastArmId };
        } else {
          consumeUndoWallChangeToastArm(undoToastArmId);
        }
        return;
      }
      void reportWallClimb(item, boardId, undoTarget, undoToastArmId);
    },
    [confirmClimbOnWall, consumeUndoWallChangeToastArm, getUndoWallChangeToastArmId, reportWallClimb],
  );

  const handleConnectSuccess = useCallback(
    (serial: string | null) => {
      lastAcceptedReportSignatureRef.current = null;
      lastAcceptedWallSignatureRef.current = null;
      pendingReportSignatureRef.current = null;
      pendingWallReportRef.current = null;
      undoWallChangeTargetRef.current = null;
      resolvedPresenceBoardIdRef.current = null;

      const boardType = boardNameRef.current;
      const layoutId = layoutIdRef.current;
      const sizeId = sizeIdRef.current;
      const setIds = setIdsRef.current ?? '';

      // Resolve+bind the shared board so the wall feed subscribes. Aurora uses
      // its controller serial; serial-less boards use the per-config fallback
      // when the backend supports it. This is independent of party sessions.
      if (presenceEnabledRef.current && boardType && layoutId != null && layoutId > 0 && sizeId != null && sizeId > 0) {
        pendingPresenceResolveRef.current = true;
        const resolvePromise =
          serial && serial.length > 0
            ? resolveAndBindBoard({ serial, boardType, layoutId, sizeId, setIds })
            : resolveAndBindBoardByConfig({ boardType, layoutId, sizeId, setIds });
        void resolvePromise
          .then((resolved) => {
            if (!resolved) return;
            resolvedPresenceBoardIdRef.current = resolved.boardId;
            replayPendingWallReport(resolved.boardId);
            // Claim the wall-connection slot so this phone is the board's sole
            // frame writer for the session (no-op solo). The backend gates the
            // claim on session membership.
            if (sessionIdRef.current) {
              announcedWallBoardIdRef.current = resolved.boardId;
              void announceWallLink(resolved.boardId);
            }
          })
          .catch((error: unknown) => {
            console.warn('[board-presence] board resolve failed', error);
          })
          .finally(() => {
            pendingPresenceResolveRef.current = false;
          });
      }

      if (!serial || !sessionIdRef.current) return;
      const previousSerial = lastConnectedBoardSerialRef.current;
      if (previousSerial === serial) return;
      lastConnectedBoardSerialRef.current = serial;
      void setSessionBoardSerial(serial);
      track('Session Board Serial Set', {
        mode: 'party',
        previousSerialKnown: previousSerial != null,
        boardLayout: boardName ?? '',
        boardId: resolvedPresenceBoardIdRef.current ?? presenceBoardIdRef.current ?? undefined,
      });
    },
    [
      boardName,
      setSessionBoardSerial,
      resolveAndBindBoard,
      resolveAndBindBoardByConfig,
      replayPendingWallReport,
      announceWallLink,
    ],
  );

  // Hold placements for the active board, required by the hook's
  // mirrored-frames conversion (hold id → mirroredHoldId). Without this every
  // `mirrored: true` send silently wrote the unmirrored frames to the wall.
  // getBoardRenderData is pure + memoised by board-config key, so this is a
  // cache lookup on re-render.
  const holdsData = useMemo(() => {
    if (!boardName || layoutId === undefined || sizeId === undefined || !setIds) return undefined;
    const parsedSetIds = setIds
      .split(',')
      .map((setId) => Number(setId.trim()))
      // `Number('')` is 0, so a trailing comma would smuggle a bogus set ID 0
      // into the render-data lookup — real set IDs are positive. Keep in
      // lockstep with DeviceCard's parseSetIds.
      .filter((setId) => Number.isInteger(setId) && setId > 0);
    if (parsedSetIds.length === 0) return undefined;
    return (
      getBoardRenderData({ boardName: boardName as BoardName, layoutId, sizeId, setIds: parsedSetIds })?.holdsData ??
      undefined
    );
  }, [boardName, layoutId, sizeId, setIds]);

  const {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    pickerState,
    reconnectSerialForCurrentBoard,
    connectInitialSendRef,
  } = useBoardBluetooth({
    boardName,
    layoutId,
    sizeId,
    setIds,
    boardUuid,
    holdsData,
    analyticsBoardId: presenceBoardId,
    ledColorOverrides: bluetoothColorOverrides,
    onConnectSuccess: handleConnectSuccess,
  });

  const resolvedPickerBoards = useResolvedBleDeviceBoards(pickerState?.devices ?? EMPTY_PICKER_DEVICES);
  const currentBoardConfig = useMemo(() => {
    if (!boardName || layoutId === undefined || sizeId === undefined || !setIds) return undefined;
    const typedBoardName = toBoardName(boardName);
    if (!typedBoardName) return undefined;
    return {
      boardName: typedBoardName,
      layoutId,
      sizeId,
      setIds,
    };
  }, [boardName, layoutId, sizeId, setIds]);

  // handlePickerSelect, handleMismatchSwitch and the auto-connect effect all
  // need the latest pickerState / resolvedPickerBoards / currentBoardConfig, but
  // pickerState is a fresh object on every scan-progress push. Listing it in a
  // useCallback dep array would churn the onSelect identity each push and defeat
  // DeviceCard's React.memo. Mirror the volatile inputs into refs and read
  // through them — latest-value semantics are exactly right for a tap handler,
  // so keep these handlers free of stale-closure-sensitive logic.
  const pickerStateRef = useRef(pickerState);
  pickerStateRef.current = pickerState;
  const resolvedPickerBoardsRef = useRef(resolvedPickerBoards);
  resolvedPickerBoardsRef.current = resolvedPickerBoards;
  const currentBoardConfigRef = useRef(currentBoardConfig);
  currentBoardConfigRef.current = currentBoardConfig;

  // Track how often the picker's serial→board resolution actually pays off:
  // keep the tallies fresh while the sheet is open (devices and resolutions
  // both stream in), then flush ONE summary event when it closes — per-device
  // or per-render events would massively overcount repeat advertisements.
  const pickerResolutionStatsRef = useRef<PickerResolutionStats | null>(null);
  useEffect(() => {
    if (pickerState) {
      pickerResolutionStatsRef.current = summarizePickerResolution(
        pickerState.devices,
        resolvedPickerBoards,
        currentBoardConfig,
      );
      return;
    }
    const finalStats = pickerResolutionStatsRef.current;
    if (!finalStats) return;
    pickerResolutionStatsRef.current = null;
    track(SHARED_EVENTS.BlePickerDevicesResolved, { ...finalStats, boardName });
  }, [pickerState, resolvedPickerBoards, currentBoardConfig, boardName]);

  const setActiveBoard = useSetActiveBoard();

  // One-shot request to silently reconnect to `serial` once the active board
  // config has actually switched to `configKey`. Set by the switch flow, cleared
  // by the effect below the moment it fires the reconnect. A single slot is
  // deliberate (last writer wins): each successful switch cancels the picker
  // that produced it, so a second request can only come from a newer flow whose
  // intent supersedes the first.
  const [pendingAutoConnect, setPendingAutoConnect] = useState<{
    serial: string;
    configKey: string;
    armUndoToast: boolean;
  } | null>(null);

  // The switched config normally propagates within one re-render, so a request
  // still pending after this window means it can no longer complete (e.g. the
  // board switch was reverted before the props arrived). Drop it rather than
  // leave a stale one-shot armed that would fire on a much-later, unrelated
  // switch to the same config.
  //
  // Depend on the configKey rather than the whole `pendingAutoConnect` object so
  // re-arming with the same configKey (a race) doesn't reset the timer and
  // silently extend the TTL. Reading it into a local also keeps the dep array
  // exhaustive — configKey is always a string on a live request (never null
  // while the object is set), so the falsy guard only short-circuits the cleared
  // (null) state.
  const pendingConfigKey = pendingAutoConnect?.configKey;
  useEffect(() => {
    if (!pendingConfigKey) return;
    const expiryTimeoutId = setTimeout(() => setPendingAutoConnect(null), PENDING_AUTO_CONNECT_TTL_MS);
    return () => clearTimeout(expiryTimeoutId);
  }, [pendingConfigKey]);

  useEffect(() => {
    if (!pendingAutoConnect) return;
    // Still on the old config — setActiveBoard's cache write hasn't propagated
    // new board props into this provider yet. Wait for the matching config so we
    // don't auto-connect against the LED placement map we're switching away from.
    if (!boardName || layoutId === undefined || sizeId === undefined) return;
    if (boardConfigKey(boardName, layoutId, sizeId) !== pendingAutoConnect.configKey) return;
    // The old cancelled connect may still be settling. connect() bails while
    // connectInFlightRef is set (which tracks `loading`), so a new connect fired
    // now would be silently swallowed — wait for it to clear first.
    if (loading) return;
    const { serial, armUndoToast } = pendingAutoConnect;
    setPendingAutoConnect(null);
    if (armUndoToast) {
      armUndoWallChangeToast();
    }
    // connect's third param does a silent serial auto-select, falling back to the
    // picker only if that serial never advertises.
    void connect(undefined, undefined, serial);
  }, [pendingAutoConnect, boardName, layoutId, sizeId, loading, armUndoWallChangeToast, connect]);

  const handleMismatchSwitch = useCallback(
    async (decision: Extract<PickerSelectionDecision, { kind: 'mismatch' }>) => {
      const armUndoToastAfterSwitch = undoWallChangeToastArmIdRef.current !== null;
      try {
        let board: UserBoard;
        if (decision.entry.kind === 'saved') {
          board = decision.entry.board;
        } else {
          const { boardUuid: recordedBoardUuid } = decision.entry.config;
          if (!recordedBoardUuid) {
            throw new Error('Recorded board config has no saved board to switch to');
          }
          const response = await getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, {
            boardUuid: recordedBoardUuid,
          });
          if (!response.board) {
            throw new Error(`No board found for uuid ${recordedBoardUuid}`);
          }
          board = response.board;
        }
        await setActiveBoard(board);
        // Only cancel the picker once the switch actually went through: a failed
        // board fetch above leaves the picker open so the user can still pick a
        // device or use Connect anyway. The cancel rejects the old connect's
        // picker promise with the silent user-cancel signature (no "connection
        // failed" alert), which clears `loading` and lets the auto-connect
        // effect fire against the switched config.
        pickerStateRef.current?.handleCancel();
        setPendingAutoConnect({
          serial: decision.serial,
          configKey: boardConfigKey(decision.config.boardName, decision.config.layoutId, decision.config.sizeId),
          armUndoToast: armUndoToastAfterSwitch,
        });
      } catch (error) {
        console.error('Failed to switch to correct board config:', error);
        Alert.alert(t('boardConfigMismatch.title'), t('boardConfigMismatch.mobileSwitchFailed'));
      }
    },
    [setActiveBoard, t],
  );

  const handlePickerSelect = useCallback(
    (deviceId: string) => {
      const activePickerState = pickerStateRef.current;
      if (!activePickerState) return;
      const activeBoardConfig = currentBoardConfigRef.current;
      const decision = decideBlePickerSelection({
        deviceId,
        devices: activePickerState.devices,
        resolvedBoards: resolvedPickerBoardsRef.current,
        currentBoardConfig: activeBoardConfig,
      });
      if (decision.kind === 'forward') {
        activePickerState.handleSelect(deviceId);
        return;
      }

      const currentLabel = activeBoardConfig
        ? formatPickerBoardConfig(t, activeBoardConfig)
        : t('boardConfigMismatch.mobileUnknownConfig');
      const recordedLabel = formatPickerBoardConfig(t, decision.config);
      const canSwitch =
        decision.entry.kind === 'saved' ||
        (decision.entry.kind === 'recorded' && decision.entry.config.boardUuid != null);
      const buttons = [
        { text: t('boardConfigMismatch.cancel'), style: 'cancel' as const },
        {
          text: t('boardConfigMismatch.connectAnyway'),
          style: 'destructive' as const,
          onPress: () => activePickerState.handleSelect(deviceId),
        },
        ...(canSwitch
          ? [
              {
                text: t('boardConfigMismatch.switchToCorrect'),
                onPress: () => void handleMismatchSwitch(decision),
              },
            ]
          : []),
      ];
      Alert.alert(
        t('boardConfigMismatch.title'),
        [
          t('boardConfigMismatch.intro'),
          t('boardConfigMismatch.mobileCurrentLabel', { config: currentLabel }),
          t('boardConfigMismatch.mobileRecordedLabel', { config: recordedLabel }),
        ].join('\n\n'),
        buttons,
      );
    },
    [handleMismatchSwitch, t],
  );

  const undoWallChange = useCallback(async (): Promise<boolean> => {
    const undoTarget = undoWallChangeTargetRef.current;
    const boardId = presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current;
    const frames = undoTarget?.frames;
    if (!presenceEnabledRef.current || !undoTarget || !frames || boardId === null) {
      return false;
    }

    lastAcceptedReportSignatureRef.current = null;
    const writeSucceeded = await sendFramesToBoard(frames, false).catch((error: unknown) => {
      console.warn('[board-presence] undo BLE resend failed', error);
      return false;
    });
    if (writeSucceeded !== true) {
      return false;
    }

    const accepted = await reportClimbForBoardRef
      .current(boardId, presenceClimbToQueueInput(undoTarget), undoTarget.angle ?? null)
      .catch((error: unknown) => {
        console.warn('[board-presence] undo report failed', error);
        return false;
      });
    if (!accepted) {
      return false;
    }

    lastAcceptedReportSignatureRef.current = presenceClimbReportSignature(undoTarget);
    undoWallChangeTargetRef.current = null;
    track(SHARED_EVENTS.BoardClimbReported, {
      boardId,
      climbUuid: undoTarget.climbUuid,
      inSession: sessionIdRef.current != null,
    });
    return true;
  }, [sendFramesToBoard]);

  const clearBoard = useCallback(() => sendFramesToBoard(''), [sendFramesToBoard]);

  // Bumped by `reassertWall()` to force the auto-sender to re-push the current
  // climb once, bypassing the byte-identical dedup.
  const [reassertNonce, setReassertNonce] = useState(0);
  const reassertWall = useCallback(() => setReassertNonce((nonce) => nonce + 1), []);

  // Detect an unexpected drop (connected → disconnected without a user-initiated
  // disconnect) for telemetry only. `isUserDisconnectRef` suppresses deliberate ones.
  const wasConnectedRef = useRef(false);
  const isUserDisconnectRef = useRef(false);

  // Wrap disconnect to track user-initiated disconnects
  const wrappedDisconnect = useCallback(async () => {
    clearPendingWallReportAndUndoToastArm();
    const heldBoardId = announcedWallBoardIdRef.current;
    if (heldBoardId !== null) {
      announcedWallBoardIdRef.current = null;
      void revokeWallLink(heldBoardId);
    }
    isUserDisconnectRef.current = true;
    track(SHARED_EVENTS.BluetoothDisconnected, { boardName, reason: 'user', inSession: sessionIdRef.current != null });
    try {
      await disconnect();
    } catch {
      // The native iOS adapter's disconnect() can reject (e.g. peripheral
      // already torn down). Callers `void` this promise, so an unhandled
      // rejection would surface as error-reporting noise. Connection state is
      // cleared before the await, so the disconnect is effectively done either way —
      // safe to swallow, matching the keep-awake `.catch(() => {})` pattern.
    } finally {
      isUserDisconnectRef.current = false;
    }
  }, [clearPendingWallReportAndUndoToastArm, disconnect, boardName, revokeWallLink]);

  // Register with the module-level status store so consumers rendered outside
  // this provider (e.g. the root tab bar, the long-press BLE controls sheet) can
  // observe BT connection state and force a disconnect. Register the instrumented
  // `wrappedDisconnect` so a force-disconnect is still tracked as user-initiated
  // (not mis-tagged as an unexpected drop). The store expects () => void.
  useEffect(() => {
    if (!isConnected) return;
    const release = registerBluetoothConnection(() => {
      void wrappedDisconnect();
    });
    return release;
  }, [isConnected, wrappedDisconnect]);

  // Losing the BLE link is expected (RF noise, or another climber grabbing the
  // last-connection-wins board), so an unexpected drop just lets the lightbulb go
  // unlit (driven by isConnected) — we never auto-reconnect, buzz an error, or pop
  // the device picker. Reconnecting stays a deliberate lightbulb tap. Recorded so
  // drop frequency stays visible in analytics.
  useEffect(() => {
    if (wasConnectedRef.current && !isConnected && !isUserDisconnectRef.current) {
      clearPendingWallReportAndUndoToastArm();
      // Free the wall-connection slot on an unexpected drop too, so a peer can
      // become the writer instead of being suppressed by a dead holder.
      const heldBoardId = announcedWallBoardIdRef.current;
      if (heldBoardId !== null) {
        announcedWallBoardIdRef.current = null;
        void revokeWallLink(heldBoardId);
      }
      track(SHARED_EVENTS.BluetoothDisconnected, {
        boardName,
        reason: 'unexpected',
        inSession: sessionIdRef.current != null,
      });
    }
    wasConnectedRef.current = isConnected;
  }, [clearPendingWallReportAndUndoToastArm, isConnected, boardName, revokeWallLink]);

  const value = useMemo<BluetoothContextValue>(
    () => ({
      isConnected,
      loading,
      connect,
      disconnect: wrappedDisconnect,
      sendFramesToBoard,
      clearBoard,
      reassertWall,
      undoWallChange,
      armUndoWallChangeToast,
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
      undoWallChange,
      armUndoWallChangeToast,
      reconnectSerialForCurrentBoard,
    ],
  );

  return (
    <BluetoothContext.Provider value={value}>
      {isConnected && !isPartyPreviewOnly && isWallWriter && (
        <BluetoothAutoSender
          sendFramesToBoard={sendFramesToBoard}
          onWallConfirmed={handleWallConfirmed}
          reassertNonce={reassertNonce}
          connectInitialSendRef={connectInitialSendRef}
          colorSignature={holdColorSignature}
        />
      )}
      {children}
      {pickerState && (
        <DevicePickerSheet
          devices={pickerState.devices}
          onSelect={handlePickerSelect}
          onDismiss={pickerState.handleCancel}
          isScanning={pickerState.isScanning}
          resolvedBoards={resolvedPickerBoards}
          currentBoardConfig={currentBoardConfig}
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
