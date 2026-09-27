import { z } from 'zod';
import { findStaleClimbStatsKeys, recomputeClimbStatsInBatches } from '@boardsesh/db/queries';
import { logger } from '../../utils/logger';
import type { BackgroundJobFamilyModule } from './types';

const climbStatsSelfHealPayload = z.object({}).strict();

export type ClimbStatsSelfHealPayload = z.infer<typeof climbStatsSelfHealPayload>;

/** Keys per fenced recompute batch: one seed INSERT and one aggregate UPDATE. */
export const SELF_HEAL_BATCH_KEYS = 500;

/**
 * The Aurora daemon's hourly recompute self-heal, as a job: find flash/send
 * ticks from the last 3 hours that are newer than the `board_climb_stats` row
 * they feed (at most 5000 keys) and re-derive those rows. It catches a
 * debounced tick recompute a backend deploy dropped, and a deferred sync
 * recompute a crashed or aborted worker never ran.
 *
 * Pure database work: the key scan is an unfenced read, and the recompute runs
 * through the attempt fence in batches of 500 keys, so no batch holds the
 * run-row lock for long.
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
    const keys = await findStaleClimbStatsKeys(context.database);
    const healed = await recomputeClimbStatsInBatches(context.transaction, keys, SELF_HEAL_BATCH_KEYS);
    logger.info('[worker] climb stats self-heal finished', {
      runId: context.runId,
      family: context.family,
      keysHealed: healed,
    });
  },
};
