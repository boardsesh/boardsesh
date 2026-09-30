import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { SHARED_SYNC_COOLDOWN_CURSOR } from '@boardsesh/db/queries';
import { boardSharedSyncs } from '@boardsesh/db/schema';
import { logger } from '../../utils/logger';
import { boundedErrorFields } from './job-logging';
import { AURORA_USER_SYNC_BOARDS } from './aurora-user-sync';
import { AURORA_SHARED_SYNC_BUDGET, BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS } from './fan-out-budget';
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

/** When a stored cooldown stamp (`YYYY-MM-DD HH:MM:SS.ffffff[#marker]`, UTC) was taken; null when unreadable. */
function stampTime(stamp: string | null): number | null {
  if (!stamp) return null;
  const parsed = Date.parse(`${stamp.split('#', 1)[0].replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The boards in the order their shared sync last ran: never-run (or
 * unreadable) first, then oldest stamp first; ties keep the given order. The
 * routine worker takes one job at a time in enqueue order, so the board that
 * has waited longest runs first and a board late in a slow hour is not always
 * the same one.
 */
export function orderBoardsByLeastRecentSharedSync<Board extends string>(
  boards: readonly Board[],
  stamps: ReadonlyMap<string, string | null>,
): Board[] {
  return boards
    .map((board, index) => ({ board, index, at: stampTime(stamps.get(board) ?? null) }))
    .sort((left, right) => {
      if (left.at !== right.at) {
        if (left.at === null) return -1;
        if (right.at === null) return 1;
        return left.at - right.at;
      }
      return left.index - right.index;
    })
    .map(({ board }) => board);
}

async function boardsInSharedSyncOrder(database: DbInstance): Promise<Array<(typeof AURORA_USER_SYNC_BOARDS)[number]>> {
  const rows = await database
    .select({ boardType: boardSharedSyncs.boardType, stamp: boardSharedSyncs.lastSynchronizedAt })
    .from(boardSharedSyncs)
    .where(
      and(
        eq(boardSharedSyncs.tableName, SHARED_SYNC_COOLDOWN_CURSOR),
        inArray(boardSharedSyncs.boardType, [...AURORA_USER_SYNC_BOARDS]),
      ),
    );
  return orderBoardsByLeastRecentSharedSync(
    AURORA_USER_SYNC_BOARDS,
    new Map(rows.map((row) => [row.boardType, row.stamp])),
  );
}

/**
 * The deadline of the hourly fan-out and everything queued behind it; see
 * fan-out-budget.ts for the derivation. Re-exported under its old name.
 */
export const AURORA_SHARED_SYNC_DEADLINE_SECONDS = BOARD_WIDE_FAN_OUT_DEADLINE_SECONDS;

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
    expireInSeconds: AURORA_SHARED_SYNC_BUDGET.expireInSeconds,
    retryLimit: AURORA_SHARED_SYNC_BUDGET.retryLimit,
    retryDelay: AURORA_SHARED_SYNC_BUDGET.retryDelay,
    retryBackoff: true,
    retryDelayMax: AURORA_SHARED_SYNC_BUDGET.retryDelay,
    deadlineSeconds: AURORA_SHARED_SYNC_DEADLINE_SECONDS,
    // One Aurora page (up to ~2000 records with its climb_stats upsert) or one
    // 25-gym location batch holds the run-row lock at a time.
    heartbeatSeconds: 300,
    // The same priority as the routine cycle, never lower: pg-boss fetches
    // FIFO within a priority, and two routine cycles can keep a lower
    // priority waiting forever (docs/background-workers.md, "Queue share").
    priority: 0,
  },
  payload: auroraSharedSyncPayload,
  singletonKey: (payload) => payload.board,
  schedules: [
    {
      key: 'hourly',
      cron: '7 * * * *',
      // Least recently synced board first, so a slow hour delays a different
      // board each time rather than always the last in the list.
      fanOut: async (database) => (await boardsInSharedSyncOrder(database)).map((board) => ({ payload: { board } })),
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
        // A retry of this run re-claims the slot this run left claimed.
        runId: context.runId,
      });
    } catch (error) {
      if (context.signal.aborted || !isAuroraRequestError(error)) throw error;
      if (error.retryAfterMs !== undefined) {
        // Aurora asked us to wait: the runner closed the slot and held the
        // donor for that long, so a pg-boss retry minutes from now could only
        // find the slot closed. The next hourly tick after the hold runs it.
        logger.warn('[worker] shared sync throttled', {
          ...logContext,
          code: 'PROVIDER_THROTTLED',
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }
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
