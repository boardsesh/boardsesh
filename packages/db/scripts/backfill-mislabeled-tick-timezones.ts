/**
 * #3909 — corrective backfill for legacy ticks whose `climbed_at` holds the
 * climber's local wall clock relabelled as UTC.
 *
 * ⚠️  THIS SCRIPT IS INERT UNTIL A HUMAN RUNS IT WITH `--apply`. It is NOT a
 * data migration on purpose: a drizzle data migration runs automatically inside
 * the production deploy's migrate gate, which is exactly the "silently rewrote
 * 280K rows" failure this must never be. Merging the PR that adds this file
 * changes zero ticks.
 *
 * Guards, in the order they fire:
 *   1. Every argument is parsed and validated BEFORE a connection is opened.
 *      A NaN bound would otherwise match nothing and print a clean, completely
 *      false "0 rows to fix".
 *   2. The resolved target host is printed regardless of which branch runs, so
 *      the operator always sees what they are pointed at.
 *   3. Without `--apply` the connection itself is read-only
 *      (`default_transaction_read_only=on`), enforced by Postgres.
 *   4. `--apply` against a non-local database additionally requires
 *      TICK_TZ_BACKFILL_ALLOW_REMOTE=1 — the literal string '1' only.
 *
 * PREREQUISITES BEFORE ANY REAL RUN (see docs/tick-timezone-correction.md):
 *   - The report's anchor cross-check must come back consistent.
 *   - The aurora-sync writer guard must be DEPLOYED, or the live pull rewrites
 *     the shifted value within one sync cycle and the run is a no-op that also
 *     churns every corrected row through offline sync.
 *   - A pg_dump / confirmed PITR window, then a single-climber `--user` canary.
 *
 * Usage:
 *   vp run db:backfill-tick-timezones                          # report only
 *   vp run db:backfill-tick-timezones -- --user <id> --apply   # canary
 *   vp run db:backfill-tick-timezones -- --revert <run-id> --apply
 *
 * Options:
 *   --origin <csv>  json_import (default), aurora_pull, native_pre_cutoff.
 *   --user <id>     Restrict to one climber.
 *   --limit <n>     Cap the number of rows corrected.
 *   --apply         Actually write. Absent ⇒ report only, read-only connection.
 *   --revert <id>   Undo a prior run from tick_climbed_at_corrections.
 *   --batch <n>     Keyset page size for the fetch. Default 20000.
 */

import { randomUUID } from 'crypto';
import { pathToFileURL } from 'node:url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import {
  createReadOnlyScriptDb,
  createScriptDb,
  describeDatabaseHost,
  getScriptDatabaseUrl,
  isLocalDatabaseUrl,
} from './db-connection.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { tickClimbedAtCorrections } from '../src/schema/app/tick-climbed-at-corrections.js';
import { recomputeClimbStatsBulk, type ClimbStatsKey } from '../src/queries/index.js';
import {
  ArgError,
  buildAudit,
  fetchAuditTickRows,
  formatOffset,
  parseBatchSize,
  parseOriginSelectors,
  type SuspectOriginSelector,
} from './report-mislabeled-tick-timezones.js';

/**
 * The env var a human sets to deliberately allow an `--apply` against a
 * non-local database. Never set by any automation in this repo, so a mistyped
 * DB_URL can never carry it.
 */
export const TICK_TZ_BACKFILL_ALLOW_REMOTE_ENV_VAR = 'TICK_TZ_BACKFILL_ALLOW_REMOTE';

export type BackfillTargetDecision = 'local' | 'remote-allowed' | 'remote-refused';

/**
 * Pure target decision, same shape as `resolveMoonBoardImportDecision`: takes
 * the override value as a PARAMETER rather than reading process.env, and only
 * the exact string '1' opts in. 'true' / 'yes' / '' / undefined all fail closed.
 */
export function resolveBackfillTargetDecision(
  databaseUrl: string,
  allowRemoteEnvValue: string | undefined,
): BackfillTargetDecision {
  if (isLocalDatabaseUrl(databaseUrl)) return 'local';
  return allowRemoteEnvValue === '1' ? 'remote-allowed' : 'remote-refused';
}

