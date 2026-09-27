/**
 * Backend-owned schedules for background job families (docs/background-workers.md).
 *
 * - **Opt-in per family.** `BATCH_FAMILIES_ENABLED` is a comma list of family
 *   names. Unset or empty registers nothing, so shipping a family's code never
 *   starts its cron; an unknown name refuses to start instead of guessing.
 * - **One trigger queue.** Each family schedule is a pg-boss schedule on
 *   `background-schedule` keyed `<family>:<key>`, carrying `{ family, key }`.
 *   Disabling a family removes its schedules on the next boot.
 * - **The backend fans out, workers execute.** The trigger handler runs the
 *   schedule's `fanOut` here and enqueues one family job per result onto the
 *   role's stately queue. Workers never register schedules: their queue client
 *   is built with `schedule: false`.
 */
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { DbInstance } from '@boardsesh/db/client';
import {
  BACKGROUND_JOB_FAMILIES,
  BACKGROUND_SCHEDULE_QUEUE,
  isBackgroundJobFamily,
  type BackgroundJobFamily,
} from '@boardsesh/db/background-jobs';
import { allFamilies, findFamily } from '../workers/families';
import { enqueueBackgroundJob } from '../workers/jobs';
import { logger } from '../utils/logger';

export function enabledBatchFamilies(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BackgroundJobFamily[] {
  const names = (environment.BATCH_FAMILIES_ENABLED ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !isBackgroundJobFamily(name));
  if (unknown.length) {
    throw new Error(
      `BATCH_FAMILIES_ENABLED names unknown families (${unknown.join(', ')}); known: ${BACKGROUND_JOB_FAMILIES.join(', ')}`,
    );
  }
  return [...new Set(names.filter(isBackgroundJobFamily))];
}

export function scheduleKey(family: string, key: string): string {
  return `${family}:${key}`;
}

const scheduleTickPayload = z.object({ family: z.string().min(1), key: z.string().min(1) }).strict();

/** Handle one schedule tick: fan out, then enqueue each result. Exported for tests. */
export async function runScheduleTick(
  boss: PgBoss,
  database: DbInstance,
  enabledFamilies: ReadonlySet<string>,
  tickData: unknown,
): Promise<{ enqueued: number; alreadyQueued: number; failed: number }> {
  const summary = { enqueued: 0, alreadyQueued: 0, failed: 0 };
  const parsedTick = scheduleTickPayload.safeParse(tickData);
  if (!parsedTick.success) {
    logger.warn('[batch-schedules] tick ignored', { code: 'INVALID_TICK' });
    return summary;
  }
  const { family: familyName, key } = parsedTick.data;
  const family = findFamily(familyName);
  const schedule = family?.schedules?.find((candidate) => candidate.key === key);
  // A tick can outlive its schedule: pg-boss may already hold a job created
  // before this boot unscheduled the family.
  if (!family || !schedule || !enabledFamilies.has(family.name)) {
    logger.warn('[batch-schedules] tick ignored', { code: 'SCHEDULE_DISABLED', family: familyName, key });
    return summary;
  }
  // A fan-out failure throws so pg-boss retries the tick; nothing was enqueued yet.
  const requests = await schedule.fanOut(database);
  for (const request of requests) {
    try {
      const accepted = await enqueueBackgroundJob(database, boss, {
        family: family.name,
        payload: request.payload,
        singletonKey: request.singletonKey,
      });
      if (accepted.alreadyQueued) summary.alreadyQueued++;
      else summary.enqueued++;
    } catch {
      // One bad request must not starve the rest, and retrying the tick would
      // duplicate every job that did enqueue under a run-ID key.
      summary.failed++;
    }
  }
  logger.info('[batch-schedules] tick fanned out', { family: family.name, key, ...summary });
  return summary;
}

export async function startBatchSchedules(
  boss: PgBoss,
  database: DbInstance,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  // Validate before touching pg-boss so a typo never half-applies.
  const enabledFamilies = new Set<string>(enabledBatchFamilies(environment));
  const enabledKeys = new Set<string>();
  for (const family of allFamilies()) {
    for (const schedule of family.schedules ?? []) {
      const key = scheduleKey(family.name, schedule.key);
      if (enabledFamilies.has(family.name)) {
        enabledKeys.add(key);
        await boss.schedule(
          BACKGROUND_SCHEDULE_QUEUE,
          schedule.cron,
          { family: family.name, key: schedule.key },
          { key, tz: schedule.tz ?? 'UTC', missed: 'once' },
        );
      } else {
        await boss.unschedule(BACKGROUND_SCHEDULE_QUEUE, key);
      }
    }
  }
  // Also drop schedules whose family or key no longer exists in code.
  for (const existing of await boss.getSchedules(BACKGROUND_SCHEDULE_QUEUE)) {
    if (!enabledKeys.has(existing.key)) await boss.unschedule(BACKGROUND_SCHEDULE_QUEUE, existing.key);
  }
  // With nothing enabled there is nothing to fan out: no poller, no behaviour change.
  if (!enabledFamilies.size) return;
  await boss.work(BACKGROUND_SCHEDULE_QUEUE, { localConcurrency: 1, batchSize: 1 }, async ([job]) => {
    if (job) await runScheduleTick(boss, database, enabledFamilies, job.data);
  });
  logger.info('[batch-schedules] started', { families: [...enabledFamilies], schedules: enabledKeys.size });
}
