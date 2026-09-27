import { z } from 'zod';
import { claimNextCredentialForSync } from '@boardsesh/db/queries';
import { logger } from '../../utils/logger';
import { routineCycleLimits } from '../config';
import { AURORA_SHARED_SYNC_DEADLINE_SECONDS } from './aurora-shared-sync';
import {
  ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS,
  loadProviderSyncAdapter,
  runRoutineCredentialSync,
  type SyncProvider,
} from './provider-sync-batch';
import type { BackgroundJobFamilyModule } from './types';

const ROUTINE_PROVIDERS = ['aurora', 'kilter'] as const satisfies readonly SyncProvider[];

const providerRoutineCyclePayload = z.object({ provider: z.enum(ROUTINE_PROVIDERS) }).strict();

export type ProviderRoutineCyclePayload = z.infer<typeof providerRoutineCyclePayload>;

/** Why a cycle stopped claiming. Logged, never an error: every one of these is a successful run. */
export type RoutineCycleStop =
  | 'MAX_CREDENTIALS'
  | 'BUDGET'
  | 'NO_CREDENTIALS'
  | 'PROVIDER_THROTTLED'
  | 'CYCLE_DEADLINE'
  | 'CYCLE_DEADLINE_NEAR'
  | 'ABORTED';

/**
 * The daemons' routine sync, as a bounded job: every 5 minutes, per provider,
 * claim and sync the next due credentials until one of
 *
 * - `ROUTINE_CYCLE_MAX_CREDENTIALS` (default 4) have been attempted (synced,
 *   failed or handed to the interactive family; a skip does not count),
 * - `ROUTINE_CYCLE_BUDGET_MS` (default 120 000) has passed (checked before each
 *   claim; a started credential finishes),
 * - no credential is due, or
 * - the provider throttled us (429 with `Retry-After`): that credential is
 *   held until `provider_retry_after_until` and the cycle ends early with a
 *   logged `PROVIDER_THROTTLED`.
 *
 * The claim is the daemon's (`claimNextCredentialForSync`: fairness by attempt
 * clock, failure backoff, the 30 s reclaim gap) plus `excludeLeased`, run inside
 * the attempt fence so a run gone stale cannot stamp an attempt clock. Each
 * credential then syncs through the same fences and adapter as a first-link
 * sync (provider-sync-batch.ts), under a deadline one minute before the lease
 * ends (hitting it records a transient `CYCLE_DEADLINE` failure and ends the
 * cycle). An account that has never synced is handed to its interactive family
 * (a 30-minute lease) instead of synced here. A credential's own failure (bad password,
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
    // The soft budget (at most and by default 120 s) plus one credential's sync
    // must fit in this lease; the signal aborts at it.
    expireInSeconds: 600,
    retryLimit: 0,
    retryDelay: 0,
    // pg-boss accepts retryDelayMax only with backoff on; with no retries
    // neither matters.
    retryBackoff: true,
    retryDelayMax: 0,
    // Much longer than the lease on purpose: one routine-provider worker runs
    // one job at a time, and the :07 fan-out queues an aurora-shared-sync run per
    // Aurora board (plus the Kilter catalog at :23) at the cycle's own
    // priority, each with a 3600 s lease. A cycle queued behind them waits for all of them; with a
    // shorter deadline it would expire at claim and later ticks would coalesce
    // onto the doomed holder. The same full-fan-out budget as the shared sync.
    deadlineSeconds: AURORA_SHARED_SYNC_DEADLINE_SECONDS,
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
    // Started with under a minute of lease left: not even one credential could
    // run. End at once, before loading the provider adapter or claiming.
    if (context.expiresAt - Date.now() < ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS) {
      logger.info('[worker] routine cycle skipped', {
        runId: context.runId,
        provider: payload.provider,
        code: 'CYCLE_LATE',
      });
      return;
    }
    const limits = routineCycleLimits();
    const adapter = await loadProviderSyncAdapter(context, payload.provider);
    const startedAt = Date.now();
    const tally = { synced: 0, failed: 0, skipped: 0, queued: 0 };
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
      // Less than the one-minute deadline margin left on the lease: a claimed
      // credential could not even start. Stop before claiming, so no attempt
      // clock is stamped for a sync that never runs.
      if (context.expiresAt - Date.now() <= ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS) {
        stop = 'CYCLE_DEADLINE_NEAR';
        break;
      }
      const credential = await context.transaction((transaction) =>
        claimNextCredentialForSync(transaction, { candidateFilter: adapter.candidateFilter, excludeLeased: true }),
      );
      if (!credential) {
        stop = 'NO_CREDENTIALS';
        break;
      }
      const outcome = await runRoutineCredentialSync(context, credential, adapter);
      tally[outcome.result] += 1;
      // Only a credential the provider was (or will be) asked about counts
      // toward the limit: a skip (busy, relinked, out of lease) called no one.
      // The loop still ends, on the budget or when no credential is due.
      if (outcome.result !== 'skipped') attempted += 1;
      if (outcome.reason === 'CYCLE_DEADLINE_NEAR') {
        logger.warn('[worker] routine credential skipped near the cycle deadline', {
          runId: context.runId,
          provider: payload.provider,
          code: 'CYCLE_DEADLINE_NEAR',
        });
        stop = 'CYCLE_DEADLINE_NEAR';
        break;
      }
      if (outcome.reason === 'CYCLE_DEADLINE') {
        // The lease is nearly spent: claiming another credential could only
        // end the same way.
        logger.warn('[worker] routine credential stopped at the cycle deadline', {
          runId: context.runId,
          provider: payload.provider,
          code: 'CYCLE_DEADLINE',
        });
        stop = 'CYCLE_DEADLINE';
        break;
      }
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
