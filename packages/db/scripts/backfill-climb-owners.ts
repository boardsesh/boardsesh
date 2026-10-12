/**
 * Give an owner to draft and unlisted climbs that have none.
 *
 * A draft or an unlisted climb is returned to its owner alone, and one with no
 * owner to no one (docs/board-snapshots.md, "The publication rule"). The
 * manufacturer draft import stamps the importing account now; this assigns the
 * rows written before it did, and unlisted manufacturer climbs. A climb is
 * assigned only when exactly one Boardsesh account links the manufacturer
 * account that set it, on that board. Every other climb is left with no owner.
 * A published, listed climb is never touched. The matching rule is in
 * `src/queries/climbs/climb-owner-backfill.ts`.
 *
 * Dry-run is the default: it reads, prints counts and writes nothing. Apply with:
 *   DB_URL=<target> vp run db:backfill-climb-owners -- --apply
 *
 * Options:
 *   --apply                   Assign the matched climbs. Without it nothing is written.
 *   --only drafts|unlisted    One kind instead of both.
 *   --board <board type>      One board type instead of all.
 *   --batch-size <n>          Rows per UPDATE statement (default 500, at most 5000).
 *   --include-mapping-only    Also assign `matchedMappingOnly` climbs (below). Off
 *                             by default: a mapping row with no credential behind
 *                             it is not proof its account signed in to the setter.
 *
 * The output is one JSON line of counts and nothing else: no climb, account or
 * setter is ever printed. For each kind (`drafts`, `unlisted`), in total and by
 * board type:
 *
 *   ownerless           climbs of that kind with no owner; the five counts below add up to it
 *   matched             exactly one linked account, with a credential row: what --apply assigns
 *   matchedMappingOnly  exactly one linked account, through a mapping row alone; assigned only
 *                       with --include-mapping-only
 *   ambiguous           more than one linked account; left with no owner
 *   noLinkedAccount     no account links the setter; left with no owner
 *   noSetterId          the climb names no setter; left with no owner
 *
 * and `includeMappingOnly`, as this run was asked, and `updated`, the rows this
 * run wrote (0 in a dry run).
 *
 * Safe to re-run and to interrupt: each batch is one transaction, an assigned
 * climb stops matching, and a second run reports `matched: 0` (and
 * `matchedMappingOnly: 0` too, after a run with --include-mapping-only).
 *
 * Apply batches briefly fence writes to both account-link tables while checking
 * the current unique owner. Link/unlink operations wait until that batch commits;
 * no lock is held between batches. Dry runs take no such locks.
 *
 * Each assigned row moves its `updated_at` and `sync_seq`, which is how it
 * reaches its owner's devices on their next sync. Nobody else is sent it, and no
 * deletion marker is written: the climb was not public before and is not after.
 *
 * One thing an owner changes: the Kilter catalogue sync re-lists and unlists
 * only climbs with no owner, so an unlisted Kilter climb that gains one stays
 * unlisted whatever Kilter does next. `--board` and `--only` are there to leave
 * such rows out.
 */
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  CLIMB_OWNER_BACKFILL_BATCH_SIZE,
  CLIMB_OWNER_BACKFILL_KINDS,
  backfillClimbOwners,
  planClimbOwnerBackfill,
  type ClimbOwnerBackfillKind,
} from '../src/queries/climbs/climb-owner-backfill.js';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';

const APPLY_FLAG = '--apply';
const ONLY_FLAG = '--only';
const BOARD_FLAG = '--board';
const BATCH_SIZE_FLAG = '--batch-size';
const INCLUDE_MAPPING_ONLY_FLAG = '--include-mapping-only';
const ARG_SEPARATOR = '--';
const MAX_BATCH_SIZE = 5000;
const BOARD_TYPE = /^[a-z][a-z0-9_]*$/;