export type BackfillArgs = {
  origins: SuspectOriginSelector[];
  userId: string | null;
  limit: number | null;
  apply: boolean;
  revertRunId: string | null;
  batchSize: number;
};

/** Parse + validate everything before a connection exists. */
export function parseArgs(argv: readonly string[]): BackfillArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  const valueFlags = new Set(['--origin', '--user', '--limit', '--revert', '--batch']);
  const booleanFlags = new Set(['--apply']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    if (booleanFlags.has(token)) continue;
    if (!valueFlags.has(token)) throw new ArgError(`Unknown argument "${token}"`);
    index += 1;
  }

  const limitRaw = value('--limit');
  const limit = limitRaw === undefined ? null : Number(limitRaw);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new ArgError(`--limit must be a positive integer, got "${limitRaw}"`);
  }

  const revertRunId = value('--revert') ?? null;
  if (args.includes('--revert') && (revertRunId === null || revertRunId.startsWith('--'))) {
    throw new ArgError('--revert needs a run id');
  }

  return {
    // Shared parsers, so the two scripts can never disagree about what
    // `--origin` or `--batch` mean.
    origins: parseOriginSelectors(value('--origin')),
    userId: value('--user') ?? null,
    limit,
    apply: args.includes('--apply'),
    revertRunId,
    batchSize: parseBatchSize(value('--batch')),
  };
}

type ScriptDb = ReturnType<typeof createScriptDb>['db'];
/** Structural handle accepted by both the outer connection and a transaction. */
type WritableDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Rows an UPDATE actually touched. postgres.js returns the result rows array
 * with a `count` property hung off it; drizzle's `execute` types that loosely,
 * so read it once here rather than casting at four call sites. A guard that
 * silently read 0 would make every optimistic skip look like a success.
 */
function affectedRowCount(result: unknown): number {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === 'number' ? count : 0;
}

/**
 * One row's correction, written inside the SAME transaction as its audit row.
 *
 * Three things are load-bearing:
 *
 *   - `climbed_at = <previous>` is the optimistic guard. A row a climber edited
 *     between the decision and this write simply does not match and is skipped
 *     rather than clobbered.
 *   - `aurora_synced_at` is the SQL literal `NOW()`, not a JS-computed
 *     timestamp. `trg_boardsesh_ticks_set_updated_at` fires (climbed_at is not
 *     in its exclusion list) and forces `updated_at = NOW()`; NOW() is
 *     transaction_timestamp, so using it on both sides makes them bit-identical
 *     and the pull's `updated_at <= aurora_synced_at` guard keeps passing. A JS
 *     value can differ by microseconds and flip that comparison, which would
 *     make the row sync-blind — and a sync-blind row is still SELECTED as a
 *     claim candidate, still consumes the claim, and then no-ops at the write,
 *     so the upstream ascent never links and never inserts. Silently. Forever.
 *   - The audit insert is not optional: it is the only undo.
 */
