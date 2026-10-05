import type { BoardAdapter } from '@boardsesh/board-react';
import {
  capturePurgeToken,
  hasPurgeLanded,
  isSigningOut,
  isScopeDownloadComplete,
  mirrorSavedClimb,
  offlineBoardKeyForBoard,
  purgeNamespaceKey,
} from '@boardsesh/offline-sync';
import { SAVED_CLIMB_DOCUMENTS, type SavedClimbDocumentsResponse } from '@boardsesh/graphql/operations';
import { getDatabaseHandle } from '../db';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { reportHandledError } from '../lib/error-reporting';
import { isOfflineEngineEnabled } from '../lib/offline-engine';

// Mobile deployment depends on the additive backend query landing first.
export const mirrorWrittenClimb: NonNullable<BoardAdapter['afterClimbWrite']> = async (write) => {
  const canWrite = () => write.authEpoch !== undefined && isAuthCredentialGenerationCurrent(write.authEpoch);
  if (write.boardType !== 'spray' || !isOfflineEngineEnabled() || !canWrite()) return;
  try {
    const db = getDatabaseHandle();
    if (!db) return;
    const board = await getStoredActiveBoard();
    if (
      !canWrite() ||
      !board ||
      board.boardType !== write.boardType ||
      (write.layoutId !== undefined && board.layoutId !== write.layoutId) ||
      (write.sizeId !== undefined && board.sizeId !== write.sizeId)
    )
      return;
    if (!(await isScopeDownloadComplete(db, offlineBoardKeyForBoard(board))) || !canWrite()) return;
    const purgeToken = capturePurgeToken();
    const canMirror = () => canWrite() && !isSigningOut() && !hasPurgeLanded(purgeToken, purgeNamespaceKey(board));
    const response = await getOfflineSyncHttpClient().request<SavedClimbDocumentsResponse>(SAVED_CLIMB_DOCUMENTS, {
      boardType: write.boardType,
      layoutId: board.layoutId,
      climbUuid: write.climbUuid,
      sprayWallUuid: write.sprayWallUuid ?? (board.boardType === 'spray' ? board.uuid : null),
    });
    if (!canMirror()) return;
    if (!response.syncClimbDocuments) throw new Error('Saved climb is unavailable for local mirroring');
    await mirrorSavedClimb(db, board, write.climbUuid, response.syncClimbDocuments, canMirror);
  } catch (error) {
    if (!canWrite()) return;
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'saved-climb-mirror' } });
    throw error;
  }
};
