/**
 * Backfill historical ticks with the live session reconciler. Dry-run by default.
 *
 * Default mode counts non-overlapping reconciliation windows. --simulate reads the
 * actual grouping in read-only transactions. --apply commits one complete window at
 * a time and refuses plans that remove existing sessions or their social history.
 * Windows include whole UTC days and connected midnight-crossing runs; a window may
 * produce several sessions. See docs/inferred-sessions-backfill.md for rollout.
 *
 * vp exec tsx packages/backend/src/scripts/backfill-inferred-sessions.ts --user <id> --simulate
 * vp exec tsx packages/backend/src/scripts/backfill-inferred-sessions.ts --user <id> --apply
 */

import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { isReconciliationBoundary } from '@boardsesh/session-inference';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { closePool } from '@boardsesh/db/client';
import { parseClimbedAt } from '../services/inferred-sessions/timestamps';
import { db } from '../db/client';
import { planReconciliation, reconcileInferredSessions } from '../services/inferred-sessions/reconcile';
import { logger } from '../utils/logger';

export type Options = {
  apply: boolean;
  simulate: boolean;
  userId: string | null;
  limit: number | null;
  resumeFrom: string | null;
  delayMs: number;
  progressEvery: number;
};

export function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  const switches = new Set(['--apply', '--simulate']);
  const parameters = new Set(['--user', '--limit', '--resume-from', '--delay-ms', '--progress-every']);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    if (switches.has(flag)) {
      flags.set(flag, 'true');
    } else if (parameters.has(flag)) {
      const argument = argv[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`${flag} requires a value`);
      flags.set(flag, argument);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (flags.has('--apply') && flags.has('--simulate')) throw new Error('--apply and --simulate are mutually exclusive');
  if (flags.has('--user') && flags.has('--resume-from'))
    throw new Error('--user and --resume-from are mutually exclusive');
  if (flags.has('--user') && flags.has('--limit')) throw new Error('--user and --limit are mutually exclusive');
  const integer = (flag: string, fallback: number | null, minimum: number): number | null => {
    const argument = flags.get(flag);
    if (argument === undefined) return fallback;
    const parsed = Number(argument);
    if (!/^\d+$/.test(argument) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > 2147483647) {
      throw new Error(`${flag} must be an integer between ${minimum} and 2147483647`);
    }
    return parsed;
  };
  return {
    apply: flags.has('--apply'),
    simulate: flags.has('--simulate'),
    userId: flags.get('--user') ?? null,
    limit: integer('--limit', null, 0),
    resumeFrom: flags.get('--resume-from') ?? null,
    delayMs: integer('--delay-ms', 0, 0) ?? 0,
    progressEvery: integer('--progress-every', 100, 1) ?? 100,
  };
}

const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Climbers with at least one tick that belongs to no session, oldest id first.
 *
 * Ordering by user id rather than by volume is what makes `--resume-from` meaningful:
 * the sequence is stable across runs, so a stopped run resumes at a known point instead
 * of re-walking climbers it already finished.
 */
async function usersNeedingBackfill(options: Options): Promise<string[]> {
  if (options.userId) return [options.userId];

  const query = db
    .selectDistinct({ userId: dbSchema.boardseshTicks.userId })
    .from(dbSchema.boardseshTicks)
    .where(
      and(
        isNull(dbSchema.boardseshTicks.sessionId),
        options.resumeFrom ? gte(dbSchema.boardseshTicks.userId, options.resumeFrom) : undefined,
      ),
    )
    .orderBy(asc(dbSchema.boardseshTicks.userId));

  const rows = await (options.limit === null ? query : query.limit(options.limit));
  return rows.map((row) => row.userId);
}

/**
 * One timestamp per non-overlapping reconciliation window, from a climber's climb times in ascending order.
 *
 * Split only at a >4h gap across different UTC days. Same-day runs need to see
 * each other for lone-tick and explicit-session absorption. Midnight connections
 * bring the next whole day into the same window, so simulation never counts it twice.
 */
export function reconciliationStartTimestamps(ascendingClimbedAt: readonly number[]): number[] {
  const starts: number[] = [];
  let previous: number | null = null;
  for (const climbedAt of ascendingClimbedAt) {
    if (!Number.isFinite(climbedAt) || (previous !== null && climbedAt < previous)) {
      throw new Error('Climb timestamps must be finite and sorted in ascending order');
    }
    if (previous === null || isReconciliationBoundary(previous, climbedAt)) starts.push(climbedAt);
    previous = climbedAt;
  }
  return starts;
}

async function reconciliationStartsForUser(userId: string): Promise<Date[]> {
  const ticks = await db
    .select({ climbedAt: dbSchema.boardseshTicks.climbedAt })
    .from(dbSchema.boardseshTicks)
    .where(eq(dbSchema.boardseshTicks.userId, userId))
    .orderBy(asc(dbSchema.boardseshTicks.climbedAt), asc(dbSchema.boardseshTicks.id));

  return reconciliationStartTimestamps(ticks.map((tick) => parseClimbedAt(tick.climbedAt).getTime())).map(
    (epochMs) => new Date(epochMs),
  );
}

