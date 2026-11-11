/** Concrete six-domain wiring. Jobs and mutations share the group transaction. */
import type { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import { boardseshTicks } from '@boardsesh/db/schema/app';
import { ConsolidationError } from './planner';
import {
  setPendingProviderSyncRun,
  refreshUserClimbPercentiles,
  markClimbStatsRecomputePending,
} from '@boardsesh/db/queries';
import { enqueueConsolidationJob } from './enqueue';
import { authenticationConsolidationHandler } from './authentication-handler';
import type { ConsolidationExecutionHooks } from './executor';
import { createConsolidationOwnershipHandler } from './ownership-handler';
import { createConsolidationProfileHandler, type ConsolidationPreimageArchive } from './profile-handler';
import { createConsolidationRelationshipHandler } from './relationship-handler';
import { createConsolidationSessionHandler } from './session-handler';
import { createConsolidationTickHandler } from './tick-handler';
import { verifyPostgresMaintenanceFence } from './maintenance';
import { revalidateConsolidationGroupState, captureAfterConsolidationGroupFingerprint } from './state';

export function createConsolidationRuntime(options: {
  readonly boss: PgBoss;
  readonly archivePreimages: ConsolidationPreimageArchive;
}): ConsolidationExecutionHooks {
  const archive = {
    archivePreimages: (
      context: Parameters<ConsolidationPreimageArchive>[0],
      preimages: Readonly<Record<string, unknown>>,
    ) => options.archivePreimages(context, 'relationships-or-ticks', preimages),
  };
  return {
    verifyMaintenance: verifyPostgresMaintenanceFence,
    revalidateGroup: revalidateConsolidationGroupState,
    captureAfterGroupFingerprint: captureAfterConsolidationGroupFingerprint,
    async finalizeDerivedState(transaction, context) {
      const keys = await transaction
        .selectDistinct({
          boardType: boardseshTicks.boardType,
          climbUuid: boardseshTicks.climbUuid,
          angle: boardseshTicks.angle,
        })
        .from(boardseshTicks)
        .where(eq(boardseshTicks.userId, context.survivorUserId))
        .limit(100001);
      if (keys.length > 100000) throw new ConsolidationError('INPUT_LIMIT');
      await markClimbStatsRecomputePending(transaction, keys);
      await refreshUserClimbPercentiles(transaction, context.survivorUserId);
    },
    domains: [
      createConsolidationProfileHandler(options),
      createConsolidationOwnershipHandler({
        archivePreimages: options.archivePreimages,
        async enqueueProviderSync(transaction, context, link) {
          const runId = await enqueueConsolidationJob(transaction, options.boss, {
            family: link.boardType === 'kilter' ? 'kilter-user-sync' : 'aurora-user-sync',
            role: 'interactive-import',
            payload: {
              userId: context.survivorUserId,
              boardType: link.boardType,
              linkGeneration: link.linkGeneration,
              requestedBy: 'link',
            },
          });
          await setPendingProviderSyncRun(transaction, {
            userId: context.survivorUserId,
            boardType: link.boardType,
            runId,
          });
        },
      }),
      createConsolidationRelationshipHandler(archive),
      createConsolidationSessionHandler(options),
      createConsolidationTickHandler(archive),
      authenticationConsolidationHandler(),
    ],
  };
}
