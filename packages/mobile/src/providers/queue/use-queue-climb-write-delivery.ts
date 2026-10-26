import { useEffect } from 'react';
import { getLatestClimbMutationKey } from '@boardsesh/offline-sync';
import type { ClimbAuthoredPatch } from '@boardsesh/queue';
import { getDatabaseHandle } from '../../db';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { reportHandledError } from '../../lib/error-reporting';
import { subscribeMutationDelivery } from '../../offline/mutation-delivery-store';

type CanonicalQueueClimb = {
  name: string;
  frames: string;
  published_at: string | null;
  is_draft: number | null;
};

/** Clear device-only editing hints even after the creator drawer has closed. */
export function useQueueClimbWriteDelivery(
  refreshAuthoredClimb: (climbUuid: string, patch: ClimbAuthoredPatch) => void,
): void {
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeMutationDelivery((event) => {
      const prefix = 'climb:spray:';
      if (event.status !== 'acknowledged' || event.tableName !== 'board_climbs' || !event.entityKey?.startsWith(prefix))
        return;
      const climbUuid = event.entityKey.slice(prefix.length);
      const credentialGeneration = getCredentialGeneration();
      const db = getDatabaseHandle();
      if (!db) return;
      void (async () => {
        const climb = await db.getFirstAsync<CanonicalQueueClimb>(
          "SELECT name, frames, published_at, is_draft FROM board_climbs WHERE uuid = ? AND board_type = 'spray'",
          [climbUuid],
        );
        if (!climb || (await getLatestClimbMutationKey(db, 'spray', climbUuid))) return;
        if (!active || credentialGeneration !== getCredentialGeneration()) return;
        refreshAuthoredClimb(climbUuid, {
          name: climb.name,
          frames: climb.frames,
          published_at: climb.published_at,
          is_draft: climb.is_draft === 1,
          localWritePending: false,
        });
      })().catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'offline-sync', kind: 'queued-climb-refresh' } });
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refreshAuthoredClimb]);
}