export async function runBackfill(options: Options): Promise<number> {
  // The live gate is an env var read at call time, and the backfill must not depend on
  // whether writes happen to be switched on for normal traffic. `--apply` is this
  // script's own gate; without it nothing below ever reaches a write.
  if (options.apply) process.env.INFERRED_SESSIONS_ENABLED = 'true';

  const userIds = await usersNeedingBackfill(options);
  logger.info(
    `[backfill-inferred-sessions] ${options.apply ? 'APPLYING' : 'DRY RUN'} — ${userIds.length} climber(s)` +
      (options.resumeFrom ? ` resuming from ${options.resumeFrom}` : '') +
      (options.limit !== null ? ` (limited to ${options.limit})` : ''),
  );

  let processed = 0;
  let windowsSeen = 0;
  let sessionsCreated = 0;
  let failed = 0;
  let firstFailedUserId: string | null = null;
  const plan = {
    wouldCreate: 0,
    absorbedRuns: 0,
    absorbedTicks: 0,
    merges: 0,
    emptied: 0,
    tickCounts: [] as number[],
    durationsMin: [] as number[],
  };

  for (const userId of userIds) {
    logger.info(`[backfill-inferred-sessions] starting user=${userId}`);
    try {
      const starts = await reconciliationStartsForUser(userId);
      windowsSeen += starts.length;

      if (options.apply) {
        for (const start of starts) {
          // One transaction per window: an interrupted backfill leaves whole sessions
          // behind, never a half-assigned one, and a single bad climber cannot roll
          // back the climbers already done.
          const applied = await db.transaction(
            (tx) =>
              reconcileInferredSessions(tx, userId, start, {
                preserveExistingSessions: true,
                rejectTruncatedWindow: true,
              }),
            { isolationLevel: 'serializable' },
          );
          if (applied) sessionsCreated += applied.runs.filter((run) => run.sessionId === null).length;
          await sleep(options.delayMs);
        }
      } else if (options.simulate) {
        // Exercise the real decisions rather than approximating them. Counting runs
        // would say nothing about merges, or about how many climbs an explicit session
        // is going to absorb — which is the part worth seeing before 63k sessions
        // appear across everyone's history at once.
        for (const start of starts) {
          const planned = await db.transaction(
            (tx) => planReconciliation(tx, userId, start, { ignoreFeatureFlag: true, rejectTruncatedWindow: true }),
            { accessMode: 'read only', isolationLevel: 'repeatable read' },
          );
          if (!planned) continue;
          for (const run of planned.result.runs) {
            if (run.sessionId !== null && planned.explicitSessionIds.has(run.sessionId)) {
              plan.absorbedRuns++;
              plan.absorbedTicks += run.tickIds.length;
            } else if (run.sessionId === null) {
              plan.wouldCreate++;
              plan.tickCounts.push(run.tickIds.length);
              plan.durationsMin.push(Math.round((run.lastTickAt - run.firstTickAt) / 60000));
            }
          }
          plan.merges += planned.result.merges.length;
          plan.emptied += planned.result.emptiedSessionIds.length;
          await sleep(options.delayMs);
        }
      }
    } catch (error) {
      failed++;
      firstFailedUserId ??= userId;
      // Keep going. One climber with unusual data should not strand the rest, and the
      // run is resumable from here if the failures turn out to matter.
      logger.error(
        `[backfill-inferred-sessions] ${userId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    processed++;
    if (processed % options.progressEvery === 0) {
      logger.info(
        `[backfill-inferred-sessions] ${processed}/${userIds.length} climbers · ${windowsSeen} windows · ` +
          `${sessionsCreated} sessions created · ${failed} failed · last=${userId}`,
      );
    }
    if (!options.apply && !options.simulate) await sleep(options.delayMs);
  }

  logger.info(
    `[backfill-inferred-sessions] done — ${processed} climber(s), ${windowsSeen} window(s), ` +
      `${sessionsCreated} sessions created, ${failed} failure(s)`,
  );
  if (!options.apply && options.simulate) {
    const percentile = (values: number[], p: number): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };
    logger.info(
      `[backfill-inferred-sessions] would create ${plan.wouldCreate} session(s); ` +
        `${plan.absorbedRuns} run(s) / ${plan.absorbedTicks} tick(s) absorbed by an explicit session; ` +
        `${plan.merges} merge(s); ${plan.emptied} emptied`,
    );
    if (plan.merges > 0 || plan.emptied > 0) {
      logger.warn(
        '[backfill-inferred-sessions] apply will refuse windows that remove existing sessions; inspect these users first',
      );
    }
    logger.info(
      `[backfill-inferred-sessions] session size ticks p50=${percentile(plan.tickCounts, 0.5)} ` +
        `p90=${percentile(plan.tickCounts, 0.9)} max=${plan.tickCounts.reduce((largest, count) => Math.max(largest, count), 0)} · ` +
        `duration min p50=${percentile(plan.durationsMin, 0.5)} ` +
        `p90=${percentile(plan.durationsMin, 0.9)} max=${plan.durationsMin.reduce((largest, minutes) => Math.max(largest, minutes), 0)} · ` +
        `single-climb=${plan.tickCounts.filter((n) => n === 1).length}`,
    );
  }
  if (!options.apply) {
    logger.info('[backfill-inferred-sessions] dry run: nothing was written. Re-run with --apply to commit.');
    if (!options.simulate) {
      logger.info(
        '[backfill-inferred-sessions] add --simulate to plan the real grouping (slower — queries per window).',
      );
    }
  }
  if (failed > 0) {
    const recoveryScope = options.userId ? `--user ${options.userId}` : `--resume-from ${firstFailedUserId}`;
    const recoveryMode = options.apply ? ' --apply' : options.simulate ? ' --simulate' : '';
    const recoveryLimit = options.limit !== null ? ` --limit ${options.limit}` : '';
    logger.warn(
      `[backfill-inferred-sessions] retry with ${recoveryScope}${recoveryMode}${recoveryLimit} --delay-ms ${options.delayMs}`,
    );
  }
  return failed > 0 ? 1 : 0;
}

// Only when executed directly. Importing this module (the run-splitting test does)
// must not kick off a fleet-wide backfill.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(() => runBackfill(parseArgs(process.argv.slice(2))))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      logger.error('[backfill-inferred-sessions] fatal:', error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
