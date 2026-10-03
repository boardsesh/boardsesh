import { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useSprayWallsEnabled } from '../../providers/feature-flags-provider';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import {
  sprayDetailRows,
  sprayShareTarget,
  type SprayDetailRowKey,
  type SprayShareTarget,
} from '../../components/board-discovery/spray-detail-rows';

type ShareSnapshot = SprayShareTarget & { wallUuid: string; wallName: string };

function boardActionSignature(board: UserBoard | null): string {
  return board
    ? JSON.stringify([
        board.uuid,
        board.boardType,
        board.canEdit,
        board.isPublic,
        board.isUnlisted,
        board.slug,
        board.angle,
        board.name,
      ])
    : '';
}

/** Own action lifetimes above the panel, which unmounts after normal dismissal. */
export function useSprayWallSheetActions(board: UserBoard | null, dismissAndWait: () => Promise<DismissAndWaitResult>) {
  const enabled = useSprayWallsEnabled();
  const boardRef = useRef(board);
  boardRef.current = board;
  const signature = boardActionSignature(board);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const [shareSnapshot, setShareSnapshot] = useState<ShareSnapshot | null>(null);
  const [shareVisible, setShareVisible] = useState(false);
  const shareVisibleRef = useRef(shareVisible);
  shareVisibleRef.current = shareVisible;

  const cancelPendingAction = useCallback(() => {
    requestRef.current += 1;
    pendingRef.current = false;
  }, []);
  useEffect(() => {
    cancelPendingAction();
    setShareVisible(false);
  }, [signature, enabled, cancelPendingAction]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingAction();
    };
  }, [cancelPendingAction]);

  const openAction = useCallback(
    async (wallUuid: string, action: SprayDetailRowKey | 'share') => {
      const activeWall = boardRef.current;
      if (!enabledRef.current || pendingRef.current || !activeWall || activeWall.uuid !== wallUuid) return;
      const href = action === 'share' ? null : sprayDetailRows(activeWall).find((row) => row.key === action)?.href;
      const target = action === 'share' ? sprayShareTarget(activeWall) : null;
      if (action === 'share' ? !target : !href) return;
      const snapshot = target ? { ...target, wallUuid, wallName: activeWall.name } : null;
      const startingSignature = signatureRef.current;
      const request = ++requestRef.current;
      pendingRef.current = true;
      try {
        const result = await dismissAndWait();
        if (
          result.status !== 'dismissed' ||
          !mountedRef.current ||
          request !== requestRef.current ||
          !enabledRef.current ||
          startingSignature !== signatureRef.current
        )
          return;
        if (snapshot) {
          setShareSnapshot(snapshot);
          setShareVisible(true);
        } else if (href) {
          router.push(href);
        }
      } finally {
        if (request === requestRef.current) pendingRef.current = false;
      }
    },
    [dismissAndWait],
  );

  const openMaintenance = useCallback(
    (wallUuid: string, action: SprayDetailRowKey) => {
      void openAction(wallUuid, action);
    },
    [openAction],
  );
  const openShare = useCallback(
    (wallUuid: string) => {
      void openAction(wallUuid, 'share');
    },
    [openAction],
  );
  const closeShare = useCallback(() => setShareVisible(false), []);
  const clearShareSnapshot = useCallback(() => {
    if (!shareVisibleRef.current) setShareSnapshot(null);
  }, []);

  return {
    openMaintenance,
    openShare,
    cancelPendingAction,
    shareSnapshot,
    shareVisible,
    closeShare,
    clearShareSnapshot,
  };
}
