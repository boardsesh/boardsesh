/**
 * Nightly similar-climbs refresh (board_climb_neighbors). The job body is
 * `src/jobs/refresh-climb-neighbors.ts`; the batch worker's
 * `refresh-climb-neighbors` family runs the same body, one board per job.
 * Design + runbook: docs/similar-climbs.md.
 *
 * Run locally: `node --import tsx packages/db/scripts/refresh-climb-neighbors.ts`
 * Flags: --board=<name>[,<name>] (default: every board but spray) · --full
 * (rebuild the board(s) from scratch, ignoring the watermark; a board with no
 * watermark row gets a full build on its first run without it) ·
 * --dry-run (compute and count, write nothing) · --refill-gaps (also run the
 * whole-board scan for lists that lost a row; the Sunday UTC run does it anyway).
 *
 * A full build is resumable: a cancelled run leaves its finished groups and
 * lists recorded, and the next run (with or without --full) carries on. Boards
 * run cheapest first. CI runs one board per matrix job instead.
 */
import type { BoardName } from '@boardsesh/shared-schema';
import { CLIMB_NEIGHBOR_BOARDS, isGapRefillDay, runRefreshClimbNeighbors } from '../src/jobs/index.js';
import { createScriptDb } from './db-connection.js';
import { cliJobLogger } from './job-cli.js';

function parseBoards(requested: string | undefined): BoardName[] {
  if (!requested) return [...CLIMB_NEIGHBOR_BOARDS];
  const boards = requested.split(',').map((board) => board.trim());
  for (const board of boards) {
    if (!(CLIMB_NEIGHBOR_BOARDS as readonly string[]).includes(board)) {
      throw new Error(`--board=${board} is not a materialised board. Use one of: ${CLIMB_NEIGHBOR_BOARDS.join(', ')}`);
    }
  }
  return boards as BoardName[];
}

async function main(argv: string[]): Promise<void> {
  const boardArgument = argv.find((argument) => argument.startsWith('--board='));
  const boards = parseBoards(boardArgument?.slice('--board='.length));
  const { db, close } = createScriptDb();
  try {
    await runRefreshClimbNeighbors({
      db,
      signal: new AbortController().signal,
      log: cliJobLogger(),
      boards,
      full: argv.includes('--full'),
      dryRun: argv.includes('--dry-run'),
      // The gap scan reads every neighbour row on the board; gaps only come from
      // deleted climbs now, so it runs weekly (docs/similar-climbs.md).
      refillGaps: argv.includes('--refill-gaps') || isGapRefillDay(new Date()),
    });
  } finally {
    await close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error('[refresh-climb-neighbors] failed:', error);
  process.exit(1);
});
