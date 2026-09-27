import { z } from 'zod';
import { claimNextCredentialForSync } from '@boardsesh/db/queries';
import { logger } from '../../utils/logger';
import { routineCycleLimits } from '../config';
import { loadProviderSyncAdapter, runRoutineCredentialSync, type SyncProvider } from './provider-sync-batch';
import type { BackgroundJobFamilyModule } from './types';

const ROUTINE_PROVIDERS = ['aurora', 'kilter'] as const satisfies readonly SyncProvider[];

const providerRoutineCyclePayload = z.object({ provider: z.enum(ROUTINE_PROVIDERS) }).strict();

export type ProviderRoutineCyclePayload = z.infer<typeof providerRoutineCyclePayload>;

/** Why a cycle stopped claiming. Logged, never an error: every one of these is a successful run. */
export type RoutineCycleStop = 'MAX_CREDENTIALS' | 'BUDGET' | 'NO_CREDENTIALS' | 'PROVIDER_THROTTLED' | 'ABORTED';

/**
 * The daemons' routine sync, as a bounded job: every 5 minutes, per provider,
 * claim and sync the next due credentials until one of
 *
 * - `ROUTINE_CYCLE_MAX_CREDENTIALS` (default 4) have been attempted,
 * - `ROUTINE_CYCLE_BUDGET_MS` (default 180 000) has passed (checked before each
 *   claim; a started credential finishes),
 * - no credential is due, or
 * - the provider throttled us (429 with `Retry-After`): that credential's
 *   attempt clock is pushed out by the delay and the cycle ends early with a
 *   logged `PROVIDER_THROTTLED`.
 *
 * The claim is the daemon's (`claimNextCredentialForSync`: fairness by attempt
 * clock, failure backoff, the 30 s reclaim gap) plus `excludeLeased`, run inside
 * the attempt fence so a run gone stale cannot stamp an attempt clock. Each
 * credential then syncs through the same fences and adapter as a first-link
 * sync (provider-sync-batch.ts). A credential's own failure (bad password,
 * provider down, relinked mid-sync) is recorded on the credential and never
 * fails the run; only a database or queue error, an abort or a lost attempt
 * does. The run never retries: the next cycle is 5 minutes away.
 *
 * Capacity: 4 credentials a cycle, 12 cycles an hour, is 48 credentials an hour
 * per provider, about 10x the daemon's one per 1-15 minutes, on the worker's
 * fixed 2 + 1 connections.
 */
export const providerRoutineCycleFamily: BackgroundJobFamilyModule<ProviderRoutineCyclePayload> = {
  name: 'provider-routine-cycle',
  roles: ['routine-provider'],
  options: {
    // The soft budget (at most 400 s, default 180 s) plus one credential's sync
    // must fit in this lease; the signal aborts at it.
    expireInSeconds: 600,
    retryLimit: 0,
    retryDelay: 0,
    // pg-boss accepts retryDelayMax only with backoff on; with no retries
    // neither matters.
    retryBackoff: true,
    retryDelayMax: 0,
    deadlineSeconds: 900,
    // One fenced batch (an Aurora page, a 500-op Kilter flush, a 500-key stats
    // recompute) must finish inside this window: it holds the run-row lock, so
    // no heartbeat lands while it runs.
    heartbeatSeconds: 300,
  },
  payload: providerRoutineCyclePayload,
  // One queued plus one running cycle per provider: a slow cycle never piles up
  // more than one successor.
  singletonKey: (payload) => payload.provider,
  schedules: [
    {
      key: 'every-5-min',
      cron: '*/5 * * * *',
      fanOut: async () => ROUTINE_PROVIDERS.map((provider) => ({ payload: { provider } })),
    },
  ],
  async execute(context, payload) {
    const limits = routineCycleLimits();
    const adapter = await loadProviderSyncAdapter(context, payload.provider);
    const startedAt = Date.now();
    const tally = { synced: 0, failed: 0, skipped: 0 };
    let attempted = 0;
    let stop: RoutineCycleStop = 'MAX_CREDENTIALS';
    while (attempted < limits.maxCredentials) {
      if (context.signal.aborted) {
        stop = 'ABORTED';
        break;
      }
      if (Date.now() - startedAt >= limits.budgetMs) {
        stop = 'BUDGET';
        break;
      }
      const credential = await context.transaction((transaction) =>
        claimNextCredentialForSync(transaction, { candidateFilter: adapter.candidateFilter, excludeLeased: true }),
      );
      if (!credential) {
        stop = 'NO_CREDENTIALS';
        break;
      }
      attempted += 1;
      const outcome = await runRoutineCredentialSync(context, credential, adapter);
      tally[outcome.result] += 1;
      if (outcome.reason) {
        logger.info('[worker] routine credential skipped', {
          runId: context.runId,
          provider: payload.provider,
          code: outcome.reason,
        });
      }
      if (outcome.retryAfterMs !== undefined) {
        logger.warn('[worker] routine cycle throttled', {
          runId: context.runId,
          provider: payload.provider,
          code: 'PROVIDER_THROTTLED',
          retryAfterMs: outcome.retryAfterMs,
        });
        stop = 'PROVIDER_THROTTLED';
        break;
      }
    }
    logger.info('[worker] routine cycle finished', {
      runId: context.runId,
      provider: payload.provider,
      stop,
      attempted,
      ...tally,
      elapsedMs: Date.now() - startedAt,
    });
  },
};
