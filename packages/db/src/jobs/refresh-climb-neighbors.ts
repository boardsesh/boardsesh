/**
 * Nightly similar-climbs refresh: folds every climb that changed since the last
 * run into board_climb_neighbors (top-25 hold-overlap neighbours per climb),
 * which the `similarClimbs` resolver serves to every non-admin caller.
 *
 * Watermark-driven per board (board_climb_neighbor_runs.last_sync_seq), so a
 * normal night only touches new and edited climbs plus the lists they land in.
 * Spray walls are never materialised. Design + runbook: docs/similar-climbs.md.
 *
 * Callers: the CLI `packages/db/scripts/refresh-climb-neighbors.ts` (every
 * board, or `--board=a,b`) and the batch worker's `refresh-climb-neighbors`
 * family, one board per job (docs/background-workers.md).
 *
 * Every write batch goes through `transact`: the build-state row, each chunk of
 * up to 1,000 lists, each finished group, and the closing sweep + watermark.
 * The longest measured in production is one MoonBoard chunk, about 4 s with
 * its compute (Sep 2026). Reads go through `db`, never inside a batch.
 *
 * `signal` stops the run between chunks. Finished chunks and groups stay
 * recorded and the watermark does not move, so the run throws
 * {@link ClimbNeighborsInterruptedError} and the next run (a pg-boss retry, or
 * the next night) resumes where this one stopped.
 */
import type { BoardName } from '@boardsesh/shared-schema';
import {
  orderBoardsByClimbCount,
  refreshClimbNeighborsForBoard,
  type ClimbNeighborRefreshResult,
} from '../queries/climbs/climb-neighbors-refresh';
import { defaultTransact, type JobRunOptions } from './types';

export {
  CLIMB_NEIGHBOR_BOARDS,
  isGapRefillDay,
  orderBoardsByClimbCount,
  type ClimbNeighborRefreshResult,
} from '../queries/climbs/climb-neighbors-refresh';

const LOG_PREFIX = '[refresh-climb-neighbors]';

export type RefreshClimbNeighborsParams = {
  /** The boards to refresh; run cheapest first. Spray is skipped if named. */
  boards: readonly BoardName[];
  /** Rebuild every list, ignoring the watermark. Implied on a board's first run. */
  full: boolean;
  /** Compute and count, write nothing (watermark included). */
  dryRun: boolean;
  /** Also scan for lists that lost a row. Callers default it to {@link isGapRefillDay}. */
  refillGaps: boolean;
};

export type RefreshClimbNeighborsOptions = JobRunOptions & RefreshClimbNeighborsParams;

export type RefreshClimbNeighborsResult = {
  boards: ClimbNeighborRefreshResult[];
  rowsWritten: number;
};

/**
 * `signal` stopped the run before every board was done. Nothing is lost: the
 * next run resumes a full build from its recorded groups and lists, and an
 * incremental run's watermark has not moved, so its work set is scored again.
 */
export class ClimbNeighborsInterruptedError extends Error {
  readonly boardType: BoardName;

  constructor(boardType: BoardName) {
    super(`refresh-climb-neighbors stopped early on ${boardType}; the next run resumes it`);
    this.name = 'ClimbNeighborsInterruptedError';
    this.boardType = boardType;
  }
}

export async function runRefreshClimbNeighbors({
  db,
  signal,
  transact = defaultTransact(db),
  log,
  boards: requestedBoards,
  full,
  dryRun,
  refillGaps,
}: RefreshClimbNeighborsOptions): Promise<RefreshClimbNeighborsResult> {
  const startedAt = Date.now();
  // Cheapest boards first: the small catalogues are served before Kilter.
  const boards = await orderBoardsByClimbCount(db, requestedBoards);
  log.info(
    `${LOG_PREFIX} boards=${boards.join(',')}${full ? ' --full' : ''}${dryRun ? ' --dry-run' : ''}` +
      (refillGaps ? ' (with gap refill)' : ''),
  );
  const results: ClimbNeighborRefreshResult[] = [];
  let rowsWritten = 0;
  for (const boardType of boards) {
    const result = await refreshClimbNeighborsForBoard(db, {
      boardType,
      full,
      dryRun,
      refillGappedLists: refillGaps,
      transact,
      shouldContinue: () => !signal.aborted,
      log: (line) => log.info(`${LOG_PREFIX} ${line}`),
    });
    results.push(result);
    rowsWritten += result.rowsWritten;
    if (result.interrupted) throw new ClimbNeighborsInterruptedError(boardType);
  }
  log.info(
    `${LOG_PREFIX} done: ${rowsWritten} rows ${dryRun ? 'computed' : 'written'} in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  return { boards: results, rowsWritten };
}
