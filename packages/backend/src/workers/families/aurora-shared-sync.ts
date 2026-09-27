import { z } from 'zod';
import { logger } from '../../utils/logger';
import { boundedErrorFields } from './job-logging';
import { AURORA_USER_SYNC_BOARDS } from './aurora-user-sync';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const auroraSharedSyncPayload = z.object({ board: z.enum(AURORA_USER_SYNC_BOARDS) }).strict();

export type AuroraSharedSyncPayload = z.infer<typeof auroraSharedSyncPayload>;

/**
 * The claim this job makes on the board's `board_shared_syncs` cooldown slot.
 * Shorter than the daemon's hour on purpose: the slot is re-stamped when a run
 * ENDS, so a 60-minute cooldown against an hourly cron would refuse every other
 * tick and halve the cadence. 50 minutes keeps one run an hour and still turns
 * away a second writer (the daemon during a botched cutover, a replayed run).
 */
export const AURORA_SHARED_SYNC_COOLDOWN_MS = 50 * 60 * 1000;

/**
 * The board-wide half of the Aurora daemon, on its own schedule: products,
 * layouts, climbs, climb stats and beta links from Aurora's shared `/sync`, the
 * weekly stats history snapshot, and for gym boards the public locations plus
 * one slice of the gym-wall crawl (docs/aurora-location-sync.md).
 *
 * It borrows a token from the board's most recently successful linked account
 * (stored token first, a login with its password as the fallback) and never
 * records anything against that account. The daemon's `board_shared_syncs`
 * cooldown slot keeps it to one writer per board: a refused claim succeeds as a
 * logged `SHARED_SYNC_COOLDOWN` with no work, and a board with no healthy
 * account succeeds as a logged `SHARED_SYNC_NO_DONOR`. Every board-wide write
 * batch (one per Aurora page, one per 25 gyms) goes through the attempt fence;
 * there is no user generation to check.
 */
export const auroraSharedSyncFamily: BackgroundJobFamilyModule<AuroraSharedSyncPayload> = {
  name: 'aurora-shared-sync',
  roles: ['routine-provider'],
  options: {
    expireInSeconds: 3600,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 300,
    deadlineSeconds: 7200,
    // One Aurora page (up to ~2000 records with its climb_stats upsert) or one
    // 25-gym location batch holds the run-row lock at a time.
    heartbeatSeconds: 300,
    // Board-wide upkeep yields to the routine cycle on the shared queue.
    priority: -5,
  },
  payload: auroraSharedSyncPayload,
  singletonKey: (payload) => payload.board,
  schedules: [
    {
      key: 'hourly',
      cron: '7 * * * *',
      fanOut: async () => AURORA_USER_SYNC_BOARDS.map((board) => ({ payload: { board } })),
    },
  ],
  async execute(context, payload) {
    // Loaded here, not at module scope; see loadProviderSyncAdapter.
    const [{ SyncRunner }, { isAuroraRequestError, isTransientSharedSyncAuroraError }] = await Promise.all([
      import('@boardsesh/aurora-sync/runner'),
      import('@boardsesh/aurora-sync/api'),
    ]);
    const runner = new SyncRunner({
      db: context.database,
      signal: context.signal,
      onLog: (message) => logger.debug(message, { runId: context.runId, family: context.family }),
      // A step the runner swallows (a crawl, the weekly repair) still leaves a
      // trace: the error's class and SQLSTATE, never its message.
      onError: (error) =>
        logger.warn('[worker] shared sync step failed', {
          runId: context.runId,
          family: context.family,
          ...boundedErrorFields(error),
        }),
    });
    const logContext = { runId: context.runId, family: context.family, board: payload.board };
    let result;
    try {
      result = await runner.runSharedSyncJob(payload.board, {
        transaction: context.transaction,
        signal: context.signal,
        cooldownMs: AURORA_SHARED_SYNC_COOLDOWN_MS,
      });
    } catch (error) {
      if (context.signal.aborted || !isAuroraRequestError(error)) throw error;
      // Aurora itself failed. A transport failure, a 429 or a 5xx is worth the
      // retry (the slot was re-stamped with the five-minute cooldown, by the
      // same classifier); anything else is not.
      if (isTransientSharedSyncAuroraError(error)) throw new BackgroundJobError('PROVIDER_UNAVAILABLE');
      throw new BackgroundJobError('SHARED_SYNC_FAILED', { retryable: false });
    }
    if (result.status === 'cooldown') {
      logger.info('[worker] shared sync skipped', {
        ...logContext,
        code: 'SHARED_SYNC_COOLDOWN',
        lastRunAt: result.lastRunAt?.toISOString() ?? null,
      });
    } else if (result.status === 'no_donor') {
      logger.warn('[worker] shared sync skipped', { ...logContext, code: 'SHARED_SYNC_NO_DONOR' });
    } else {
      logger.info('[worker] shared sync finished', { ...logContext, tokenSource: result.tokenSource });
    }
  },
};
