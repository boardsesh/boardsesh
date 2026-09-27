import { z } from 'zod';
import { GradeGatesFailedError, runRefreshClimbGrades } from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger } from './batch-job';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const payload = z
  .object({
    refit: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    validateOnly: z.boolean().optional(),
  })
  .strict();

/**
 * Nightly Boardsesh grade refresh (`@boardsesh/db/jobs`, docs/boardsesh-grade.md).
 * Reads every board's stats into memory (the batch container's 4 GB heap),
 * then publishes coefficients, gate results and grades in one fenced
 * transaction. A blocking gate fails the run with `GATES_FAILED` and no retry:
 * nothing was written, and the same data fails the same gate.
 */
export const refreshClimbGradesFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-climb-grades',
  roles: ['batch'],
  options: {
    // A run takes about 4 minutes against production (Sep 2026).
    expireInSeconds: 1800,
    retryLimit: 1,
    retryDelay: 900,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 72_000,
    // The publish is one transaction (69 s on 2026-09-26, longer on a refit
    // night), and the heartbeat waits on the run row that transaction holds.
    // The window must outlast it or every publish would lose its attempt.
    heartbeatSeconds: 900,
  },
  payload,
  singletonKey: () => 'nightly',
  schedules: [{ key: 'nightly', cron: '30 6 * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context, { refit, dryRun, validateOnly }) {
    try {
      await runRefreshClimbGrades({
        db: context.database,
        signal: context.signal,
        transact: fencedTransact(context),
        log: jobLogger(context),
        refit: refit ?? false,
        dryRun: dryRun ?? false,
        validateOnly: validateOnly ?? false,
        allowEmptyBacktest: false,
        publishCrossAngleEstimates: false,
      });
    } catch (error) {
      if (error instanceof GradeGatesFailedError) throw new BackgroundJobError('GATES_FAILED', { retryable: false });
      throw error;
    }
  },
};
