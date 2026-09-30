import { z } from 'zod';
import { posthogConfigFromEnvironment, runRefreshRecommendations } from '@boardsesh/db/jobs';
import { fencedTransact, jobLogger } from './batch-job';
import type { BackgroundJobFamilyModule } from './types';

const payload = z.object({}).strict();

/**
 * Nightly setter stats, PostHog send stats, cohort playlists and the weekly
 * history catch-up (`@boardsesh/db/jobs`). The PostHog request runs outside
 * every fence. Without `POSTHOG_PERSONAL_API_KEY` the send stats are skipped
 * and the run logs a warning, the same as the Actions workflow.
 */
export const refreshRecommendationsFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'refresh-recommendations',
  roles: ['batch'],
  options: {
    // A run takes about 25 s against production (Sep 2026).
    expireInSeconds: 1200,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 900,
    deadlineSeconds: 72_000,
    // Longest write batches: the setter-stats upsert (about 8 s) and the weekly
    // MoonBoard history snapshot (about 5 s), well inside the window.
    heartbeatSeconds: 30,
  },
  payload,
  singletonKey: () => 'nightly',
  schedules: [{ key: 'nightly', cron: '0 6 * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    await runRefreshRecommendations({
      db: context.database,
      signal: context.signal,
      transact: fencedTransact(context),
      log: jobLogger(context),
      posthog: posthogConfigFromEnvironment(process.env),
    });
  },
};
