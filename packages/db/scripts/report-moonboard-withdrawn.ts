import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { boardClimbAliases, boardClimbs } from '../src/schema/boards/unified.js';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { HOLDSETUP_TO_LAYOUT, type MoonBoardCatalogFile } from './moonboard-catalog-helpers.js';
import {
  buildCatalogProblemIndex,
  classifyWithdrawnClimbs,
  type ListedClimb,
  type WithdrawnClimb,
  type WithdrawnReason,
} from './moonboard-withdrawn-report.js';

// =============================================================================
// Report: listed MoonBoard climbs the catalog no longer backs
// =============================================================================
// READ-ONLY. Nothing here writes.
//
// The catalog importer already stops listing a problem the capture marks
// `dateDeleted` — upstream stating a fact about its own data. It deliberately
// does NOT act on a problem that has simply disappeared from the API, because
// the app's paginated endpoint filters rows out of its own window, so absence
// from one capture is not proof of deletion. This report is how you look at
// that group with real numbers before deciding anything.
//
//   DB_URL=<target> vp run '@boardsesh/db#db:report-moonboard-withdrawn' \
//     /path/to/app-catalog [--previous /path/to/older-app-catalog] [--out report.csv]
//
// Without --previous, everything the catalog cannot account for lands in
// `no-catalog-alias`, which mixes genuinely-vanished problems with legacy rows
// from the pre-catalog imports. Pass the previous capture to separate them.
// =============================================================================

const REASON_LABELS: Record<WithdrawnReason, string> = {
  'withdrawn-upstream': 'marked dateDeleted in this capture (the importer unlists these)',
  'vanished-from-capture': 'was in the previous capture, gone from this one',
  'no-catalog-alias': 'no catalog problem resolves here (legacy import, or vanished before --previous)',
};

const SAMPLE_LIMIT = 20;

export type ReportCliArgs = { positional: string[]; previous?: string; out?: string };

export function parseReportCliArgs(argv: string[]): ReportCliArgs {
  const positional: string[] = [];
  let previous: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--previous' || arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--previous') previous = value;
      else out = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  return { positional, previous, out };
}

type CatalogProblemRow = { id: number; dateDeleted?: string | null; Active?: boolean };

/** Read every problem across a catalog directory, keeping only what classification needs. */
function readCatalogProblems(catalogDir: string): CatalogProblemRow[] {
  const files = fs.readdirSync(catalogDir).filter((name) => name.toLowerCase().endsWith('.json'));
  if (files.length === 0) throw new Error(`No .json catalog files in ${catalogDir}`);

  const problems: CatalogProblemRow[] = [];
  for (const file of files) {
    const dump: MoonBoardCatalogFile = JSON.parse(fs.readFileSync(path.join(catalogDir, file), 'utf-8'));
    if (!HOLDSETUP_TO_LAYOUT[dump.holdsetup]) {
      console.warn(`⚠️  ${file}: unknown holdsetup ${dump.holdsetup}, skipping`);
      continue;
    }
    for (const problem of dump.problems) {
      problems.push({ id: problem.id, dateDeleted: problem.dateDeleted, Active: problem.Active });
    }
  }
  return problems;
}

