import { z } from 'zod';
import { logger } from '../../utils/logger';
import { boundedErrorFields } from './job-logging';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const kilterCatalogSyncPayload = z.object({}).strict();

export type KilterCatalogSyncPayload = z.infer<typeof kilterCatalogSyncPayload>;

/** As `AURORA_SHARED_SYNC_COOLDOWN_MS`: under the hourly cron, so the end-of-run stamp never skips a tick. */
export const KILTER_CATALOG_SYNC_COOLDOWN_MS = 50 * 60 * 1000;

/**
 * The Kilter daemon's catalog piggyback, on its own schedule: the full Kilter
 * catalog (climbs, stats, aliases, locations, deletions applied as the daemon
 * applies them), then the weekly stats repair and weekly history snapshot, each
 * behind its own 7-day cursor in `board_shared_syncs`.
 *
 * The token comes from the most recently successful linked Kilter account
 * (refreshed exactly as a user sync refreshes it, in its own `FOR UPDATE`
 * transaction), else the `KILTER_TEST_USERNAME`/`KILTER_TEST_PASSWORD` account.
 * The daemon's catalog cooldown slot keeps it to one writer: refused is a
 * logged `CATALOG_SYNC_COOLDOWN`, no token source a logged
 * `CATALOG_SYNC_NO_DONOR`, both successful runs with no work.
 *
 * Unlike the Aurora shared sync, the catalog's writes are not behind the
 * attempt fence: the catalog interleaves Kilter requests with its writes per
 * layout, and the cooldown claim is the single-writer guarantee, as it is for
 * the daemon. The signal stops it between layout groups; Kilter's REST client
 * honours Retry-After on its own.
 */
export const kilterCatalogSyncFamily: BackgroundJobFamilyModule<KilterCatalogSyncPayload> = {
  name: 'kilter-catalog-sync',
  roles: ['routine-provider'],
  options: {
    expireInSeconds: 3600,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 300,
    deadlineSeconds: 7200,
    heartbeatSeconds: 300,
  },
  payload: kilterCatalogSyncPayload,
  singletonKey: () => 'kilter',
  schedules: [{ key: 'hourly', cron: '23 * * * *', fanOut: async () => [{ payload: {} }] }],
  async execute(context) {
    // Loaded here, not at module scope; see loadProviderSyncAdapter.
    const [{ SyncRunner }, { KilterApiError, isTransientKilterError }] = await Promise.all([
      import('@boardsesh/kilter-sync/runner'),
      import('@boardsesh/kilter-sync/api'),
    ]);
    const runner = new SyncRunner({
      db: context.database,
      signal: context.signal,
      onLog: (message) => logger.debug(message, { runId: context.runId, family: context.family }),
      // A step the runner swallows (a crawl, the weekly repair) still leaves a
      // trace: the error's class and SQLSTATE, never its message.
      onError: (error) =>
        logger.warn('[worker] catalog sync step failed', {
          runId: context.runId,
          family: context.family,
          ...boundedErrorFields(error),
        }),
    });
    const logContext = { runId: context.runId, family: context.family };
    let result;
    try {
      result = await runner.runCatalogSyncJob({
        signal: context.signal,
        cooldownMs: KILTER_CATALOG_SYNC_COOLDOWN_MS,
      });
    } catch (error) {
      if (context.signal.aborted || !(error instanceof KilterApiError)) throw error;
      if (isTransientKilterError(error)) throw new BackgroundJobError('PROVIDER_UNAVAILABLE');
      throw new BackgroundJobError('CATALOG_SYNC_FAILED', { retryable: false });
    }
    if (result.status === 'cooldown') {
      logger.info('[worker] catalog sync skipped', {
        ...logContext,
        code: 'CATALOG_SYNC_COOLDOWN',
        lastRunAt: result.lastRunAt?.toISOString() ?? null,
      });
    } else if (result.status === 'no_donor') {
      logger.warn('[worker] catalog sync skipped', { ...logContext, code: 'CATALOG_SYNC_NO_DONOR' });
    } else {
      logger.info('[worker] catalog sync finished', { ...logContext, tokenSource: result.tokenSource });
    }
  },
};