async function applyOneCorrection(
  tx: WritableDb,
  runId: string,
  correction: {
    uuid: string;
    userId: string;
    boardType: string;
    origin: string;
    previousClimbedAt: string;
    correctedClimbedAt: string;
    offsetSeconds: number;
    anchorKeyCount: number;
    anchorTrust: string;
    evidence: string;
  },
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE boardsesh_ticks
       SET climbed_at = ${correction.correctedClimbedAt}::timestamp,
           aurora_synced_at = NOW()
     WHERE uuid = ${correction.uuid}
       AND climbed_at = ${correction.previousClimbedAt}::timestamp
  `);
  if (affectedRowCount(result) === 0) return false;

  await tx.insert(tickClimbedAtCorrections).values({
    runId,
    tickUuid: correction.uuid,
    userId: correction.userId,
    boardType: correction.boardType,
    origin: correction.origin,
    previousClimbedAt: correction.previousClimbedAt,
    correctedClimbedAt: correction.correctedClimbedAt,
    offsetSeconds: correction.offsetSeconds,
    anchorKeyCount: correction.anchorKeyCount,
    anchorTrust: correction.anchorTrust,
    evidence: correction.evidence,
  });
  return true;
}

/** Undo a run. The `climbed_at = corrected` predicate never clobbers a later edit. */
async function revertRun(db: ScriptDb, runId: string): Promise<{ reverted: number; keys: ClimbStatsKey[] }> {
  // Join back to the tick for the stats key: board_climb_stats aggregates on
  // the RAW boardsesh_ticks.climb_uuid, not the canonical one, so the key must
  // be the value actually stored on the row.
  const rows = await db
    .select({
      id: tickClimbedAtCorrections.id,
      tickUuid: tickClimbedAtCorrections.tickUuid,
      previousClimbedAt: tickClimbedAtCorrections.previousClimbedAt,
      correctedClimbedAt: tickClimbedAtCorrections.correctedClimbedAt,
      boardType: boardseshTicks.boardType,
      climbUuid: boardseshTicks.climbUuid,
      angle: boardseshTicks.angle,
    })
    .from(tickClimbedAtCorrections)
    .innerJoin(boardseshTicks, eq(boardseshTicks.uuid, tickClimbedAtCorrections.tickUuid))
    .where(and(eq(tickClimbedAtCorrections.runId, runId), isNull(tickClimbedAtCorrections.revertedAt)));

  let reverted = 0;
  const keys = new Map<string, ClimbStatsKey>();
  for (const row of rows) {
    await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE boardsesh_ticks
           SET climbed_at = ${row.previousClimbedAt}::timestamp,
               aurora_synced_at = NOW()
         WHERE uuid = ${row.tickUuid}
           AND climbed_at = ${row.correctedClimbedAt}::timestamp
      `);
      if (affectedRowCount(result) === 0) return;
      await tx
        .update(tickClimbedAtCorrections)
        .set({ revertedAt: sql`NOW()` as unknown as string })
        .where(eq(tickClimbedAtCorrections.id, row.id));
      reverted += 1;
      keys.set(`${row.boardType} ${row.climbUuid} ${row.angle}`, {
        boardType: row.boardType,
        climbUuid: row.climbUuid,
        angle: row.angle,
      });
    });
  }
  return { reverted, keys: [...keys.values()] };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const databaseUrl = getScriptDatabaseUrl();
  const mode = parsed.revertRunId ? 'revert' : parsed.apply ? 'apply' : 'report';

  // Printed before any guard branch: the operator sees the target either way.
  console.log(
    `[backfill-tick-timezones] target=${describeDatabaseHost(databaseUrl)} mode=${mode} origin=${parsed.origins.join(',')}`,
  );

  if (!parsed.apply) {
    console.log('[backfill-tick-timezones] REPORT ONLY — read-only connection, nothing will be written.');
    console.log('[backfill-tick-timezones] pass --apply to write (and read docs/tick-timezone-correction.md first).');
  } else {
    const decision = resolveBackfillTargetDecision(databaseUrl, process.env[TICK_TZ_BACKFILL_ALLOW_REMOTE_ENV_VAR]);
    if (decision === 'remote-refused') {
      console.error('❌ Refusing to --apply against a non-local database.');
      console.error('   This rewrites boardsesh_ticks.climbed_at. Read docs/tick-timezone-correction.md,');
      console.error('   confirm the writer guard is deployed and a restore point exists, then set');
      console.error(`   ${TICK_TZ_BACKFILL_ALLOW_REMOTE_ENV_VAR}=1 for a deliberate run.`);
      process.exit(1);
    }
    if (decision === 'remote-allowed') {
      console.warn(
        `⚠️  ${TICK_TZ_BACKFILL_ALLOW_REMOTE_ENV_VAR}=1 — writing to a NON-LOCAL database (${describeDatabaseHost(databaseUrl)}).`,
      );
    }
  }

  const { db, close } = parsed.apply ? createScriptDb(databaseUrl) : createReadOnlyScriptDb(databaseUrl);
  try {
    if (parsed.revertRunId) {
      if (!parsed.apply) {
        console.log(`[backfill-tick-timezones] would revert run ${parsed.revertRunId}; pass --apply to do it.`);
        return;
      }
      const { reverted, keys } = await revertRun(db, parsed.revertRunId);
      console.log(`[backfill-tick-timezones] reverted ${reverted} ticks from run ${parsed.revertRunId}.`);
      if (keys.length > 0) {
        console.log(`[backfill-tick-timezones] recomputing stats for ${keys.length} keys…`);
        await recomputeClimbStatsBulk(db, keys);
      }
      return;
    }

    const rows = await fetchAuditTickRows(db, { userId: parsed.userId, batchSize: parsed.batchSize });
    const audit = buildAudit(rows, parsed.origins);
    const rowByUuid = new Map(rows.map((row) => [row.uuid, row]));

    const shifts = audit.decisions.filter(({ verdict }) => verdict.verdict === 'shift');
    const planned = parsed.limit === null ? shifts : shifts.slice(0, parsed.limit);

    console.log(`[backfill-tick-timezones] verdicts: ${JSON.stringify(audit.verdictCounts)}`);
    console.log(`[backfill-tick-timezones] offsets:  ${JSON.stringify(audit.shiftOffsetHistogram)}`);
    console.log(
      `[backfill-tick-timezones] ${planned.length} of ${shifts.length} correctable ticks selected` +
        `${parsed.limit === null ? '' : ` (--limit ${parsed.limit})`}.`,
    );

    if (!parsed.apply) {
      for (const { suspect, verdict } of planned.slice(0, 20)) {
        if (verdict.verdict !== 'shift') continue;
        console.log(
          `    ${suspect.uuid} ${new Date(suspect.climbedAtMs).toISOString()} → ` +
            `${new Date(verdict.correctedMs).toISOString()} (${formatOffset(verdict.offsetSeconds)}, ` +
            `${verdict.evidence.anchorKeyCount} keys, ${verdict.evidence.anchorTrust})`,
        );
      }
      if (planned.length > 20) console.log(`    … and ${planned.length - 20} more.`);
      return;
    }

    const runId = randomUUID();
    console.log(`[backfill-tick-timezones] run id ${runId} — revert with --revert ${runId} --apply`);

    // Grouped per climber, one transaction each. Never one giant transaction:
    // it would hold locks across the whole logbook table and could not be
    // resumed after a failure.
    const byUser = new Map<string, typeof planned>();
    for (const decision of planned) {
      const list = byUser.get(decision.suspect.userId);
      if (list) list.push(decision);
      else byUser.set(decision.suspect.userId, [decision]);
    }

    const touchedKeys = new Map<string, ClimbStatsKey>();
    let written = 0;
    let skipped = 0;
    for (const [userId, decisions] of byUser) {
      await db.transaction(async (tx) => {
        for (const { suspect, verdict } of decisions) {
          if (verdict.verdict !== 'shift') continue;
          const row = rowByUuid.get(suspect.uuid);
          if (!row) continue;
          const applied = await applyOneCorrection(tx, runId, {
            uuid: suspect.uuid,
            userId,
            boardType: suspect.boardType,
            origin: suspect.origin,
            previousClimbedAt: row.climbedAt,
            correctedClimbedAt: new Date(verdict.correctedMs).toISOString(),
            offsetSeconds: verdict.offsetSeconds,
            anchorKeyCount: verdict.evidence.anchorKeyCount,
            anchorTrust: verdict.evidence.anchorTrust,
            evidence: JSON.stringify(verdict.evidence),
          });
          if (applied) {
            written += 1;
            // RAW climb_uuid, not the canonical one: board_climb_stats
            // aggregates over boardsesh_ticks.climb_uuid as stored, so keying
            // the recompute on the canonical uuid would refresh a row whose
            // inputs did not change and leave the one that did stale.
            const key: ClimbStatsKey = {
              boardType: suspect.boardType,
              climbUuid: row.climbUuid,
              angle: suspect.angle,
            };
            touchedKeys.set(`${key.boardType} ${key.climbUuid} ${key.angle}`, key);
          } else {
            skipped += 1;
          }
        }
      });
    }

    console.log(`[backfill-tick-timezones] wrote ${written}, skipped ${skipped} (edited since the decision).`);
    if (touchedKeys.size > 0) {
      console.log(`[backfill-tick-timezones] recomputing stats for ${touchedKeys.size} keys…`);
      await recomputeClimbStatsBulk(db, [...touchedKeys.values()]);
    }
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    if (error instanceof ArgError) {
      console.error(`[backfill-tick-timezones] ${error.message}`);
      process.exit(1);
    }
    console.error('[backfill-tick-timezones] failed:', error);
    process.exit(1);
  });
}
