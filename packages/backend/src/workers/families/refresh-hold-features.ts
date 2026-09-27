import { z } from 'zod';
import { runRefreshHoldFeatures } from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger } from './batch-job';
import type { BackgroundJobFamilyModule } from './types';

const payload = z
  .object({
    board: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .default('kilter'),
    dryRun: z.boolean().optional(),
    shadow: z.boolean().optional(),
  })
  .strict();

/**
 * Nightly per-hold features for one board (`@boardsesh/db/jobs`). Each layout's
 * upserts commit in one fenced batch of a few hundred rows.
 */
export const refreshHoldFeaturesFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-hold-features',
  roles: ['batch'],
  options: {
    // Kilter takes about 60 s against production (Sep 2026).
    expireInSeconds: 1200,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 72_000,
    heartbeatSeconds: 30,
  },
  payload,
  singletonKey: ({ board }) => board,
  schedules: [{ key: 'nightly', cron: '15 6 * * *', fanOut: async () => [{ payload: { board: 'kilter' } }] }],
  async execute(context, { board, dryRun, shadow }) {
    await runRefreshHoldFeatures({
      db: context.database,
      signal: context.signal,
      transact: fencedTransact(context),
      log: jobLogger(context),
      board,
      dryRun: dryRun ?? false,
      shadow: shadow ?? true,
    });
  },
};
