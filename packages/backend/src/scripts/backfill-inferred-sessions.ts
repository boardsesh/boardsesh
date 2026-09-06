/**
 * Group every climber's existing ticks into inferred sessions.
 *
 * The write path (`saveTick`/`updateTick`/`deleteTick`) only reconciles climbs logged
 * from now on, so all history stays on the day-bucketed `daily:` cards until this runs.
 * Against production that is roughly 435k ticks resolving to ~63,584 sessions.
 *
 * It calls the same `reconcileInferredSessions` the live writers use — deliberately, so
 * there is one implementation of the rules rather than two. The previous generation of
 * this feature kept a separate SQL backfill alongside the TypeScript builder, and they
 * drifted: the SQL path's `ON CONFLICT DO UPDATE` *added* counts while the TS path
 * recomputed them, so a re-run silently double-counted.
 *
 * Idempotent and interruptible. `reconcileWindow` returns the same answer for a window
 * however many times it is applied, each run commits in its own transaction, and
 * `--resume-from` picks up where a stopped run left off.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 * Usage:
 *   # what would happen, no writes
 *   vp exec tsx packages/backend/src/scripts/backfill-inferred-sessions.ts
 *
 *   # one climber first — the sane way to start
 *   vp exec tsx packages/backend/src/scripts/backfill-inferred-sessions.ts --user <userId> --apply
 *
 *   # the fleet, pacing between climbers, resuming after a stop
 *   vp exec tsx packages/backend/src/scripts/backfill-inferred-sessions.ts --apply --delay-ms 50
 *   vp exec tsx packages/backend/src/scripts/backfill-inferred-sessions.ts --apply --resume-from <userId>
 */

import { asc, eq, isNull, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { SESSION_GAP_MS } from '@boardsesh/session-inference';
import { db } from '../db/client';
import { reconcileInferredSessions } from '../services/inferred-sessions/reconcile';
import { logger } from '../utils/logger';

type Options = {
  apply: boolean;
  userId: string | null;
  limit: number | null;
  resumeFrom: string | null;
  delayMs: number;
  progressEvery: number;
};

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 || index === argv.length - 1 ? null : argv[index + 1];
  };
  const number = (flag: string, fallback: number | null): number | null => {
    const raw = value(flag);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
    return parsed;
  };

  return {
    apply: argv.includes('--apply'),
    userId: value('--user'),
    limit: number('--limit', null),
    resumeFrom: value('--resume-from'),
    delayMs: number('--delay-ms', 0) ?? 0,
    progressEvery: number('--progress-every', 100) ?? 100,
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

  const rows = await db
    .selectDistinct({ userId: dbSchema.boardseshTicks.userId })
    .from(dbSchema.boardseshTicks)
    .where(isNull(dbSchema.boardseshTicks.sessionId))
    .orderBy(asc(dbSchema.boardseshTicks.userId));

  let userIds = rows.map((row) => row.userId);
  if (options.resumeFrom) {
    const index = userIds.indexOf(options.resumeFrom);
    userIds = index === -1 ? userIds.filter((id) => id >= options.resumeFrom!) : userIds.slice(index);
  }
  return options.limit === null ? userIds : userIds.slice(0, options.limit);
}

/**
 * One timestamp per run, from a climber's climb times in ascending order.
 *
 * Reconciliation is window-scoped: a single call covers the whole run around the
 * timestamp it is given. Calling it per tick would mean 435k redundant passes over
 * windows already reconciled, so this picks the first climb of each run and lets each
 * call do the rest.
 *
 * Exported for tests — it is the only rule this script owns that the shared package
 * does not already cover.
 */
export function runStartTimestamps(ascendingClimbedAt: readonly number[]): number[] {
  const starts: number[] = [];
  let previous: number | null = null;
  for (const climbedAt of ascendingClimbedAt) {
    if (previous === null || climbedAt - previous > SESSION_GAP_MS) starts.push(climbedAt);
    previous = climbedAt;
  }
  return starts;
}

async function runStartsForUser(userId: string): Promise<Date[]> {
  const ticks = await db
    .select({ climbedAt: dbSchema.boardseshTicks.climbedAt })
    .from(dbSchema.boardseshTicks)
    .where(eq(dbSchema.boardseshTicks.userId, userId))
    .orderBy(asc(dbSchema.boardseshTicks.climbedAt), asc(dbSchema.boardseshTicks.id));

  return runStartTimestamps(ticks.map((tick) => new Date(tick.climbedAt).getTime())).map(
    (epochMs) => new Date(epochMs),
  );
}

async function countInferredSessions(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(dbSchema.boardSessions)
    .where(
      sql`${dbSchema.boardSessions.createdByUserId} = ${userId} AND ${dbSchema.boardSessions.origin} = 'inferred'`,
    );
  return row?.total ?? 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

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
  let runsSeen = 0;
  let sessionsCreated = 0;
  let failed = 0;
  let lastUserId = '';

  for (const userId of userIds) {
    lastUserId = userId;
    try {
      const starts = await runStartsForUser(userId);
      runsSeen += starts.length;

      if (options.apply) {
        const before = await countInferredSessions(userId);
        for (const start of starts) {
          // One transaction per run: an interrupted backfill leaves whole sessions
          // behind, never a half-assigned one, and a single bad climber cannot roll
          // back the climbers already done.
          await db.transaction((tx) => reconcileInferredSessions(tx, userId, start));
        }
        sessionsCreated += (await countInferredSessions(userId)) - before;
      }
    } catch (error) {
      failed++;
      // Keep going. One climber with unusual data should not strand the rest, and the
      // run is resumable from here if the failures turn out to matter.
      logger.error(`[backfill-inferred-sessions] ${userId} failed: ${error instanceof Error ? error.message : error}`);
    }

    processed++;
    if (processed % options.progressEvery === 0) {
      logger.info(
        `[backfill-inferred-sessions] ${processed}/${userIds.length} climbers · ${runsSeen} runs · ` +
          `${sessionsCreated} sessions created · ${failed} failed · last=${userId}`,
      );
    }
    await sleep(options.delayMs);
  }

  logger.info(
    `[backfill-inferred-sessions] done — ${processed} climber(s), ${runsSeen} run(s), ` +
      `${sessionsCreated} session(s) created, ${failed} failure(s)`,
  );
  if (!options.apply) {
    logger.info('[backfill-inferred-sessions] dry run: nothing was written. Re-run with --apply to commit.');
  }
  if (failed > 0) {
    logger.warn(`[backfill-inferred-sessions] resume the remainder with --resume-from ${lastUserId}`);
  }
}

// Only when executed directly. Importing this module (the run-splitting test does)
// must not kick off a fleet-wide backfill.
if (process.argv[1] && process.argv[1].includes('backfill-inferred-sessions')) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfill-inferred-sessions] fatal:', error);
      process.exit(1);
    });
}
