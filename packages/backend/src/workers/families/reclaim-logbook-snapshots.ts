import { z } from 'zod';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import { reclaimExpiredLogbookSnapshots } from '../../services/logbook-snapshot';
import { logger } from '../../utils/logger';
import type { BackgroundJobFamilyModule } from './types';

const reclaimLogbookSnapshotsPayload = z.object({}).strict();

export type ReclaimLogbookSnapshotsPayload = z.infer<typeof reclaimLogbookSnapshotsPayload>;

/**
 * Deletes logbook snapshots past their hour. Only storage depends on this: an
 * expired snapshot is unreadable from the moment it expires, whether or not a
 * run has happened (docs/integration-platform.md, "Complete bootstrap and
 * transition").
 *
 * Every 15 minutes. Each write batch is one short fenced transaction, and a
 * run stops at its batch cap and leaves the rest for the next one.
 */
export const reclaimLogbookSnapshotsFamily: BackgroundJobFamilyModule<ReclaimLogbookSnapshotsPayload> = {
  name: 'reclaim-logbook-snapshots',
  roles: ['maintenance-delivery'],
  options: {
    expireInSeconds: 300,
    retryLimit: 1,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 60,
    deadlineSeconds: 900,
    heartbeatSeconds: 60,
  },
  payload: reclaimLogbookSnapshotsPayload,
  singletonKey: () => 'logbook-snapshots',
  schedules: [{ key: 'quarter-hourly', cron: '2,17,32,47 * * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    const { snapshotsRemoved, chunksRemoved, capped } = await reclaimExpiredLogbookSnapshots(
      <Result>(callback: (transaction: BackgroundJobTransaction) => Promise<Result>) => context.transaction(callback),
      { signal: context.signal },
    );
    logger.info('[worker] logbook snapshot reclaim finished', {
      runId: context.runId,
      family: context.family,
      snapshotsRemoved,
      chunksRemoved,
      capped,
    });
  },
};