export type ClimbOwnerBackfillArgs = {
  apply: boolean;
  kinds: readonly ClimbOwnerBackfillKind[];
  boardType: string | undefined;
  batchSize: number;
  includeMappingOnly: boolean;
};

function isBackfillKind(value: string | undefined): value is ClimbOwnerBackfillKind {
  return (CLIMB_OWNER_BACKFILL_KINDS as readonly string[]).includes(value ?? '');
}

/**
 * `vp run db:backfill-climb-owners -- --apply` forwards the `--` separator
 * verbatim, so it is skipped. Anything else unknown is an error: a mistyped
 * `--aply` must not read as a dry run that "found nothing to do".
 */
export function parseClimbOwnerBackfillArgs(args: string[]): ClimbOwnerBackfillArgs {
  const parsed: {
    apply: boolean;
    kinds: readonly ClimbOwnerBackfillKind[];
    boardType?: string;
    batchSize: number;
    includeMappingOnly: boolean;
  } = {
    apply: false,
    kinds: CLIMB_OWNER_BACKFILL_KINDS,
    batchSize: CLIMB_OWNER_BACKFILL_BATCH_SIZE,
    includeMappingOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === ARG_SEPARATOR) continue;
    if (argument === APPLY_FLAG) {
      parsed.apply = true;
      continue;
    }
    if (argument === INCLUDE_MAPPING_ONLY_FLAG) {
      parsed.includeMappingOnly = true;
      continue;
    }
    if (argument === ONLY_FLAG) {
      const kind = args[index + 1];
      if (!isBackfillKind(kind)) {
        throw new Error(`${ONLY_FLAG} must be one of: ${CLIMB_OWNER_BACKFILL_KINDS.join(', ')}`);
      }
      parsed.kinds = [kind];
      index += 1;
      continue;
    }
    if (argument === BOARD_FLAG) {
      const boardType = args[index + 1];
      if (!boardType || !BOARD_TYPE.test(boardType)) throw new Error(`${BOARD_FLAG} must name a board type`);
      parsed.boardType = boardType;
      index += 1;
      continue;
    }
    if (argument === BATCH_SIZE_FLAG) {
      const rawBatchSize = args[index + 1];
      const batchSize = Number(rawBatchSize);
      if (!rawBatchSize || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
        throw new Error(`${BATCH_SIZE_FLAG} must be a whole number from 1 to ${MAX_BATCH_SIZE}`);
      }
      parsed.batchSize = batchSize;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { ...parsed, boardType: parsed.boardType };
}

async function main(): Promise<void> {
  const { apply, kinds, boardType, batchSize, includeMappingOnly } = parseClimbOwnerBackfillArgs(process.argv.slice(2));
  const databaseUrl = getScriptDatabaseUrl();
  console.info(
    `[climb-owners] target=${describeDatabaseHost(databaseUrl)} mode=${apply ? 'apply' : 'dry-run'} ` +
      `kinds=${kinds.join(',')} board=${boardType ?? 'all'} ` +
      `evidence=${includeMappingOnly ? 'credential,mapping-only' : 'credential'}`,
  );

  const { db, close } = createScriptDb(databaseUrl);
  try {
    if (!apply) {
      // Read-only at the database, so a dry run cannot write whatever the code does.
      const plan = await db.transaction(async (transaction) => {
        await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        return planClimbOwnerBackfill(transaction, { kinds, boardType });
      });
      console.info(JSON.stringify({ mode: 'dry-run', includeMappingOnly, ...plan, updated: 0 }));
      console.info('[climb-owners] dry-run complete; no rows written');
      return;
    }

    const result = await backfillClimbOwners(db, {
      apply: true,
      kinds,
      boardType,
      batchSize,
      includeMappingOnly,
      onBatch: (updatedSoFar) => console.info(`[climb-owners] assigned ${updatedSoFar}`),
    });
    console.info(JSON.stringify({ mode: 'apply', includeMappingOnly, ...result.plan, updated: result.updated }));
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[climb-owners] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