function toCsv(rows: (WithdrawnClimb & { ticks: number; betaLinks: number; ascents: number })[]): string {
  const header = 'uuid,layout_id,reason,name,setter,ascensionist_count,boardsesh_ticks,beta_links';
  const escape = (value: string | null) => `"${(value ?? '').replaceAll('"', '""')}"`;
  const lines = rows.map((row) =>
    [
      row.uuid,
      row.layoutId,
      row.reason,
      escape(row.name),
      escape(row.setterUsername),
      row.ascents,
      row.ticks,
      row.betaLinks,
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

async function reportMoonBoardWithdrawn() {
  let cli: ReportCliArgs;
  try {
    cli = parseReportCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    console.error(
      "   Usage: vp run '@boardsesh/db#db:report-moonboard-withdrawn' /path/to/app-catalog [--previous DIR] [--out FILE]",
    );
    process.exit(1);
  }

  const catalogDir = cli.positional[0];
  if (!catalogDir) {
    console.error('❌ Path to the catalog directory is required.');
    process.exit(1);
  }

  const databaseUrl = getScriptDatabaseUrl();
  console.info(`🔎 Reporting against: ${describeDatabaseHost(databaseUrl)} (read-only)`);

  const problems = readCatalogProblems(path.resolve(process.cwd(), catalogDir));
  console.info(`📂 Catalog: ${problems.length} problems`);
  const previousProblemIds = cli.previous
    ? readCatalogProblems(path.resolve(process.cwd(), cli.previous)).map((problem) => problem.id)
    : undefined;
  if (previousProblemIds) console.info(`📂 Previous catalog: ${previousProblemIds.length} problems`);

  const { db, close } = createScriptDb();
  try {
    const aliasRows = await db
      .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
      .from(boardClimbAliases)
      .where(eq(boardClimbAliases.boardType, 'moonboard'));
    const canonicalByAlias = new Map(aliasRows.map((row) => [row.aliasUuid, row.canonicalUuid]));

    const index = buildCatalogProblemIndex({ problems, previousProblemIds, canonicalByAlias });

    const listedRows = await db
      .select({
        uuid: boardClimbs.uuid,
        layoutId: boardClimbs.layoutId,
        name: boardClimbs.name,
        setterUsername: boardClimbs.setterUsername,
      })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.boardType, 'moonboard'), isNull(boardClimbs.userId), eq(boardClimbs.isListed, true)));
    console.info(`📊 ${listedRows.length} listed catalog climbs in the database`);

    const unbacked = classifyWithdrawnClimbs(listedRows as ListedClimb[], index);

    // Numbers that make the decision real: how much history is behind each row.
    const withUsage = await attachUsage(db, unbacked);

    const byReason = new Map<WithdrawnReason, typeof withUsage>();
    for (const row of withUsage) {
      const bucket = byReason.get(row.reason) ?? [];
      bucket.push(row);
      byReason.set(row.reason, bucket);
    }

    console.info(`\n${withUsage.length} listed climbs the catalog does not back:\n`);
    for (const reason of ['withdrawn-upstream', 'vanished-from-capture', 'no-catalog-alias'] as WithdrawnReason[]) {
      const bucket = byReason.get(reason) ?? [];
      if (bucket.length === 0) continue;
      const ticked = bucket.filter((row) => row.ticks > 0).length;
      const withBeta = bucket.filter((row) => row.betaLinks > 0).length;
      console.info(`  ${reason} — ${bucket.length}`);
      console.info(`    ${REASON_LABELS[reason]}`);
      console.info(`    ${ticked} have Boardsesh ticks, ${withBeta} have beta links`);
      for (const row of bucket.slice(0, SAMPLE_LIMIT)) {
        console.info(
          `      layout ${row.layoutId} ${row.uuid} "${row.name ?? ''}" by ${row.setterUsername ?? '?'} ` +
            `— ${row.ascents} ascents, ${row.ticks} ticks, ${row.betaLinks} beta`,
        );
      }
      if (bucket.length > SAMPLE_LIMIT) console.info(`      … and ${bucket.length - SAMPLE_LIMIT} more`);
      console.info('');
    }

    if (!previousProblemIds) {
      console.info(
        'ℹ️  No --previous given, so problems that vanished from the API are mixed into `no-catalog-alias`\n' +
          '   alongside legacy pre-catalog rows. Pass the earlier capture directory to separate them.',
      );
    }

    if (cli.out) {
      const outPath = path.resolve(process.cwd(), cli.out);
      fs.writeFileSync(outPath, toCsv(withUsage));
      console.info(`📝 Wrote ${withUsage.length} rows to ${outPath}`);
    }
  } finally {
    await close();
  }
}

/** Ascent count, Boardsesh tick count and beta-link count per climb, in one round trip. */
async function attachUsage(
  db: ReturnType<typeof createScriptDb>['db'],
  climbs: WithdrawnClimb[],
): Promise<(WithdrawnClimb & { ticks: number; betaLinks: number; ascents: number })[]> {
  if (climbs.length === 0) return [];
  const uuids = climbs.map((climb) => climb.uuid);
  const rows = await db.execute<{ uuid: string; ticks: string; beta_links: string; ascents: string }>(sql`
    SELECT u.uuid,
           (SELECT COUNT(*) FROM boardsesh_ticks t
             WHERE t.board_type = 'moonboard' AND t.climb_uuid = u.uuid)::text AS ticks,
           (SELECT COUNT(*) FROM board_beta_links b
             WHERE b.board_type = 'moonboard' AND b.climb_uuid = u.uuid)::text AS beta_links,
           (SELECT COALESCE(MAX(s.ascensionist_count), 0) FROM board_climb_stats s
             WHERE s.board_type = 'moonboard' AND s.climb_uuid = u.uuid)::text AS ascents
    FROM unnest(${uuids}::text[]) AS u(uuid)
  `);
  const usageByUuid = new Map(
    (rows as unknown as { uuid: string; ticks: string; beta_links: string; ascents: string }[]).map((row) => [
      row.uuid,
      { ticks: Number(row.ticks), betaLinks: Number(row.beta_links), ascents: Number(row.ascents) },
    ]),
  );
  return (
    climbs
      .map((climb) => ({
        ...climb,
        ...(usageByUuid.get(climb.uuid) ?? { ticks: 0, betaLinks: 0, ascents: 0 }),
      }))
      // Loudest first: the rows a human most needs to look at before acting.
      .sort((left, right) => right.ticks - left.ticks || right.ascents - left.ascents)
  );
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  void reportMoonBoardWithdrawn().catch((error: unknown) => {
    console.error('❌ Report failed:', error);
    process.exit(1);
  });
}
