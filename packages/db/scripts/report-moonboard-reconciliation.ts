import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gt, or, inArray, sql } from 'drizzle-orm';
import {
  boardClimbs,
  boardClimbStats,
  boardClimbHolds,
  boardClimbAliases,
  boardBetaLinks,
} from '../src/schema/boards/unified.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { userFavorites } from '../src/schema/app/favorites.js';
import { playlistClimbs } from '../src/schema/app/playlists.js';
import { getScriptDatabaseUrl, describeDatabaseHost } from './db-connection.js';
import { HOLDSETUP_TO_LAYOUT, terminalCanonicalUuid, type MoonBoardCatalogFile } from './moonboard-catalog-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  buildReconciliationReport,
  holdDifferences,
  type CatalogEntry,
  type Hold,
  type ReconciliationClimb,
  type UsageCounts,
} from './moonboard-reconciliation-report.js';

export function parseReconciliationArgs(argv: string[]) {
  let catalog: string | undefined;
  let previous: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--previous' || argument === '--out') {
      const argumentValue = argv[++index];
      if (!argumentValue || argumentValue.startsWith('-')) throw new Error(`${argument} requires a path`);
      if (argument === '--previous') {
        if (previous !== undefined) throw new Error('Repeated --previous');
        previous = argumentValue;
      } else {
        if (out !== undefined) throw new Error('Repeated --out');
        out = argumentValue;
      }
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown flag: ${argument}`);
    } else {
      if (catalog !== undefined) throw new Error('Expected one catalog directory');
      catalog = argument;
    }
  }
  if (!catalog || !previous || !out)
    throw new Error(
      'Usage: db:report-moonboard-reconciliation <catalog> --previous <older-catalog> --out <report.json>',
    );
  return { catalog, previous, out };
}

export function readReconciliationCatalog(directory: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const setups = new Set<number>();
  const problemKeys = new Set<string>();
  for (const filename of fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith('.json'))
    .sort()) {
    const payload: unknown = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    if (!payload || typeof payload !== 'object') continue;
    if (!('holdsetup' in payload)) {
      // Beta sidecars also have `problems`, but keyed by ID rather than an
      // array. Only a board-shaped payload is malformed without holdsetup.
      if ('count' in payload || ('problems' in payload && Array.isArray(payload.problems))) {
        throw new Error(`${filename}: catalog has no holdsetup`);
      }
      continue;
    }
    if (typeof payload.holdsetup !== 'number' || !HOLDSETUP_TO_LAYOUT[payload.holdsetup])
      throw new Error(`${filename}: unknown holdsetup`);
    if (!('problems' in payload) || !Array.isArray(payload.problems))
      throw new Error(`${filename}: missing problems array`);
    const capture = payload as MoonBoardCatalogFile;
    if (capture.count !== capture.problems.length) throw new Error(`${filename}: count does not match problems`);
    if (setups.has(capture.holdsetup)) throw new Error(`${filename}: duplicate holdsetup`);
    setups.add(capture.holdsetup);
    const layoutId = HOLDSETUP_TO_LAYOUT[capture.holdsetup];
    for (const problem of capture.problems) {
      if (
        !problem ||
        !Number.isInteger(problem.id) ||
        typeof problem.name !== 'string' ||
        (problem.moves !== null && typeof problem.moves !== 'string') ||
        (problem.configurations !== null && !Array.isArray(problem.configurations))
      )
        throw new Error(`${filename}: malformed problem`);
      const key = `${layoutId}:${problem.id}`;
      if (problemKeys.has(key)) throw new Error(`${filename}: duplicate problem ${problem.id}`);
      problemKeys.add(key);
      entries.push({ layoutId, problem });
    }
  }
  if (!entries.length) throw new Error(`${directory}: no catalog problems`);
  return entries;
}

/** All reads share one consistent snapshot. The server rejects accidental writes. */
export async function queryReconciliationReport(
  client: postgres.Sql,
  current: CatalogEntry[],
  previous: CatalogEntry[],
) {
  return drizzle(client).transaction(
    async (db) => {
      const climbs: ReconciliationClimb[] = (
        await db
          .select({
            uuid: boardClimbs.uuid,
            layoutId: boardClimbs.layoutId,
            name: boardClimbs.name,
            angle: boardClimbs.angle,
            createdAt: boardClimbs.createdAt,
            isListed: boardClimbs.isListed,
            isDraft: boardClimbs.isDraft,
            userId: boardClimbs.userId,
            framesCount: boardClimbs.framesCount,
          })
          .from(boardClimbs)
          .where(eq(boardClimbs.boardType, 'moonboard'))
      ).map((climb) => ({ ...climb, fingerprint: null, stats: [] }));
      const byUuid = new Map(climbs.map((climb) => [climb.uuid, climb]));
      let currentUuid: string | null = null;
      let holds: Hold[] = [];
      const flush = () => {
        const climb = currentUuid === null ? undefined : byUuid.get(currentUuid);
        if (climb) climb.fingerprint = fingerprintFromHolds(holds);
      };
      // Keyset pages bound memory while sharing the same read-only snapshot.
      // board_climb_holds has PK (board_type, climb_uuid, hold_id), so the
      // fixed board type makes this cursor unique, including page boundaries.
      let afterUuid: string | undefined;
      let afterHoldId = 0;
      while (true) {
        const rows = await db
          .select({
            uuid: boardClimbHolds.climbUuid,
            holdId: boardClimbHolds.holdId,
            holdState: boardClimbHolds.holdState,
          })
          .from(boardClimbHolds)
          .where(
            and(
              eq(boardClimbHolds.boardType, 'moonboard'),
              afterUuid === undefined
                ? undefined
                : or(
                    gt(boardClimbHolds.climbUuid, afterUuid),
                    and(eq(boardClimbHolds.climbUuid, afterUuid), gt(boardClimbHolds.holdId, afterHoldId)),
                  ),
            ),
          )
          .orderBy(boardClimbHolds.climbUuid, boardClimbHolds.holdId)
          .limit(20000);
        for (const row of rows) {
          if (row.uuid !== currentUuid) {
            flush();
            currentUuid = row.uuid;
            holds = [];
          }
          holds.push({ holdId: row.holdId, holdState: row.holdState });
        }
        if (rows.length < 20000) break;
        const last = rows[rows.length - 1];
        afterUuid = last.uuid;
        afterHoldId = last.holdId;
      }
      flush();
      for (const stat of await db
        .select({
          uuid: boardClimbStats.climbUuid,
          angle: boardClimbStats.angle,
          upstream: boardClimbStats.upstreamAscensionistCount,
        })
        .from(boardClimbStats)
        .where(eq(boardClimbStats.boardType, 'moonboard'))) {
        byUuid.get(stat.uuid)?.stats.push({ angle: stat.angle, upstream: stat.upstream });
      }
      const aliases = new Map(
        (
          await db
            .select({ alias: boardClimbAliases.aliasUuid, canonical: boardClimbAliases.canonicalUuid })
            .from(boardClimbAliases)
            .where(eq(boardClimbAliases.boardType, 'moonboard'))
        ).map((alias) => [alias.alias, alias.canonical]),
      );
      const report = buildReconciliationReport(current, previous, { climbs, aliases });
      const referencedUuids = [...new Set(report.skipped.flatMap((problem) => problem.referencedUuids))];
      const holdsByUuid = new Map<string, Hold[]>();
      const usageByUuid = new Map<string, UsageCounts>();
      for (let start = 0; start < referencedUuids.length; start += 1000) {
        const chunk = referencedUuids.slice(start, start + 1000);
        for (const hold of await db
          .select({
            uuid: boardClimbHolds.climbUuid,
            holdId: boardClimbHolds.holdId,
            holdState: boardClimbHolds.holdState,
          })
          .from(boardClimbHolds)
          .where(and(eq(boardClimbHolds.boardType, 'moonboard'), inArray(boardClimbHolds.climbUuid, chunk)))) {
          const existing = holdsByUuid.get(hold.uuid) ?? [];
          existing.push({ holdId: hold.holdId, holdState: hold.holdState });
          holdsByUuid.set(hold.uuid, existing);
        }
        const countRows = (kind: keyof UsageCounts, rows: { uuid: string; count: number }[]) => {
          for (const row of rows) {
            const counts = usageByUuid.get(row.uuid) ?? { ticks: 0, favourites: 0, playlists: 0, beta: 0 };
            counts[kind] = Number(row.count);
            usageByUuid.set(row.uuid, counts);
          }
        };
        countRows(
          'ticks',
          await db
            .select({ uuid: boardseshTicks.climbUuid, count: sql<number>`count(*)` })
            .from(boardseshTicks)
            .where(and(eq(boardseshTicks.boardType, 'moonboard'), inArray(boardseshTicks.climbUuid, chunk)))
            .groupBy(boardseshTicks.climbUuid),
        );
        countRows(
          'favourites',
          await db
            .select({ uuid: userFavorites.climbUuid, count: sql<number>`count(*)` })
            .from(userFavorites)
            .where(and(eq(userFavorites.boardName, 'moonboard'), inArray(userFavorites.climbUuid, chunk)))
            .groupBy(userFavorites.climbUuid),
        );
        countRows(
          'playlists',
          await db
            .select({ uuid: playlistClimbs.climbUuid, count: sql<number>`count(*)` })
            .from(playlistClimbs)
            .where(inArray(playlistClimbs.climbUuid, chunk))
            .groupBy(playlistClimbs.climbUuid),
        );
        countRows(
          'beta',
          await db
            .select({ uuid: boardBetaLinks.climbUuid, count: sql<number>`count(*)` })
            .from(boardBetaLinks)
            .where(and(eq(boardBetaLinks.boardType, 'moonboard'), inArray(boardBetaLinks.climbUuid, chunk)))
            .groupBy(boardBetaLinks.climbUuid),
        );
      }
      return {
        counts: report.counts,
        projectedCounts: report.projectedCounts,
        groups: report.groups,
        skipped: report.skipped.map(({ currentHolds, referencedUuids: problemUuids, ...problem }) => ({
          ...problem,
          climbs: problemUuids.map((uuid) => ({
            uuid,
            climb: (() => {
              const climb = byUuid.get(uuid);
              if (!climb) return null;
              const { userId, ...catalogFields } = climb;
              return { ...catalogFields, userOwned: userId !== null };
            })(),
            redirect: aliases.get(uuid) ?? null,
            terminalUuid: terminalCanonicalUuid(uuid, aliases) ?? null,
            usage: usageByUuid.get(uuid) ?? { ticks: 0, favourites: 0, playlists: 0, beta: 0 },
            holdDifferences: holdDifferences(holdsByUuid.get(uuid) ?? [], currentHolds),
          })),
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function main() {
  const args = parseReconciliationArgs(process.argv.slice(2));
  const current = readReconciliationCatalog(args.catalog);
  const previous = readReconciliationCatalog(args.previous);
  const databaseUrl = getScriptDatabaseUrl();
  console.info(`Read-only MoonBoard reconciliation: ${describeDatabaseHost(databaseUrl)}`);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const report = await queryReconciliationReport(client, current, previous);
    // Exclusive creation prevents a mistaken --out from overwriting a capture.
    fs.writeFileSync(
      args.out,
      JSON.stringify(
        { currentCatalog: path.resolve(args.catalog), previousCatalog: path.resolve(args.previous), ...report },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.info(
      JSON.stringify({
        before: report.counts,
        afterEligibleMerges: report.projectedCounts,
        groups: report.groups.length,
      }),
    );
    console.info(`Report written to ${args.out}. Differing holds were not changed.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
