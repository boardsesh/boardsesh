import { z } from 'zod';
import { applyClimbPlaysBatch, planClimbPlays, PLAY_REFRESH_BATCH_SIZE } from '../../services/climb-plays';
import { logger } from '../../utils/logger';
import type { BackgroundJobFamilyModule } from './types';

const payload = z.object({ dryRun: z.boolean().default(false) }).strict();

export const refreshClimbPlaysFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-climb-plays',
  roles: ['batch'],
  options: {
    expireInSeconds: 1200,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 3600,
    heartbeatSeconds: 120,
  },
  payload,
  singletonKey: () => 'all',
  schedules: [{ key: 'hourly', cron: '23 * * * *', fanOut: async () => [{ payload: { dryRun: false } }] }],
  async execute(context, { dryRun }) {
    const startedAt = Date.now();
    context.signal.throwIfAborted();
    const plan = await planClimbPlays(context.database);
    let changedRows = 0;
    let zeroedRows = 0;
    if (!dryRun) {
      for (let offset = 0; offset < plan.changes.length; offset += PLAY_REFRESH_BATCH_SIZE) {
        context.signal.throwIfAborted();
        const batch = plan.changes.slice(offset, offset + PLAY_REFRESH_BATCH_SIZE);
        // Separate zero updates lets diagnostics count actual committed resets,
        // including a stats row concurrently deleted after the read snapshot.
        await context
          .transaction(async (transaction) => {
            const zeroed = await applyClimbPlaysBatch(
              transaction,
              batch.filter((change) => change.playCount === 0),
            );
            const updated = await applyClimbPlaysBatch(
              transaction,
              batch.filter((change) => change.playCount > 0),
            );
            return { zeroed, updated };
          })
          .then(({ zeroed, updated }) => {
            zeroedRows += zeroed;
            changedRows += zeroed + updated;
          });
      }
    }
    context.signal.throwIfAborted();
    logger.info('[worker] climb plays refresh finished', {
      family: context.family,
      runId: context.runId,
      dryRun,
      measuredAt: plan.measuredAt,
      qualifyingPlays: plan.qualifyingPlays,
      unmatchedKeys: plan.unmatchedKeys,
      unmatchedPlays: plan.unmatchedPlays,
      excludedRecords: plan.excludedRecords,
      plannedRows: plan.changes.length,
      changedRows,
      zeroedRows,
      durationMs: Date.now() - startedAt,
    });
  },
};
