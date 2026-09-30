import { z } from 'zod';
import { selfHealStaleClimbStats } from '@boardsesh/db/queries';
import { logger } from '../../utils/logger';
import { selfHealMaxDrainBatches } from '../config';
import type { BackgroundJobFamilyModule } from './types';

const climbStatsSelfHealPayload = z.object({}).strict();

export type ClimbStatsSelfHealPayload = z.infer<typeof climbStatsSelfHealPayload>;

/** Keys per fenced recompute batch: one seed INSERT and one aggregate UPDATE. */
export const SELF_HEAL_BATCH_KEYS = 500;

/**
 * The Aurora daemon's hourly recompute self-heal, as a job, in two steps:
 *
 * 1. drain `climb_stats_recompute_pending`: keys a sync job's page committed
 *    but whose recompute never ran (the worker stopped first), older than two
 *    minutes, oldest first, up to 20 batches of 500. These include keys with no
 *    stats row yet and keys whose tick was deleted, which step 2 cannot see;
 * 2. find flash/send ticks from the last 3 hours that are newer than the
 *    `board_climb_stats` row they feed (at most 5000 keys) and re-derive those
 *    rows: a debounced tick recompute a backend deploy dropped.
 *
 * Pure database work, and the same pass the Aurora daemon runs
 * (`selfHealStaleClimbStats`): the key scan is an unfenced read, and every
 * recompute runs through the attempt fence in batches of 500 keys, so no batch
 * holds the run-row lock for long.
 */
export const climbStatsSelfHealFamily: BackgroundJobFamilyModule<ClimbStatsSelfHealPayload> = {
  name: 'climb-stats-self-heal',
  roles: ['maintenance-delivery'],
  options: {
    expireInSeconds: 900,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 300,
    deadlineSeconds: 3600,
    heartbeatSeconds: 120,
  },
  payload: climbStatsSelfHealPayload,
  singletonKey: () => 'climb-stats',
  schedules: [{ key: 'hourly', cron: '13 * * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    // First the keys a sync job marked and never got to recompute (it stopped
    // between a page and its flush), oldest first; then the tick scan.
    const maxDrainBatches = selfHealMaxDrainBatches();
    const { pendingKeysDrained, keysHealed, pendingRemaining } = await selfHealStaleClimbStats(context.database, {
      runBatch: context.transaction,
      batchKeys: SELF_HEAL_BATCH_KEYS,
      maxDrainBatches,
    });
    if (pendingRemaining !== undefined) {
      // The drain stopped at its cap with keys still waiting: a backlog this
      // hourly pass is not keeping up with.
      logger.warn('[worker] climb stats self-heal drain capped', {
        runId: context.runId,
        family: context.family,
        code: 'SELF_HEAL_DRAIN_CAPPED',
        maxDrainBatches,
        pendingRemaining,
      });
    }
    logger.info('[worker] climb stats self-heal finished', {
      runId: context.runId,
      family: context.family,
      pendingKeysDrained,
      keysHealed,
    });
  },
};
