import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { v5 as uuidv5 } from 'uuid';
import { boardseshTicks } from '../schema/app/ascents.js';
import { recomputeClimbStatsBulk } from '../queries/climb-stats/index.js';
import { catalogClimbUuid, terminalCanonicalUuid, HOLDSETUP_TO_LAYOUT } from './moonboard-catalog-helpers.js';
import { moonBoardGradeToDifficultyId } from './moonboard-helpers.js';
import type { ImportOptions } from './catalog.js';

export class MoonBoardLogbookNeedsAttention extends Error {}
export type MoonLogRow = {
  entryId: string;
  problemId: number;
  setup: number;
  angle: number;
  climbedAt: string;
  status: 'flash';
  attemptCount: number;
  difficulty: number;
  comment: string;
  isBenchmark: boolean;
};

/** Only meanings observed in the app are accepted; unknown history holds the entire job. */
export function normalizeMoonBoardLogbook(snapshot: unknown): MoonLogRow[] {
  const value = snapshot as {
    schemaVersion: number;
    scope: string;
    count: number;
    observedAppCount: number;
    response: { gyms: unknown[]; logbook: Record<string, unknown>[] };
  };
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.scope !== 'authenticated_account_own_logbook' ||
    !Number.isInteger(value.count) ||
    value.count < 0 ||
    value.count > 10000 ||
    value.count !== value.observedAppCount ||
    !Array.isArray(value.response?.gyms) ||
    Object.keys(value.response).sort().join(',') !== 'gyms,logbook' ||
    !Array.isArray(value.response?.logbook) ||
    value.response.logbook.length !== value.count
  ) {
    throw new MoonBoardLogbookNeedsAttention('Logbook completeness is not established');
  }
  const ids = new Set<string>();
  return value.response.logbook.map((row) => {
    if (!row || typeof row !== 'object') throw new MoonBoardLogbookNeedsAttention('Invalid logbook record');
    const id = String(row.apiId);
    const angle = /^([0-9]+)°$/.exec(String(row.climbedAngle));
    const date = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?$/.exec(String(row.dateClimbed));
    const parsedDate = date ? new Date(`${date[1]}T12:00:00Z`) : new Date(NaN);
    const difficulty = typeof row.grade === 'string' ? moonBoardGradeToDifficultyId(row.grade) : undefined;
    if (
      !Number.isSafeInteger(row.apiId) ||
      Number(row.apiId) <= 0 ||
      ids.has(id) ||
      !Number.isSafeInteger(row.itemId) ||
      Number(row.itemId) <= 0 ||
      !Number.isSafeInteger(row.setup) ||
      !HOLDSETUP_TO_LAYOUT[Number(row.setup)] ||
      !Number.isSafeInteger(row.configuration) ||
      Number(row.configuration) <= 0 ||
      !angle ||
      ![25, 40].includes(Number(angle[1])) ||
      !date ||
      !Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date[1] ||
      row.logbookType !== 'problem' ||
      row.tries !== 'Flashed' ||
      row.attempts !== 0 ||
      difficulty === undefined ||
      (row.comment != null && typeof row.comment !== 'string') ||
      typeof row.isBenchmark !== 'boolean'
    ) {
      throw new MoonBoardLogbookNeedsAttention('Unfamiliar logbook identity, date, grade or ascent type');
    }
    ids.add(id);
    // Midnight values represent calendar dates in the observed export. Match the
    // existing Moon importer's neutral-noon date convention; do not infer an instant.
    return {
      entryId: id,
      problemId: Number(row.itemId),
      setup: Number(row.setup),
      angle: Number(angle[1]),
      climbedAt: `${date[1]} 12:00:00`,
      status: 'flash',
      attemptCount: 1,
      difficulty,
      comment: String(row.comment ?? ''),
      isBenchmark: row.isBenchmark,
    };
  });
}

