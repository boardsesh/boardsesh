/**
 * Nightly similar-climbs refresh: folds every climb that changed since the last
 * run into board_climb_neighbors (top-25 hold-overlap neighbours per climb),
 * which the `similarClimbs` resolver serves to every non-admin caller.
 *
 * Watermark-driven per board (board_climb_neighbor_runs.last_sync_seq), so a
 * normal night only touches new and edited climbs plus the lists they land in.
 * Spray walls are never materialised. Design + runbook: docs/similar-climbs.md.
 *
 * Run locally: `node --import tsx packages/db/scripts/refresh-climb-neighbors.ts`
 * Flags: --board=<name> (default: every board but spray) · --full (rebuild the
 * board(s) from scratch, ignoring the watermark; a board with no watermark row
 * gets a full build on its first run without it) ·
 * --dry-run (compute and count, write nothing).
 *
 * A full build is resumable: a cancelled run leaves its finished groups and
 * lists recorded, and the next run (with or without --full) carries on. Boards
 * run cheapest first. CI runs one board per matrix job instead.
 */
import type { BoardName } from '@boardsesh/shared-schema';
import { createScriptDb } from './db-connection.js';
import {
  CLIMB_NEIGHBOR_BOARDS,
  orderBoardsByClimbCount,
  refreshClimbNeighborsForBoard,
} from '../src/queries/climbs/climb-neighbors-refresh.js';

function parseBoards(requested: string | undefined): BoardName[] {
  const materialised = CLIMB_NEIGHBOR_BOARDS;
  if (!requested) return [...materialised];
  const boards = requested.split(',').map((board) => board.trim());
  for (const board of boards) {
    if (!(materialised as readonly string[]).includes(board)) {
      throw new Error(`--board=${board} is not a materialised board. Use one of: ${materialised.join(', ')}`);
    }
  }
  return boards as BoardName[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const requestedBoards = parseBoards(get('--board'));
  const full = argv.includes('--full');
  const dryRun = argv.includes('--dry-run');

  const { db, close } = createScriptDb();
  const startedAt = Date.now();
  try {
    // Cheapest boards first: the small catalogues are served before Kilter.
    const boards = await orderBoardsByClimbCount(db, requestedBoards);
    console.log(
      `[refresh-climb-neighbors] boards=${boards.join(',')}${full ? ' --full' : ''}${dryRun ? ' --dry-run' : ''}`,
    );
    let totalRows = 0;
    for (const boardType of boards) {
      const result = await refreshClimbNeighborsForBoard(db, {
        boardType,
        full,
        dryRun,
        log: (line) => console.log(`[refresh-climb-neighbors] ${line}`),
      });
      totalRows += result.rowsWritten;
    }
    console.log(
      `[refresh-climb-neighbors] done: ${totalRows} rows ${dryRun ? 'computed' : 'written'} in ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[refresh-climb-neighbors] failed:', error);
  process.exit(1);
});
