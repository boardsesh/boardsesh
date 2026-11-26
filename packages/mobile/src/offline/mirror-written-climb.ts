import { isReleasedQuantumConfig } from '@boardsesh/board-constants/quantum';
import type { BoardAdapter } from '@boardsesh/board-react';
import {
  capturePurgeToken,
  hasPurgeLanded,
  isSigningOut,
  isScopeDownloadComplete,
  mirrorSavedClimb,
  offlineBoardKey,
  purgeNamespaceKey,
} from '@boardsesh/offline-sync';
import { SAVED_CLIMB_DOCUMENTS, type SavedClimbDocumentsResponse } from '@boardsesh/graphql/operations';
import { getDatabaseHandle } from '../db';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { reportHandledError } from '../lib/error-reporting';
import { isOfflineEngineEnabled } from '../lib/offline-engine';

export const mirrorWrittenClimb: NonNullable<BoardAdapter['afterClimbWrite']> = async (write) => {
  const canWrite = () => write.authEpoch !== undefined && isAuthCredentialGenerationCurrent(write.authEpoch);
  if ((write.boardType !== 'spray' && write.boardType !== 'quantum') || !isOfflineEngineEnabled() || !canWrite())
    return;
  try {
    const db = getDatabaseHandle();
    if (!db) return;
    const activeSprayBoard = write.boardType === 'spray' ? await getStoredActiveBoard() : null;
    const { layoutId, sizeId } = write;
    const scope =
      write.boardType === 'quantum' && layoutId != null && sizeId != null && isReleasedQuantumConfig(layoutId, sizeId)
        ? { boardType: 'quantum', layoutId, sizeId }
        : activeSprayBoard;
    if (
      !canWrite() ||
      !scope ||
      scope.boardType !== write.boardType ||
      (layoutId !== undefined && scope.layoutId !== layoutId) ||
      (sizeId !== undefined && scope.sizeId !== sizeId)
    )
      return;
    if (!(await isScopeDownloadComplete(db, offlineBoardKey(scope))) || !canWrite()) return;
    const purgeToken = capturePurgeToken();
    const canMirror = () => canWrite() && !isSigningOut() && !hasPurgeLanded(purgeToken, purgeNamespaceKey(scope));
    const response = await getOfflineSyncHttpClient().request<SavedClimbDocumentsResponse>(SAVED_CLIMB_DOCUMENTS, {
      boardType: write.boardType,
      layoutId: scope.layoutId,
      climbUuid: write.climbUuid,
      ...(activeSprayBoard ? { sprayWallUuid: write.sprayWallUuid ?? activeSprayBoard.uuid } : {}),
    });
    if (!canMirror()) return;
    if (!response.syncClimbDocuments) throw new Error('Saved climb is unavailable for local mirroring');
    await mirrorSavedClimb(db, scope, write.climbUuid, response.syncClimbDocuments, canMirror);
  } catch (error) {
    if (!canWrite()) return;
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'saved-climb-mirror' } });
    throw error;
  }
};
