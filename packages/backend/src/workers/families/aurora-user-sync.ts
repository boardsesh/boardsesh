import { z } from 'zod';
import { SyncRunner, syncableAuroraCredentialsFilter } from '@boardsesh/aurora-sync/runner';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { logger } from '../../utils/logger';
import { runProviderSync } from './provider-sync-batch';
import type { BackgroundJobFamilyModule } from './types';

/** Every Aurora board this family syncs. Kilter has its own family and OAuth flow. */
export const AURORA_USER_SYNC_BOARDS = AURORA_BOARDS.filter(
  (board): board is Exclude<(typeof AURORA_BOARDS)[number], 'kilter'> => board !== 'kilter',
);

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
    requestedBy: z.enum(['link', 'manual']),
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
    heartbeatSeconds: 30,
  },
  payload: auroraUserSyncPayload,
  // The generation is part of the key: a relink queues its own run instead of
  // being deduplicated onto the old generation's run, which would only fail.
  singletonKey: (payload) => `${payload.userId}:${payload.boardType}:${payload.linkGeneration}`,
  async execute(context, payload) {
    await runProviderSync(context, payload, {
      candidateFilter: syncableAuroraCredentialsFilter(),
      async sync(credential, transaction) {
        const runner = new SyncRunner({
          db: context.database,
          transaction,
          signal: context.signal,
          onLog: (message) => logger.debug(message, { runId: context.runId, family: context.family }),
          // The outcome carries the failure; the message can hold provider
          // detail, so only the bounded code reaches the ledger.
          onError: () => {},
        });
        return runner.syncCredential(credential, { skipSharedSync: true });
      },
    });
  },
};
