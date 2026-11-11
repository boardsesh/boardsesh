import { z } from 'zod';
import { refreshUserClimbPercentiles } from '@boardsesh/db/queries';
import type { BackgroundJobFamilyModule } from './types';

/** A durable refresh queued in the same transaction as account consolidation. */
export const refreshUserPercentilesFamily: BackgroundJobFamilyModule<Record<string, never>> = {
  name: 'refresh-user-percentiles',
  roles: ['batch'],
  options: {
    expireInSeconds: 300,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 300,
    deadlineSeconds: 3600,
    heartbeatSeconds: 30,
  },
  payload: z.object({}).strict(),
  singletonKey: () => 'global',
  async execute(context) {
    await context.transaction((transaction) => refreshUserClimbPercentiles(transaction));
  },
};
