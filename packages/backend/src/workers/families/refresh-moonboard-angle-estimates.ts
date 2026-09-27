import { z } from 'zod';
import { MoonboardFitUnusableError, runMoonboardAngleEstimates } from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger } from './batch-job';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const payload = z
  .object({
    publish: z.boolean().default(true),
    validateOnly: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/**
 * Weekly MoonBoard same-board (25°↔40°) angle transpose (`@boardsesh/db/jobs`,
 * docs/boardsesh-grade.md). Fits a per-grade-band delta from the small
 * dual-graded minority, then publishes coefficients and estimate rows in one
 * fenced transaction. An unusable pooled fit fails the run with
 * `FIT_UNUSABLE` and no retry: nothing was written, and the same data fails
 * the same fit.
 */
export const refreshMoonboardAngleEstimatesFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-moonboard-angle-estimates',
  roles: ['batch'],
  options: {
    // Matches the GitHub Actions workflow's own 30-minute timeout. A measured
    // production run (Sep 2026) took about 157 s end to end, of which the
    // publish transaction (216k rows) was about 131 s.
    expireInSeconds: 1800,
    retryLimit: 1,
    retryDelay: 900,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 518_400,
    // The publish (coefficients + upserts + reap) is one transaction, and the
    // heartbeat can't be touched while it's held. Measured publish is ~131 s;
    // 300 s gives over 2x margin against catalog growth while staying well
    // under the family's own 1800 s expire ceiling.
    heartbeatSeconds: 300,
  },
  payload,
  singletonKey: () => 'weekly',
  schedules: [{ key: 'weekly', cron: '0 8 * * 1', fanOut: async () => [{ payload: { publish: true } }] }],
  async execute(context, { publish, validateOnly, dryRun }) {
    try {
      await runMoonboardAngleEstimates({
        db: context.database,
        signal: context.signal,
        transact: fencedTransact(context),
        log: jobLogger(context),
        publish,
        validateOnly: validateOnly ?? false,
        dryRun: dryRun ?? false,
      });
    } catch (error) {
      if (error instanceof MoonboardFitUnusableError)
        throw new BackgroundJobError('FIT_UNUSABLE', { retryable: false });
      throw error;
    }
  },
};
