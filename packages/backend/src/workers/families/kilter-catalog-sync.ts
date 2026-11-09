import { z } from 'zod';
import { logger } from '../../utils/logger';
import { boundedErrorFields } from './job-logging';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';
import { BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS, KILTER_CATALOG_SYNC_BUDGET } from './fan-out-budget';

const kilterCatalogSyncPayload = z.object({ mode: z.enum(['auto', 'incremental', 'full']).optional() }).strict();

export type KilterCatalogSyncPayload = z.infer<typeof kilterCatalogSyncPayload>;

/** Under the quarter-hour schedule; queue waiting time is separate from execution. */
export const KILTER_CATALOG_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
export const KILTER_CATALOG_LEGACY_COOLDOWN_MS = 50 * 60 * 1000;

/** Kept off until baseline verification; rollback restores six-hour full imports. */
export function kilterCatalogIncrementalEnabled(): boolean {
  return process.env.KILTER_CATALOG_INCREMENTAL_ENABLED === 'true';
}

/**
 * Shared-worker catalog refresh. Rollout defaults to six-hour full imports;
 * KILTER_CATALOG_INCREMENTAL_ENABLED enables quarter-hour auto refreshes with
 * weekly full reconciliation and the existing weekly history snapshot.
 * Every import write uses both the worker attempt fence and the catalog writer
 * lease. Provider Retry-After parks the slot and donor without falling back to
 * a full download. Shared-worker waiting time can delay the scheduled tick.
 */
export const kilterCatalogSyncFamily: BackgroundJobFamilyModule<KilterCatalogSyncPayload> = {
  name: 'kilter-catalog-sync',
  roles: ['routine-provider'],
  options: {
    expireInSeconds: KILTER_CATALOG_SYNC_BUDGET.expireInSeconds,
    retryLimit: KILTER_CATALOG_SYNC_BUDGET.retryLimit,
    retryDelay: KILTER_CATALOG_SYNC_BUDGET.retryDelay,
    retryBackoff: true,
    retryDelayMax: KILTER_CATALOG_SYNC_BUDGET.retryDelay,
    // Each tick can wait behind every hour-long :07 shared sync on
    // the one-at-a-time worker at the same priority: the full-fan-out
    // budget (fan-out-budget.ts), so it runs late instead of expiring at claim.
    deadlineSeconds: BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS,
    // Equal to the routine cycle, so FIFO order keeps it from waiting behind
    // an endless stream of cycles (docs/background-workers.md, "Queue share").
    priority: 0,
    heartbeatSeconds: 300,
  },
  payload: kilterCatalogSyncPayload,
  singletonKey: () => 'kilter',
  // Keep both registrations stable across flag changes; only one emits work.
  schedules: [
    {
      key: 'every-6h',
      cron: '23 */6 * * *',
      fanOut: async () => (kilterCatalogIncrementalEnabled() ? [] : [{ payload: {} }]),
    },
    {
      key: 'every-15m',
      cron: '8,23,38,53 * * * *',
      fanOut: async () => (kilterCatalogIncrementalEnabled() ? [{ payload: {} }] : []),
    },
  ],
  async execute(context, payload) {
    // Loaded here, not at module scope; see loadProviderSyncAdapter.
    const [{ SyncRunner }, { DonorRelinkedError, KilterApiError, isTransientKilterError }] = await Promise.all([
      import('@boardsesh/kilter-sync/runner'),
      import('@boardsesh/kilter-sync/api'),
    ]);
    const runner = new SyncRunner({
      db: context.database,
      signal: context.signal,
      onLog: (message) => logger.debug(message, { runId: context.runId, family: context.family }),
      onCatalogMetrics: (metrics) =>
        logger.info('[worker] catalog sync metrics', {
          runId: context.runId,
          family: context.family,
          queueDelayMs: context.queueDelayMs ?? null,
          ...metrics,
        }),
      onCatalogPhase: (progress) =>
        logger.info('[worker] catalog sync phase', {
          runId: context.runId,
          family: context.family,
          queueDelayMs: context.queueDelayMs ?? null,
          ...progress,
        }),
      // A step the runner swallows (a location crawl or history snapshot) still leaves a
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
        transaction: context.transaction,
        cooldownMs: kilterCatalogIncrementalEnabled()
          ? KILTER_CATALOG_SYNC_COOLDOWN_MS
          : KILTER_CATALOG_LEGACY_COOLDOWN_MS,
        mode: payload.mode ?? 'auto',
        // A retry of this run re-claims the slot this run left claimed.
        runId: context.runId,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      // The borrowed donor was relinked mid-run: its token is the new link's
      // now. Retry, and the next attempt picks a donor afresh.
      if (error instanceof DonorRelinkedError) throw new BackgroundJobError('DONOR_RELINKED');
      if (!(error instanceof KilterApiError)) throw error;
      if (error.retryAfterMs !== undefined) {
        // Kilter asked us to wait: the runner closed the slot and held the
        // donor for that long, so a pg-boss retry minutes from now could only
        // find the slot closed. The next scheduled tick after the hold runs it.
        logger.warn('[worker] catalog sync throttled', {
          runId: context.runId,
          family: context.family,
          code: 'PROVIDER_THROTTLED',
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }
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
