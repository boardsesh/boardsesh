/**
 * Deduplicate `board_beta_links` rows that point at the same video on the same
 * climb (same board + climb + Instagram/TikTok identity), keeping one row.
 *
 * Why these exist: Aurora's import can write the same video to a climb twice
 * (e.g. once with `angle` NULL and once with the angle) using URL variants
 * (/p/ vs /reel/, tracking params). The attachBetaLink resolver's dedup keys on
 * the `video_identity` column, which is NULL on Aurora rows, so it can't catch
 * these — an accepted trade-off (PR #1727). The climb page dedupes on render, so
 * the duplicates aren't user-visible, but they are redundant rows worth removing.
 *
 * The table PK is (board_type, climb_uuid, link), so the rows in a duplicate
 * group always differ by `link`, which makes a row-level delete unambiguous. One
 * row per group is kept (richest / most canonical — see dedupe-beta-links-helpers).
 *
 * Default mode is dry-run. Use --apply only after reading the report.
 *
 * Usage:
 *   vp run db:dedupe-beta-links
 *   vp run db:dedupe-beta-links --board kilter --limit 20
 *   vp run db:dedupe-beta-links --apply
 *
 * (A `--` separator before the flags also works — `vp` forwards it to the script
 * verbatim and parseArgs skips it — but it isn't needed.)
 */
import { and, eq, sql } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createScriptDb } from './db-connection.js';
import { boardBetaLinks } from '../src/schema/boards/unified.js';
import { groupDuplicateBetaLinks, type BetaLinkDuplicateGroup, type BetaLinkRow } from './dedupe-beta-links-helpers.js';

const APPLY_FLAG = '--apply';
const BOARD_FLAG = '--board';
const LIMIT_FLAG = '--limit';
const HELP_FLAG = '--help';
const ARG_SEPARATOR = '--';

type ScriptArgs = {
  apply: boolean;
  board: string | null;
  limit: number | null;
  help: boolean;
};

function readRequiredOptionValue(args: string[], optionIndex: number, flagName: string): string {
  const optionValue = args[optionIndex + 1];
  if (!optionValue || optionValue.startsWith('--')) {
    console.error(`[dedupe-beta-links] ${flagName} requires a value.`);
    process.exit(2);
  }
  return optionValue;
}

export function parseArgs(args: string[]): ScriptArgs {
  const parsed: ScriptArgs = { apply: false, board: null, limit: null, help: false };
  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    if (current === ARG_SEPARATOR) {
      // `vp run db:dedupe-beta-links -- --apply` forwards the `--` separator to
      // the script verbatim, so tolerate (skip) it rather than rejecting it as
      // an unknown argument. Both `-- --apply` and `--apply` then work.
      continue;
    }
    if (current === APPLY_FLAG) {
      parsed.apply = true;
      continue;
    }
    if (current === HELP_FLAG) {
      parsed.help = true;
      continue;
    }
    if (current === BOARD_FLAG) {
      parsed.board = readRequiredOptionValue(args, index, BOARD_FLAG);
      index += 1;
      continue;
    }
    if (current === LIMIT_FLAG) {
      const value = Number(readRequiredOptionValue(args, index, LIMIT_FLAG));
      if (!Number.isInteger(value) || value <= 0) {
        console.error(`[dedupe-beta-links] ${LIMIT_FLAG} requires a positive integer.`);
        process.exit(2);
      }
      parsed.limit = value;
      index += 1;
      continue;
    }
    console.error(`[dedupe-beta-links] Unknown argument: ${current}`);
    process.exit(2);
  }
  return parsed;
}

function printHelp(): void {
  console.info(`Usage:
  vp run db:dedupe-beta-links
  vp run db:dedupe-beta-links --board kilter --limit 20
  vp run db:dedupe-beta-links --apply

Options:
  --apply           Delete the redundant rows. Omit for a dry-run report.
  --board <type>    Restrict to one board_type (e.g. kilter, tension).
  --limit <n>       Only process the first n duplicate groups.
  --help            Show this help text.`);
}

function printReport(
  totalRows: number,
  allGroups: BetaLinkDuplicateGroup[],
  shown: BetaLinkDuplicateGroup[],
  apply: boolean,
): void {
  const redundantRows = allGroups.reduce((total, group) => total + group.remove.length, 0);
  console.info(`[dedupe-beta-links] Scanned ${totalRows} beta link(s).`);
  console.info(
    `[dedupe-beta-links] ${allGroups.length} duplicate group(s), ${redundantRows} redundant row(s) to remove.`,
  );
  if (shown.length < allGroups.length) {
    console.info(`[dedupe-beta-links] Showing the first ${shown.length} group(s) (--limit).`);
  }
  for (const group of shown) {
    console.info('');
    console.info(`  keep   ${group.keep.boardType} ${group.keep.climbUuid} ${group.keep.link}`);
    for (const removal of group.remove) {
      console.info(`  remove ${removal.boardType} ${removal.climbUuid} ${removal.link}`);
    }
  }
  if (!apply) {
    console.info('');
    console.info('[dedupe-beta-links] Dry-run only. Re-run with --apply to delete the redundant rows.');
  }
}

async function fetchRows(db: ReturnType<typeof createScriptDb>['db'], board: string | null): Promise<BetaLinkRow[]> {
  const columns = {
    boardType: boardBetaLinks.boardType,
    climbUuid: boardBetaLinks.climbUuid,
    link: boardBetaLinks.link,
    videoIdentity: boardBetaLinks.videoIdentity,
    createdByUserId: boardBetaLinks.createdByUserId,
    tickUuid: boardBetaLinks.tickUuid,
    angle: boardBetaLinks.angle,
    thumbnail: boardBetaLinks.thumbnail,
    createdAt: boardBetaLinks.createdAt,
  };
  const query = db.select(columns).from(boardBetaLinks);
  return board ? query.where(eq(boardBetaLinks.boardType, board)) : query;
}

async function main(): Promise<void> {
  const scriptArgs = parseArgs(process.argv.slice(2));
  if (scriptArgs.help) {
    printHelp();
    return;
  }

  const { db, close } = createScriptDb();
  try {
    const rows = await fetchRows(db, scriptArgs.board);
    const allGroups = groupDuplicateBetaLinks(rows);
    const selectedGroups = scriptArgs.limit ? allGroups.slice(0, scriptArgs.limit) : allGroups;

    printReport(rows.length, allGroups, selectedGroups, scriptArgs.apply);

    if (!scriptArgs.apply || selectedGroups.length === 0) {
      return;
    }

    const deletedCount = await db.transaction(async (transaction) => {
      // Serialize dedupe runs so two concurrent invocations can't both decide to
      // delete the "loser" of the same group and race to remove the survivor.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:beta-link-dedupe'))`);

      let removed = 0;
      for (const group of selectedGroups) {
        for (const removal of group.remove) {
          const deleted = await transaction
            .delete(boardBetaLinks)
            .where(
              and(
                eq(boardBetaLinks.boardType, removal.boardType),
                eq(boardBetaLinks.climbUuid, removal.climbUuid),
                eq(boardBetaLinks.link, removal.link),
              ),
            )
            .returning({ link: boardBetaLinks.link });
          removed += deleted.length;
        }
      }
      return removed;
    });

    console.info('');
    console.info(`[dedupe-beta-links] Deleted ${deletedCount} redundant row(s).`);
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[dedupe-beta-links] failed:', error);
    process.exit(1);
  });
}
