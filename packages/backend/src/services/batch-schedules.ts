/**
 * Backend-owned schedules for background job families (docs/background-workers.md).
 *
 * - **Opt-in per family.** `BATCH_FAMILIES_ENABLED` is a comma list of family
 *   names. Unset or empty registers nothing, so shipping a family's code never
 *   starts its cron; an unknown name removes every family schedule and throws
 *   instead of guessing.
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
import { allFamilies, findFamily, type BackgroundJobFamilyModule } from '../workers/families';
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

let requestPathFamilies: { raw: string | undefined; families: ReadonlySet<BackgroundJobFamily> } | null = null;

/**
 * `enabledBatchFamilies` for request paths (a link, "Sync now", the credential
 * status): never throws. An invalid `BATCH_FAMILIES_ENABLED` is an operator
 * typo, and it must not fail every credential request or roll back a valid
 * link; it disables every family here instead, exactly as boot leaves the
 * schedules unregistered. The validation error is logged once per value, and
 * the parse is memoised on the raw string so the hot status read does not
 * re-split it. Boot (`startBatchSchedules`) keeps the throwing variant.
 */
export function enabledBatchFamiliesOrNone(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<BackgroundJobFamily> {
  const raw = environment.BATCH_FAMILIES_ENABLED;
  if (requestPathFamilies && requestPathFamilies.raw === raw) return requestPathFamilies.families;
  let families: ReadonlySet<BackgroundJobFamily>;
  try {
    families = new Set(enabledBatchFamilies(environment));
  } catch (error) {
    logger.error('[batch-schedules] BATCH_FAMILIES_ENABLED is invalid; request paths treat every family as off', {
      error: error instanceof Error ? error.message : String(error),
    });
    families = new Set();
  }
  requestPathFamilies = { raw, families };
  return families;
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
        role: request.role ?? schedule.role,
      });
      if (accepted.alreadyQueued) summary.alreadyQueued++;
      else summary.enqueued++;
    } catch (error) {
      // One bad request must not starve the rest, and retrying the tick would
      // duplicate every job that did enqueue under a run-ID key. Log only a
      // bounded code: driver messages can carry SQL and payload values.
      summary.failed++;
      logger.warn('[batch-schedules] enqueue failed', {
        family: family.name,
        key,
        code: boundedErrorCode(error),
      });
    }
  }
  logger.info('[batch-schedules] tick fanned out', { family: family.name, key, ...summary });
  // Nothing enqueued, so a pg-boss retry of the tick cannot duplicate work.
  if (requests.length && summary.failed === requests.length) throw new Error('SCHEDULE_TICK_FAILED');
  return summary;
}

/** Our own errors are bare codes (`INVALID_PAYLOAD`); anything else is summarised. */
function boundedErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'ENQUEUE_FAILED';
}

/**
 * A schedule's jobs need one role. A family serving several roles must name it
 * on the schedule, so a misconfigured family fails at boot rather than on every
 * tick with FAMILY_ROLE_REQUIRED.
 */
export function assertScheduleRoles(family: BackgroundJobFamilyModule): void {
  for (const schedule of family.schedules ?? []) {
    const key = scheduleKey(family.name, schedule.key);
    if (schedule.role && !family.roles.includes(schedule.role)) {
      throw new Error(`Schedule ${key} names role ${schedule.role}, which family ${family.name} does not serve`);
    }
    if (!schedule.role && family.roles.length !== 1) {
      throw new Error(`Schedule ${key} must name a role: family ${family.name} serves ${family.roles.join(', ')}`);
    }
  }
}

/** Unschedule every family key on the trigger queue except `keepKeys`, including keys no longer in code. */
async function sweepSchedules(boss: PgBoss, keepKeys: ReadonlySet<string>): Promise<void> {
  const registeredKeys = allFamilies().flatMap((family) =>
    (family.schedules ?? []).map((schedule) => scheduleKey(family.name, schedule.key)),
  );
  const existingKeys = (await boss.getSchedules(BACKGROUND_SCHEDULE_QUEUE)).map((existing) => existing.key);
  for (const key of new Set([...registeredKeys, ...existingKeys])) {
    if (!keepKeys.has(key)) await boss.unschedule(BACKGROUND_SCHEDULE_QUEUE, key);
  }
}

export async function startBatchSchedules(
  boss: PgBoss,
  database: DbInstance,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  let enabledFamilies: Set<string>;
  try {
    enabledFamilies = new Set<string>(enabledBatchFamilies(environment));
    for (const family of allFamilies()) if (enabledFamilies.has(family.name)) assertScheduleRoles(family);
  } catch (error) {
    // A typo must not leave last boot's schedules firing into a queue nobody
    // consumes: remove them all, then let the caller log the error.
    await sweepSchedules(boss, new Set());
    throw error;
  }
  const enabledSchedules = allFamilies()
    .filter((family) => enabledFamilies.has(family.name))
    .flatMap((family) => (family.schedules ?? []).map((schedule) => ({ family, schedule })));
  const enabledKeys = new Set(enabledSchedules.map(({ family, schedule }) => scheduleKey(family.name, schedule.key)));
  await sweepSchedules(boss, enabledKeys);
  for (const { family, schedule } of enabledSchedules) {
    await boss.schedule(
      BACKGROUND_SCHEDULE_QUEUE,
      schedule.cron,
      { family: family.name, key: schedule.key },
      { key: scheduleKey(family.name, schedule.key), tz: schedule.tz ?? 'UTC', missed: 'once' },
    );
  }
  // With nothing enabled there is nothing to fan out: no poller, no behaviour change.
  if (!enabledFamilies.size) return;
  await boss.work(BACKGROUND_SCHEDULE_QUEUE, { localConcurrency: 1, batchSize: 1 }, async ([job]) => {
    if (job) await runScheduleTick(boss, database, enabledFamilies, job.data);
  });
  logger.info('[batch-schedules] started', { families: [...enabledFamilies], schedules: enabledKeys.size });
}
