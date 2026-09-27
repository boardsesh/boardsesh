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
 * 25°/40°, then publishes in one fenced transaction. Zero angle-surface
 * coverage from either shape board fails the run with `FIT_UNUSABLE` and no
 * retry: nothing was written.
 *
 * This family's own catalog scan can run into the millions of rows (2.89M
 * measured against production Sep 2026, ~1429 s for the publish alone) — see
 * docs/background-workers.md for why its heartbeat sits close to its expire
 * ceiling rather than the smaller margin the other batch families use.
 */
export const refreshMoonboardWideAngleEstimatesFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-moonboard-wide-angle-estimates',
  roles: ['batch'],
  options: {
    // Matches the GitHub Actions workflow's own 30-minute timeout.
    expireInSeconds: 1800,
    retryLimit: 1,
    retryDelay: 900,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 518_400,
    // Measured Sep 2026: the publish transaction alone (2.89M rows, upserted
    // 500 at a time) took ~1429 s — no touch can land while it's held, so the
    // heartbeat is sized as close to the 1800 s expire ceiling as is safe
    // (100 s of margin) rather than to a fraction of it. If catalog growth
    // pushes the publish past ~1700 s, expireInSeconds must grow with it.
    heartbeatSeconds: 1700,
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
        publish,
        dryRun: dryRun ?? false,
      });
    } catch (error) {
      if (error instanceof MoonboardFitUnusableError)
        throw new BackgroundJobError('FIT_UNUSABLE', { retryable: false });
      throw error;
    }
  },
};
