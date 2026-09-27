import { z } from 'zod';
import { MoonboardFitUnusableError, runMoonboardWideAngleEstimates } from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger } from './batch-job';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const payload = z
  .object({
    publish: z.boolean().default(true),
    dryRun: z.boolean().optional(),
  })
  .strict();

/**
 * Weekly MoonBoard wide-angle estimate refresh (`@boardsesh/db/jobs`,
 * docs/boardsesh-grade.md). Borrows Kilter/Tension's fitted angle-effect shape
 * to estimate every MoonBoard problem's grade outside the catalog's own
 * 25°/40°, then publishes in fenced chunks of ~50k rows, each climb's whole
 * angle ladder in one chunk. Zero angle-surface coverage from either shape
 * board fails the run with `FIT_UNUSABLE` and no retry: nothing was written.
 * `dryRun` wins over `publish`, so `{ dryRun: true }` writes nothing.
 */
export const refreshMoonboardWideAngleEstimatesFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-moonboard-wide-angle-estimates',
  roles: ['batch'],
  options: {
    // The whole run (fit, plan and every chunk) must end inside this lease.
    // Measured ~24 minutes end to end on GitHub Actions (Sep 2026); 2 h leaves
    // room for a batch VM several times slower.
    expireInSeconds: 7200,
    retryLimit: 1,
    retryDelay: 900,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 518_400,
    // Only one publish chunk (~50k rows) holds the fence at a time. At the
    // measured ~0.49 ms per row that is ~25 s, against a 290 s bound (this
    // heartbeat minus the 10 s touch lag): about 11x slack.
    heartbeatSeconds: 300,
  },
  payload,
  singletonKey: () => 'weekly',
  schedules: [{ key: 'weekly', cron: '30 8 * * 1', fanOut: async () => [{ payload: { publish: true } }] }],
  async execute(context, { publish, dryRun }) {
    try {
      await runMoonboardWideAngleEstimates({
        db: context.database,
        signal: context.signal,
        transact: fencedTransact(context),
        log: jobLogger(context),
        publish: publish && !dryRun,
        dryRun: dryRun ?? false,
      });
    } catch (error) {
      if (error instanceof MoonboardFitUnusableError)
        throw new BackgroundJobError('FIT_UNUSABLE', { retryable: false });
      throw error;
    }
  },
};
