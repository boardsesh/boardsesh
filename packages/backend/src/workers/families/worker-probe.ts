import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BACKGROUND_WORKER_ROLES } from '@boardsesh/db/background-jobs';
import type { BackgroundJobFamilyModule } from './types';

/**
 * A no-op that exercises the whole path: enqueue, fetch, claim, one fenced
 * batch, settle. Every role serves it so an operator can prove a worker end to
 * end before enabling a real family on it.
 */
const workerProbePayload = z.object({}).strict();

export const workerProbeFamily: BackgroundJobFamilyModule<z.infer<typeof workerProbePayload>> = {
  name: 'worker-probe',
  roles: BACKGROUND_WORKER_ROLES,
  options: {
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 120,
    deadlineSeconds: 24 * 60 * 60,
    heartbeatSeconds: 30,
  },
  payload: workerProbePayload,
  async execute(context) {
    await context.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT 1`);
    });
  },
};
