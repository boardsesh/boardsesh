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
 * row per group is kept (richest / most canonical — see dedupe-beta-links-helpers),
 * and before the duplicates are deleted the survivor inherits any column it is
 * missing from them, so metadata split across URL variants (e.g. the angle on one
 * variant, the video_identity on the other) is preserved rather than lost.
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
import {
  groupDuplicateBetaLinks,
  type BetaLinkBackfill,
  type BetaLinkDuplicateGroup,
  type BetaLinkRow,
} from './dedupe-beta-links-helpers.js';

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

function describeBackfill(backfill: BetaLinkBackfill): string {
  return Object.keys(backfill).join(', ');
}

function printReport(
  totalRows: number,
  allGroups: BetaLinkDuplicateGroup[],
  shown: BetaLinkDuplicateGroup[],
  apply: boolean,
): void {
  // Headline counts describe what THIS run acts on (the shown == selected
  // groups), so a --limit dry-run matches the subsequent --apply. The global
  // totals are surfaced only as context when --limit truncates the set.
  const shownRedundant = shown.reduce((total, group) => total + group.remove.length, 0);
  const shownRecover = shown.filter((group) => Object.keys(group.backfill).length > 0).length;
  const limited = shown.length < allGroups.length;
  console.info(`[dedupe-beta-links] Scanned ${totalRows} beta link(s).`);
  if (limited) {
    const totalRedundant = allGroups.reduce((total, group) => total + group.remove.length, 0);
    console.info(
      `[dedupe-beta-links] ${allGroups.length} duplicate group(s) found (${totalRedundant} redundant row(s) total); processing the first ${shown.length} (--limit).`,
    );
    console.info(`[dedupe-beta-links] This run: ${shownRedundant} redundant row(s) to remove.`);
  } else {
    console.info(
      `[dedupe-beta-links] ${allGroups.length} duplicate group(s), ${shownRedundant} redundant row(s) to remove.`,
    );
  }
  if (shownRecover > 0) {
    console.info(
      `[dedupe-beta-links] ${shownRecover} survivor(s) will recover metadata from a duplicate before it is deleted.`,
    );
  }
  for (const group of shown) {
    console.info('');
    console.info(`  keep   ${group.keep.boardType} ${group.keep.climbUuid} ${group.keep.link}`);
    const recovered = describeBackfill(group.backfill);
    if (recovered) {
      console.info(`  recover ${recovered}`);
    }
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
    foreignUsername: boardBetaLinks.foreignUsername,
    angle: boardBetaLinks.angle,
    thumbnail: boardBetaLinks.thumbnail,
    isListed: boardBetaLinks.isListed,
    createdAt: boardBetaLinks.createdAt,
    tickUuid: boardBetaLinks.tickUuid,
    boardId: boardBetaLinks.boardId,
    shortcode: boardBetaLinks.shortcode,
    videoIdentity: boardBetaLinks.videoIdentity,
    createdByUserId: boardBetaLinks.createdByUserId,
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

    const { removed, recovered } = await db.transaction(async (transaction) => {
      // Serialize dedupe runs so two concurrent invocations can't both decide to
      // delete the "loser" of the same group and race to remove the survivor.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:beta-link-dedupe'))`);

      let deletedRows = 0;
      let recoveredSurvivors = 0;
      for (const group of selectedGroups) {
        // Delete the duplicates first: video_identity and tick_uuid are uniquely
        // indexed (partial, WHERE NOT NULL), so recovering one of those onto the
        // survivor below would collide with the duplicate that still holds it
        // unless that row is already gone.
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
          deletedRows += deleted.length;
        }
        if (Object.keys(group.backfill).length > 0) {
          const updated = await transaction
            .update(boardBetaLinks)
            .set(group.backfill)
            .where(
              and(
                eq(boardBetaLinks.boardType, group.keep.boardType),
                eq(boardBetaLinks.climbUuid, group.keep.climbUuid),
                eq(boardBetaLinks.link, group.keep.link),
              ),
            )
            .returning({ link: boardBetaLinks.link });
          recoveredSurvivors += updated.length;
        }
      }
      return { removed: deletedRows, recovered: recoveredSurvivors };
    });

    console.info('');
    console.info(`[dedupe-beta-links] Deleted ${removed} redundant row(s).`);
    if (recovered > 0) {
      console.info(`[dedupe-beta-links] Recovered metadata onto ${recovered} survivor(s).`);
    }
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
