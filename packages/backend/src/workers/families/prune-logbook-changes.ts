import { z } from 'zod';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import { pruneLogbookChanges } from '../../services/logbook-prune';
import { logger } from '../../utils/logger';
import type { BackgroundJobFamilyModule } from './types';

const pruneLogbookChangesPayload = z.object({}).strict();

export type PruneLogbookChangesPayload = z.infer<typeof pruneLogbookChangesPayload>;

/**
 * Deletes partner logbook feed rows older than 90 days and advances the
 * retention watermark over them (`services/logbook-prune.ts`). A cursor below
 * the watermark answers 410; nothing a client can read depends on the run's
 * timing, only on the watermark it commits with each batch.
 *
 * Daily. Each delete is one short fenced transaction of at most 500 rows; the
 * walk that picks them is an unfenced read. A run stops after 400 batches or
 * 240 s and leaves the rest for the next day.
 */
export const pruneLogbookChangesFamily: BackgroundJobFamilyModule<PruneLogbookChangesPayload> = {
  name: 'prune-logbook-changes',
  roles: ['maintenance-delivery'],
  options: {
    // The 240 s budget, plus one more walk (120 s timeout) and its delete.
    expireInSeconds: 600,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 300,
    deadlineSeconds: 3600,
    // One delete batch is at most a few 5 s statements, well inside the 50 s bound.
    heartbeatSeconds: 60,
  },
  payload: pruneLogbookChangesPayload,
  singletonKey: () => 'logbook-changes',
  schedules: [{ key: 'daily', cron: '53 3 * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    const result = await pruneLogbookChanges(
      {
        read: <Result>(callback: (transaction: BackgroundJobTransaction) => Promise<Result>) =>
          context.database.transaction(callback),
        runBatch: <Result>(callback: (transaction: BackgroundJobTransaction) => Promise<Result>) =>
          context.transaction(callback),
      },
      { signal: context.signal },
    );
    logger.info('[worker] logbook change prune finished', {
      runId: context.runId,
      family: context.family,
      rowsDeleted: result.rowsDeleted,
      batches: result.batches,
      prunedThroughTxid: result.prunedThrough.txid,
      prunedThroughSeq: result.prunedThrough.seq,
      stoppedBy: result.stoppedBy,
    });
  },
};
