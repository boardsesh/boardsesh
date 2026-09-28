import { z } from 'zod';
import { providerSyncUserId } from './aurora-user-sync';
import { loadProviderSyncAdapter, runProviderSync } from './provider-sync-batch';
import type { BackgroundJobFamilyModule } from './types';

const kilterUserSyncPayload = z
  .object({
    userId: providerSyncUserId,
    boardType: z.literal('kilter'),
    linkGeneration: z.uuid(),
    requestedBy: z.enum(['link', 'manual', 'routine']),
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
    // the ceiling on one batch: a first sync's biggest (one Aurora page, one
    // 500-op Kilter flush or all circuits at once; the stats recompute runs
    // after each, in batches of at most 500 keys) over a homelab-to-Railway
    // link must finish inside it.
    heartbeatSeconds: 300,
  },
  payload: kilterUserSyncPayload,
  singletonKey: (payload) => `${payload.userId}:${payload.boardType}:${payload.linkGeneration}`,
  async execute(context, payload) {
    await runProviderSync(context, payload, await loadProviderSyncAdapter(context, 'kilter'));
  },
};
