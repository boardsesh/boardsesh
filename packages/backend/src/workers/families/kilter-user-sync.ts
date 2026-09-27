import { z } from 'zod';
import { logger } from '../../utils/logger';
import { providerSyncUserId } from './aurora-user-sync';
import { runProviderSync } from './provider-sync-batch';
import type { BackgroundJobFamilyModule } from './types';

const kilterUserSyncPayload = z
  .object({
    userId: providerSyncUserId,
    boardType: z.literal('kilter'),
    linkGeneration: z.uuid(),
    requestedBy: z.enum(['link', 'manual']),
  })
  .strict();

export type KilterUserSyncPayload = z.infer<typeof kilterUserSyncPayload>;

/**
 * Sync one climber's Kilter logbook right after they link it, or when they tap
 * "Sync now". Same fences as `aurora-user-sync`. The Keycloak token refresh
 * runs unfenced on the worker's pool, exactly as the daemon does it: its own
 * transaction holds the credential row `FOR UPDATE` across the Keycloak call
 * (up to 30 s), so rotating refresh tokens are read and written under one lock.
 * The catalog sync is left to its own schedule.
 */
export const kilterUserSyncFamily: BackgroundJobFamilyModule<KilterUserSyncPayload> = {
  name: 'kilter-user-sync',
  roles: ['interactive-import'],
  options: {
    expireInSeconds: 1800,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
    deadlineSeconds: 7200,
    // A fenced batch holds the run-row lock, so no heartbeat lands while one
    // runs, and pg-boss fails the job at heartbeat_on + this. That makes it
    // the ceiling on one batch: a first sync's biggest (one Aurora page or one
    // 500-op Kilter flush, plus its stats recompute, or all circuits at once)
    // over a homelab-to-Railway link must finish inside it.
    heartbeatSeconds: 300,
  },
  payload: kilterUserSyncPayload,
  singletonKey: (payload) => `${payload.userId}:${payload.boardType}:${payload.linkGeneration}`,
  async execute(context, payload) {
    // Loaded here, not at module scope: the registry is imported on every
    // backend, operator and worker boot, and the sync runners pull in the
    // whole provider stack that only this family's worker ever runs.
    const { SyncRunner, syncableKilterCredentialsFilter } = await import('@boardsesh/kilter-sync/runner');
    await runProviderSync(context, payload, {
      candidateFilter: syncableKilterCredentialsFilter(),
      async sync(credential, transaction) {
        const runner = new SyncRunner({
          db: context.database,
          onLog: (message) => logger.debug(message, { runId: context.runId, family: context.family }),
          onError: () => {},
        });
        return runner.runCycleForCredential(context.database, credential, {
          transaction,
          signal: context.signal,
          skipCatalogSync: true,
        });
      },
    });
  },
};
