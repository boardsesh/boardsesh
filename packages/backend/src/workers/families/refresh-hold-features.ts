import type { z } from 'zod';
import { runRefreshHoldFeatures } from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger, systemUserAuthorityForContext } from './batch-job';
import { refreshHoldFeaturesPayload as payload } from './batch-system-user-payloads';
import type { BackgroundJobFamilyModule } from './types';

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
      systemUserAuthority: systemUserAuthorityForContext(context),
      log: jobLogger(context),
      board,
      dryRun: dryRun ?? false,
      shadow: shadow ?? true,
    });
  },
};
