import { z } from 'zod';
import { computeSprayWallHealth, SprayWallHealthInputError } from '@boardsesh/db/jobs';
import { captureBackendEvent } from '../../services/analytics/posthog';
import {
  buildSprayWallHealthProperties,
  SPRAY_WALL_HEALTH_EVENT,
  sprayWallHealthDistinctId,
} from '../../services/analytics/wall-health-events';
import { jobLogger } from './batch-job';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

/**
 * Weekly spray-wall health roll-up (issue #6062).
 *
 * Measures the fleet's walls straight off the app tables — stock, activity,
 * second-climber reach, degradation, resets, reports — and emits ONE
 * personless `Spray Wall Health Weekly` PostHog event. Nothing is written to
 * the database; the event is the artifact, and the dashboard it feeds is the
 * reporting target (`docs/growth-metrics.md`).
 *
 * Timing: Monday 08:45 UTC, ten minutes after the last angle-estimate job and
 * comfortably inside the same morning, measuring the week that just ENDED.
 * `weekStart` (an ISO Monday) re-measures an older week — the dedup key rides
 * it, so a backfill is its own run rather than being swallowed by the
 * singleton, and a rejected value fails fast and non-retryable.
 */
const payload = z
  .object({
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

export const sprayWallHealthFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'spray-wall-health',
  roles: ['batch'],
  options: {
    // One read-only sweep of small aggregate queries; the lease is generous
    // for a cold database, and the deadline is the weekly six-day ceiling.
    expireInSeconds: 600,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 600,
    deadlineSeconds: 518_400,
    heartbeatSeconds: 300,
  },
  payload,
  singletonKey: ({ weekStart }) => weekStart ?? 'weekly',
  schedules: [{ key: 'weekly', cron: '45 8 * * 1', fanOut: async () => [{ payload: { dryRun: false } }] }],
  async execute(context, { weekStart, dryRun }) {
    const log = jobLogger(context);
    let run;
    try {
      run = await computeSprayWallHealth({ db: context.database, signal: context.signal, weekStart });
    } catch (error) {
      if (error instanceof SprayWallHealthInputError)
        throw new BackgroundJobError('WEEK_START_INVALID', { retryable: false });
      throw error;
    }
    if (dryRun) {
      log.info(`spray-wall-health dry-run ${run.weekStart}: ${JSON.stringify(run.metrics)}`);
      return;
    }
    const captured = captureBackendEvent(SPRAY_WALL_HEALTH_EVENT, {
      distinctId: sprayWallHealthDistinctId(run.weekStart),
      processPersonProfile: false,
      properties: buildSprayWallHealthProperties(run.weekStart, run.metrics),
    });
    // A false here is analytics disabled (dev, no key, non-production env):
    // the week measured itself, the run succeeds regardless.
    log.info(
      captured
        ? `spray-wall-health emitted ${run.weekStart}`
        : `spray-wall-health measured ${run.weekStart}; analytics disabled, nothing emitted`,
    );
  },
};
