import { z } from 'zod';
import { SyncRunner, syncableKilterCredentialsFilter } from '@boardsesh/kilter-sync/runner';
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
 * runs unfenced on the worker's pool, in its own short `FOR UPDATE`
 * transaction, exactly as the daemon does it; the catalog sync is left to its
 * own schedule.
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
    // runs, and a batch longer than this loses its attempt. A first sync's
    // biggest batch (one Aurora page, one 500-op Kilter flush, all circuits at
    // once) runs over a homelab-to-Railway link; 120 s leaves room for it.
    heartbeatSeconds: 120,
  },
  payload: kilterUserSyncPayload,
  singletonKey: (payload) => `${payload.userId}:${payload.boardType}:${payload.linkGeneration}`,
  async execute(context, payload) {
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
