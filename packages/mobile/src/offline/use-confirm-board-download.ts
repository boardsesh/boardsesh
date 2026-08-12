// The two ways a board becomes available offline, shared by every surface that
// offers it (the My Boards toggle and the discovery nudges of issue #4318).
//
// Splitting them is the point. A download and an arm are different promises:
//
//   confirmAndDownload — the device is online. Quote the size, ask, then enable
//     and kick a cycle. Byte-identical to what My Boards has always done, so a
//     nudge-triggered download is the same download.
//
//   armWithoutConfirm — the device has no usable connection. Enable only, no
//     cycle, no size dialog (no honest number exists before the manifest is
//     reachable, and there is nothing to consent to yet — nothing downloads).
//     See armBoardsOffline for why kicking a cycle here is actively harmful.

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  estimateScopeDownload,
  getCheckpoint,
  getCheckpointKey,
  isBootstrapDone,
  isScopeDownloadComplete,
  readBootstrapRetryState,
} from '@boardsesh/offline-sync';
import { offlineBoardKeyForBoard, offlineBoardScopeForBoard } from '../settings';
import { useConfirm } from '../providers/dialog-provider';
import { formatBytes } from '../lib/format-bytes';
import { useBoardDownloads } from './use-board-downloads';
import { useSnapshotManifest } from './use-snapshot-manifest';

export function useConfirmBoardDownload() {
  const { t, i18n } = useTranslation('boards');
  const db = useSQLiteContext();
  const confirm = useConfirm();
  const { enableBoardsOffline, armBoardsOffline } = useBoardDownloads();
  // A ref, not a dep: the manifest arrives asynchronously and must not rebuild
  // the callback (My Boards passes it to every virtualised row).
  const snapshotManifest = useSnapshotManifest();
  const snapshotManifestRef = useRef(snapshotManifest);
  snapshotManifestRef.current = snapshotManifest;

  /**
   * Quote the download size, ask, and start it. Resolves to whether the user
   * confirmed.
   */
  const confirmAndDownload = useCallback(
    async (board: UserBoard): Promise<boolean> => {
      const scope = offlineBoardScopeForBoard(board);
      const key = offlineBoardKeyForBoard(board);
      // How big is this download? Only the snapshot path can answer honestly, and
      // only for a scope that would actually bootstrap — a board toggled off and
      // back on keeps its rows + checkpoint and resumes as a small delta, so
      // quoting the full artifact size there would be wrong. estimateScopeDownload
      // owns those rules (shared with the engine's own eligibility check); anything
      // it can't vouch for falls back to the sizeless copy.
      //
      // Concurrent, not sequential: these are four independent reads and the
      // dialog opens behind them, so serialising them would show up as a stall on
      // slow storage. The retry state is read after them because it needs to know
      // whether a board checkpoint exists (a snapshot failure over a partial crawl
      // is budgeted differently from one over an empty scope).
      const now = Date.now();
      const [climbsCheckpoint, statsCheckpoint, scopeComplete, bootstrapAlreadyDone] = await Promise.all([
        getCheckpoint(db, getCheckpointKey('board_climbs', key)),
        getCheckpoint(db, getCheckpointKey('board_climb_stats', key)),
        isScopeDownloadComplete(db, key),
        isBootstrapDone(db, key),
      ]);
      const hasBoardCheckpoint = !!climbsCheckpoint || !!statsCheckpoint;
      const { state: retryState } = await readBootstrapRetryState(
        db,
        key,
        { now, random: Math.random },
        hasBoardCheckpoint,
      );
      const estimate = estimateScopeDownload({
        manifest: snapshotManifestRef.current,
        boardType: scope.boardType,
        layoutId: scope.layoutId,
        retryState,
        hasBoardCheckpoint,
        isScopeComplete: scopeComplete,
        isBootstrapDone: bootstrapAlreadyDone,
        now,
      });
      const confirmed = await confirm({
        title: t('mobile.offline.enableTitle', { name: board.name }),
        message:
          estimate.kind === 'snapshot'
            ? t('mobile.offline.enableMessageWithSize', { size: formatBytes(estimate.bytes, i18n.language) })
            : t('mobile.offline.enableMessage'),
        confirmLabel: t('mobile.offline.enableConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
      });
      if (!confirmed) return false;
      // Enable + kick a download now via the shared hook (single-flight, reads the
      // latest syncEnabledBoards setting).
      enableBoardsOffline(board);
      return true;
    },
    [confirm, t, i18n.language, db, enableBoardsOffline],
  );

  /** Mark the board for offline; the scheduler pulls it on the next reconnect. */
  const armWithoutConfirm = useCallback(
    (board: UserBoard): void => {
      armBoardsOffline(board);
    },
    [armBoardsOffline],
  );

  return { confirmAndDownload, armWithoutConfirm };
}
