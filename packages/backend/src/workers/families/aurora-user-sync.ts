import { z } from 'zod';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { loadProviderSyncAdapter, runProviderSync } from './provider-sync-batch';
import type { BackgroundJobFamilyModule } from './types';

/**
 * Every Aurora board this family syncs; Kilter has its own family and OAuth
 * flow. Spelled out rather than derived from `AURORA_BOARDS` so the registry,
 * which every backend and worker boot imports, never loads the shared-schema
 * barrel. families.test.ts pins it to `AURORA_BOARDS` minus Kilter.
 */
export const AURORA_USER_SYNC_BOARDS = [
  'tension',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
] as const satisfies ReadonlyArray<Exclude<AuroraBoardName, 'kilter'>>;

/**
 * `userId` is the `users.id` text key. New ids are UUIDs, but the column is
 * text, and a stricter schema here would turn a link into a failed enqueue for
 * any account whose id is not.
 */
export const providerSyncUserId = z.string().min(1).max(128);

const auroraUserSyncPayload = z
  .object({
    userId: providerSyncUserId,
    boardType: z.enum(AURORA_USER_SYNC_BOARDS),
    linkGeneration: z.uuid(),
    requestedBy: z.enum(['link', 'manual', 'routine']),
  })
  .strict();

export type AuroraUserSyncPayload = z.infer<typeof auroraUserSyncPayload>;

/**
 * Sync one climber's Aurora-family logbook (Tension, Decoy, …) right after
 * they link it, or when they tap "Sync now". Every write goes through the
 * provider sync fences (provider-sync-batch.ts); the board-wide shared sync is
 * left to its own schedule.
 */
export const auroraUserSyncFamily: BackgroundJobFamilyModule<AuroraUserSyncPayload> = {
  name: 'aurora-user-sync',
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
  payload: auroraUserSyncPayload,
  // The generation is part of the key: a relink queues its own run instead of
  // being deduplicated onto the old generation's run, which would only fail.
  singletonKey: (payload) => `${payload.userId}:${payload.boardType}:${payload.linkGeneration}`,
  async execute(context, payload) {
    await runProviderSync(context, payload, await loadProviderSyncAdapter(context, 'aurora'));
  },
};
