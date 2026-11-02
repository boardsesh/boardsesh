import {
  capturePurgeToken,
  hasPurgeLanded,
  isSigningOut,
  mirrorSavedClimb,
  purgeNamespaceKey,
  type GraphQLFetch,
  type OfflineDatabase,
  type PendingMutation,
} from '@boardsesh/offline-sync';
import { SAVED_CLIMB_DOCUMENTS, type SavedClimbDocumentsResponse } from '@boardsesh/graphql/operations';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';

/** Reconcile a committed climb before its dependents are released from the outbox. */
export async function acknowledgeClimbWrite(
  db: OfflineDatabase,
  mutation: PendingMutation,
  graphqlFetch: GraphQLFetch,
): Promise<void> {
  if (mutation.table_name !== 'board_climbs') return;
  const payload = JSON.parse(mutation.payload) as { uuid: string; boardType: string; sprayWallUuid?: string };
  if (payload.boardType !== 'spray') return;
  const generation = captureAuthCredentialGeneration();
  const purgeToken = capturePurgeToken();
  const climb = await db.getFirstAsync<{ layout_id: number }>(
    'SELECT layout_id FROM board_climbs WHERE uuid = ? AND board_type = ?',
    [payload.uuid, payload.boardType],
  );
  if (!climb) throw new Error('Queued climb is missing from this device');
  const scope = { boardType: 'spray', layoutId: climb.layout_id, sizeId: climb.layout_id };
  const canWrite = () =>
    isAuthCredentialGenerationCurrent(generation) &&
    !isSigningOut() &&
    !hasPurgeLanded(purgeToken, purgeNamespaceKey(scope));
  const response = await graphqlFetch<SavedClimbDocumentsResponse>(SAVED_CLIMB_DOCUMENTS, {
    boardType: payload.boardType,
    layoutId: climb.layout_id,
    climbUuid: payload.uuid,
    sprayWallUuid: payload.sprayWallUuid,
  });
  if (!canWrite() || !response.syncClimbDocuments) throw new Error('Canonical climb is unavailable');
  const mirrored = await mirrorSavedClimb(
    db,
    scope,
    payload.uuid,
    response.syncClimbDocuments,
    canWrite,
    mutation.idempotency_key,
  );
  if (!mirrored) throw new Error('Canonical climb reconciliation was interrupted');
}
