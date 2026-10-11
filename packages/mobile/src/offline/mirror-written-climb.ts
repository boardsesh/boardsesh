import type { BoardAdapter } from '@boardsesh/board-react';
import {
  capturePurgeToken,
  hasProtectedWithdrawalLanded,
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
import { needsPrivacyRevalidation } from './privacy-revalidation';

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
    // A mirrored climb is a protected row, so it stops at the same fence a
    // protected sync page does: a response fetched before a privacy event must
    // not land after the event's purge, and nothing is written while that
    // purge is still pending.
    const canMirror = () =>
      canWrite() &&
      !isSigningOut() &&
      !hasPurgeLanded(purgeToken, purgeNamespaceKey(board)) &&
      !hasProtectedWithdrawalLanded(purgeToken) &&
      !needsPrivacyRevalidation();
    const response = await getOfflineSyncHttpClient().request<SavedClimbDocumentsResponse>(SAVED_CLIMB_DOCUMENTS, {
      boardType: write.boardType,
      layoutId: board.layoutId,
      climbUuid: write.climbUuid,
      sprayWallUuid: write.sprayWallUuid ?? board.uuid,
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