export async function applyMoonBoardLogbook(
  client: postgres.Sql,
  userId: string,
  accountId: string,
  snapshot: unknown,
  options: ImportOptions = {},
) {
  if ((snapshot as { accountId?: string } | null)?.accountId !== accountId) {
    throw new MoonBoardLogbookNeedsAttention('Snapshot belongs to another account');
  }
  const rows = normalizeMoonBoardLogbook(snapshot);
  const rollback = new Error('moonboard_logbook_dry_run');
  let inserted = 0,
    claimed = 0;
  try {
    await client.begin(async (connection) => {
      const db = drizzle(Object.assign(connection, { options: client.options }) as unknown as postgres.Sql);
      await connection`SELECT pg_advisory_xact_lock(hashtext(${`moonboard-logbook:${userId}`}))`;
      const aliases = await connection<{ alias_uuid: string; canonical_uuid: string }[]>`
        SELECT alias_uuid, canonical_uuid FROM board_climb_aliases WHERE board_type = 'moonboard'`;
      const byAlias = new Map(aliases.map((row) => [row.alias_uuid, row.canonical_uuid]));
      const aliasesByCanonical = new Map<string, string[]>();
      for (const alias of byAlias.keys()) {
        const canonical = terminalCanonicalUuid(alias, byAlias);
        if (canonical) {
          const members = aliasesByCanonical.get(canonical) ?? [canonical];
          if (alias !== canonical) members.push(alias);
          aliasesByCanonical.set(canonical, members);
        }
      }
      const changes: { boardType: 'moonboard'; climbUuid: string; angle: number }[] = [];
      const usedTicks = new Set<string>();
      for (const row of rows) {
        const prior = await connection`SELECT tick_uuid FROM moonboard_logbook_entries
          WHERE user_id = ${userId} AND account_id = ${accountId} AND entry_id = ${row.entryId}`;
        if (prior.length) continue;
        const alias = catalogClimbUuid({ id: row.problemId });
        const canonical = byAlias.has(alias) ? terminalCanonicalUuid(alias, byAlias) : undefined;
        if (!canonical) throw new MoonBoardLogbookNeedsAttention('An upstream problem has no canonical climb');
        const climbs = await connection`SELECT c.uuid FROM board_climbs c JOIN board_climb_stats s
          ON s.board_type = c.board_type AND s.climb_uuid = c.uuid
          WHERE c.board_type = 'moonboard' AND c.uuid = ${canonical}
          AND c.layout_id = ${HOLDSETUP_TO_LAYOUT[row.setup]} AND s.angle = ${row.angle}`;
        if (climbs.length !== 1) throw new MoonBoardLogbookNeedsAttention('Climb setup or angle does not resolve');
        const candidates = await connection<
          { uuid: string; climb_uuid: string; status: string; attempt_count: number }[]
        >`
          SELECT t.uuid, t.climb_uuid, t.status, t.attempt_count FROM boardsesh_ticks t
          WHERE t.user_id = ${userId} AND t.board_type = 'moonboard'
          AND t.climb_uuid IN ${connection(aliasesByCanonical.get(canonical) ?? [canonical])}
          AND t.angle = ${row.angle} AND t.climbed_at::date = ${row.climbedAt.slice(0, 10)}::date
          AND NOT EXISTS (SELECT 1 FROM moonboard_logbook_entries e WHERE e.tick_uuid = t.uuid)
          FOR UPDATE`;
        if (
          candidates.length > 1 ||
          (candidates[0] && (candidates[0].status !== row.status || candidates[0].attempt_count !== row.attemptCount))
        ) {
          throw new MoonBoardLogbookNeedsAttention('Existing logbook history matches ambiguously');
        }
        const tickUuid =
          candidates[0]?.uuid ??
          uuidv5(JSON.stringify(['moonboard-logbook', userId, accountId, row.entryId]), uuidv5.URL);
        if (usedTicks.has(tickUuid)) throw new MoonBoardLogbookNeedsAttention('Two source entries resolve to one tick');
        usedTicks.add(tickUuid);
        if (candidates.length) {
          claimed++;
          // The source proves this send is already included in Moon's upstream
          // count. Preserve the user's fields, but record that provenance so
          // native + manufacturer statistics do not count it twice.
          await connection`UPDATE boardsesh_ticks SET climb_uuid = ${canonical},
            origin = CASE WHEN origin = 'native' THEN 'moonboard_import'::tick_origin ELSE origin END
            WHERE uuid = ${tickUuid}`;
          changes.push({ boardType: 'moonboard', climbUuid: canonical, angle: row.angle });
          if (candidates[0].climb_uuid !== canonical) {
            changes.push({ boardType: 'moonboard', climbUuid: candidates[0].climb_uuid, angle: row.angle });
          }
        } else {
          await db.insert(boardseshTicks).values({
            uuid: tickUuid,
            userId,
            boardType: 'moonboard',
            climbUuid: canonical,
            angle: row.angle,
            origin: 'moonboard_import',
            status: row.status,
            attemptCount: row.attemptCount,
            difficulty: row.difficulty,
            comment: row.comment,
            isBenchmark: row.isBenchmark,
            climbedAt: row.climbedAt,
          });
          inserted++;
          changes.push({ boardType: 'moonboard', climbUuid: canonical, angle: row.angle });
        }
        await connection`INSERT INTO moonboard_logbook_entries (user_id, account_id, entry_id, tick_uuid)
          VALUES (${userId}, ${accountId}, ${row.entryId}, ${tickUuid})`;
      }
      if (changes.length) await recomputeClimbStatsBulk(db, changes);
      await options.beforeCommit?.(connection);
      if (options.dryRun) throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return { count: rows.length, inserted, claimed };
}
