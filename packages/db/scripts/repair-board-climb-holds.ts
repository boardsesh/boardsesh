/**
 * Repair historical `board_climb_holds` drift caused by multi-frame Aurora
 * climbs being flattened through the old parser. Dry-run is the default.
 * See docs/board-climb-holds-repair.md before pointing this at a remote DB.
 */
import { pathToFileURL } from 'node:url';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { executeRows } from '../src/client/index.js';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import {
  buildRepairManifest,
  digestRepairManifest,
  placementKey,
  sortRepairRows,
  type RepairClimbInput,
  type RepairHoldRow,
  type RepairManifest,
} from './repair-board-climb-holds-helpers.js';

export type RepairQueryExecutor = { execute(query: SQLWrapper | string): PromiseLike<unknown> };

type ScriptArgs = {
  apply: boolean;
  expectedDigest: string | null;
  expectedScanned: number | null;
  expectedChanged: number | null;
  expectedInvalid: number | null;
  maxAffected: number | null;
  reportLimit: number;
  help: boolean;
};

const VALUE_FLAGS = new Set([
  '--expected-digest',
  '--expected-scanned',
  '--expected-changed',
  '--expected-invalid',
  '--max-affected',
  '--report-limit',
]);

function parseNonnegativeInteger(flag: string, raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flag} requires a nonnegative integer`);
  return parsed;
}

export function parseRepairArgs(args: string[]): ScriptArgs {
  const values = new Map<string, string>();
  let apply = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === '--') continue;
    if (current === '--apply') {
      apply = true;
      continue;
    }
    if (current === '--help') {
      help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(current)) throw new Error(`unknown argument: ${current}`);
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith('--')) throw new Error(`${current} requires a value`);
    values.set(current, optionValue);
    index += 1;
  }

  const parsed: ScriptArgs = {
    apply,
    help,
    expectedDigest: values.get('--expected-digest') ?? null,
    expectedScanned: values.has('--expected-scanned')
      ? parseNonnegativeInteger('--expected-scanned', values.get('--expected-scanned'))
      : null,
    expectedChanged: values.has('--expected-changed')
      ? parseNonnegativeInteger('--expected-changed', values.get('--expected-changed'))
      : null,
    expectedInvalid: values.has('--expected-invalid')
      ? parseNonnegativeInteger('--expected-invalid', values.get('--expected-invalid'))
      : null,
    maxAffected: values.has('--max-affected')
      ? parseNonnegativeInteger('--max-affected', values.get('--max-affected'))
      : null,
    reportLimit: values.has('--report-limit')
      ? parseNonnegativeInteger('--report-limit', values.get('--report-limit'))
      : 50,
  };
  if (
    apply &&
    [
      parsed.expectedDigest,
      parsed.expectedScanned,
      parsed.expectedChanged,
      parsed.expectedInvalid,
      parsed.maxAffected,
    ].some((value) => value === null)
  ) {
    throw new Error(
      '--apply requires --expected-digest, --expected-scanned, --expected-changed, --expected-invalid, and --max-affected',
    );
  }
  return parsed;
}

type CandidateJoinedRow = {
  board_type: string;
  uuid: string;
  layout_id: number;
  frames: string | null;
  frames_count: number | null;
  hold_fingerprint: string | null;
  multi_frame_target: boolean;
  hold_id: number | null;
  frame_number: number | null;
  hold_state: string | null;
};

export async function fetchCandidateClimbs(executor: RepairQueryExecutor): Promise<RepairClimbInput[]> {
  const auroraBoardList = sql.join(
    AURORA_BOARDS.map((boardName) => sql`${boardName}`),
    sql`, `,
  );
  const joinedRows = await executeRows<CandidateJoinedRow>(
    executor,
    sql`
      WITH candidate_keys AS (
        SELECT bc.board_type, bc.uuid, TRUE AS multi_frame_target
        FROM board_climbs bc
        WHERE bc.board_type IN (${auroraBoardList})
          AND bc.frames_count > 1
        UNION ALL
        SELECT invalid.board_type, invalid.climb_uuid AS uuid, FALSE AS multi_frame_target
        FROM board_climb_holds invalid
        WHERE invalid.hold_id <= 0 OR invalid.hold_state = '' OR invalid.hold_state LIKE '%=%'
      ),
      candidate_identity AS (
        SELECT board_type, uuid, BOOL_OR(multi_frame_target) AS multi_frame_target
        FROM candidate_keys
        GROUP BY board_type, uuid
      ),
      candidates AS (
        SELECT
          candidate_identity.board_type,
          candidate_identity.uuid,
          candidate_identity.multi_frame_target,
          bc.layout_id,
          bc.frames,
          bc.frames_count,
          CASE
            WHEN bc.board_type = candidate_identity.board_type THEN bc.hold_fingerprint
            ELSE NULL
          END AS hold_fingerprint
        FROM candidate_identity
        -- board_climbs.uuid is the table's global primary key. This UUID-only
        -- join is deliberate: a corrupt board_climb_holds row can carry a
        -- different board_type from its parent while its FK still references
        -- only uuid. Keeping that child identity lets the repair delete it;
        -- joining board_type here would strand the invalid row.
        INNER JOIN board_climbs bc ON bc.uuid = candidate_identity.uuid
      )
      SELECT
        candidates.board_type,
        candidates.uuid,
        candidates.layout_id,
        candidates.frames,
        candidates.frames_count,
        candidates.hold_fingerprint,
        candidates.multi_frame_target,
        holds.hold_id,
        holds.frame_number,
        holds.hold_state
      FROM candidates
      LEFT JOIN board_climb_holds holds
        ON holds.board_type = candidates.board_type
       AND holds.climb_uuid = candidates.uuid
      ORDER BY candidates.board_type, candidates.uuid, holds.hold_id, holds.frame_number, holds.hold_state
    `,
  );

  const climbs: RepairClimbInput[] = [];
  for (const row of joinedRows) {
    const previous = climbs[climbs.length - 1];
    const climb =
      previous?.boardType === row.board_type && previous.uuid === row.uuid
        ? previous
        : {
            boardType: row.board_type,
            uuid: row.uuid,
            layoutId: row.layout_id,
            frames: row.frames,
            framesCount: row.frames_count,
            holdFingerprint: row.hold_fingerprint,
            multiFrameTarget: row.multi_frame_target,
            rows: [],
          };
    if (climb !== previous) climbs.push(climb);
    if (row.hold_id !== null && row.frame_number !== null && row.hold_state !== null) {
      climb.rows.push({ holdId: row.hold_id, frameNumber: row.frame_number, holdState: row.hold_state });
    }
  }
  return climbs;
}

type PlacementReference = { board_type: string; layout_id: number; hold_id: number };

async function fetchExistingPlacementKeys(
  executor: RepairQueryExecutor,
  climbs: ReadonlyArray<RepairClimbInput>,
): Promise<Set<string>> {
  const preliminary = buildRepairManifest(climbs, new Set<string>());
  const references: PlacementReference[] = preliminary.entries.flatMap((entry) =>
    (entry.projectedRows ?? []).map((row) => ({
      board_type: entry.boardType,
      layout_id: entry.layoutId,
      hold_id: row.holdId,
    })),
  );
  if (references.length === 0) return new Set();
  const rows = await executeRows<PlacementReference>(
    executor,
    sql`
      WITH projected AS (
        SELECT DISTINCT board_type, layout_id, hold_id
        FROM jsonb_to_recordset(${JSON.stringify(references)}::jsonb)
          AS row(board_type text, layout_id integer, hold_id integer)
      )
      SELECT projected.board_type, projected.layout_id, projected.hold_id
      FROM projected
      INNER JOIN board_placements placement
        ON placement.board_type = projected.board_type
       AND placement.layout_id = projected.layout_id
       AND placement.id = projected.hold_id
      ORDER BY projected.board_type, projected.layout_id, projected.hold_id
    `,
  );
  return new Set(rows.map((row) => placementKey(row.board_type, row.layout_id, row.hold_id)));
}

async function buildManifest(executor: RepairQueryExecutor): Promise<RepairManifest> {
  const climbs = await fetchCandidateClimbs(executor);
  const placementKeys = await fetchExistingPlacementKeys(executor, climbs);
  return buildRepairManifest(climbs, placementKeys);
}

function verifyGuards(args: ScriptArgs, manifest: RepairManifest, digest: string): void {
  const mismatches: string[] = [];
  if (args.expectedDigest !== digest) mismatches.push(`digest expected=${args.expectedDigest} actual=${digest}`);
  if (args.expectedScanned !== manifest.counts.scannedClimbs) {
    mismatches.push(`scanned expected=${args.expectedScanned} actual=${manifest.counts.scannedClimbs}`);
  }
  if (args.expectedChanged !== manifest.counts.changedMultiFrameClimbs) {
    mismatches.push(`changed expected=${args.expectedChanged} actual=${manifest.counts.changedMultiFrameClimbs}`);
  }
  if (args.expectedInvalid !== manifest.counts.invalidRows) {
    mismatches.push(`invalid expected=${args.expectedInvalid} actual=${manifest.counts.invalidRows}`);
  }
  if (args.maxAffected !== null && manifest.counts.affectedClimbs > args.maxAffected) {
    mismatches.push(`affected=${manifest.counts.affectedClimbs} exceeds max=${args.maxAffected}`);
  }
  if (manifest.counts.blockers > 0) mismatches.push(`manifest has ${manifest.counts.blockers} blocker(s)`);
  if (mismatches.length > 0) throw new Error(`repair guard failed: ${mismatches.join('; ')}`);
}

function printManifest(manifest: RepairManifest, digest: string, reportLimit: number, apply: boolean): void {
  console.info(`[repair-board-climb-holds] manifest_sha256=${digest}`);
  console.info(
    `[repair-board-climb-holds] scanned=${manifest.counts.scannedClimbs} multi_frame=${manifest.counts.scannedMultiFrameClimbs} changed=${manifest.counts.changedMultiFrameClimbs} affected=${manifest.counts.affectedClimbs} invalid_rows=${manifest.counts.invalidRows}`,
  );
  console.info(
    `[repair-board-climb-holds] delete_rows=${manifest.counts.deleteRows} insert_rows=${manifest.counts.insertRows} fingerprint_updates=${manifest.counts.fingerprintUpdates} blockers=${manifest.counts.blockers}`,
  );
  console.info(
    `[repair-board-climb-holds] skipped_unknown_roles=${manifest.counts.skippedUnknownRoleTokens} skipped_nonpositive_ids=${manifest.counts.skippedNonpositiveHoldIdTokens} missing_placements=${manifest.counts.missingPlacements}`,
  );
  const noteworthy = manifest.entries.filter(
    (entry) =>
      entry.changed ||
      entry.invalidRows.length > 0 ||
      entry.fingerprint.shouldUpdate ||
      entry.blockers.length > 0 ||
      entry.diagnostics.skippedUnknownRoleTokens > 0 ||
      entry.diagnostics.skippedNonpositiveHoldIdTokens > 0 ||
      entry.diagnostics.missingPlacementHoldIds.length > 0,
  );
  for (const entry of noteworthy.slice(0, reportLimit)) {
    console.info(
      `[repair-board-climb-holds] ${entry.boardType}/${entry.uuid} changed=${entry.changed} invalid=${entry.invalidRows.length} old_rows=${entry.oldRows.length} projected_rows=${entry.projectedRows?.length ?? '-'} old_hash=${entry.rowHashes.old} projected_hash=${entry.rowHashes.projected} fingerprint=${entry.fingerprint.classification} unknown_roles=${entry.diagnostics.skippedUnknownRoleTokens} nonpositive=${entry.diagnostics.skippedNonpositiveHoldIdTokens} missing_placements=${entry.diagnostics.missingPlacementHoldIds.join(',') || '-'} blockers=${entry.blockers.join('|') || '-'}`,
    );
  }
  if (noteworthy.length > reportLimit) {
    console.info(`[repair-board-climb-holds] report truncated: ${noteworthy.length - reportLimit} additional climb(s)`);
  }
  if (!apply) console.info('[repair-board-climb-holds] dry-run only; no locks or writes were taken');
}

type MutationRow = RepairHoldRow & { boardType: string; climbUuid: string };

function climbIdentityKey(boardType: string, climbUuid: string): string {
  return `${boardType}\u0000${climbUuid}`;
}

export async function applyRepairManifest(executor: RepairQueryExecutor, manifest: RepairManifest): Promise<void> {
  const recomputedBlockerCount = manifest.entries.reduce((total, entry) => total + entry.blockers.length, 0);
  if (manifest.counts.blockers !== recomputedBlockerCount) {
    throw new Error(
      `refusing to apply a repair manifest with inconsistent blocker counts: summary=${manifest.counts.blockers} entries=${recomputedBlockerCount}`,
    );
  }
  if (recomputedBlockerCount > 0) {
    throw new Error(`refusing to apply a repair manifest with ${recomputedBlockerCount} blocker(s)`);
  }

  const changedEntries = manifest.entries.filter((entry) => entry.changed);
  const invalidOnlyEntries = manifest.entries.filter((entry) => !entry.multiFrame && entry.invalidRows.length > 0);

  if (changedEntries.length > 0) {
    const deleted = await executeRows<{ board_type: string }>(
      executor,
      sql`
        WITH changed AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            changedEntries.map((entry) => ({ board_type: entry.boardType, climb_uuid: entry.uuid })),
          )}::jsonb) AS row(board_type text, climb_uuid text)
        )
        DELETE FROM board_climb_holds stored
        USING changed
        WHERE stored.board_type = changed.board_type
          AND stored.climb_uuid = changed.climb_uuid
        RETURNING stored.board_type
      `,
    );
    const expectedDeletedRows = changedEntries.reduce((total, entry) => total + entry.oldRows.length, 0);
    if (deleted.length !== expectedDeletedRows) {
      throw new Error('deleted changed-row count did not match the manifest');
    }
  }
  const insertionRows: MutationRow[] = changedEntries.flatMap((entry) =>
    (entry.projectedRows ?? []).map((row) => ({ ...row, boardType: entry.boardType, climbUuid: entry.uuid })),
  );
  if (insertionRows.length > 0) {
    const returned = await executeRows<{ board_type: string }>(
      executor,
      sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        SELECT board_type, climb_uuid, hold_id, frame_number, hold_state
        FROM jsonb_to_recordset(${JSON.stringify(
          insertionRows.map((row) => ({
            board_type: row.boardType,
            climb_uuid: row.climbUuid,
            hold_id: row.holdId,
            frame_number: row.frameNumber,
            hold_state: row.holdState,
          })),
        )}::jsonb) AS row(board_type text, climb_uuid text, hold_id integer, frame_number integer, hold_state text)
        RETURNING board_type
      `,
    );
    if (returned.length !== insertionRows.length) throw new Error('inserted row count did not match the manifest');
  }

  const invalidRows = invalidOnlyEntries.flatMap((entry) =>
    entry.invalidRows.map((row) => ({ ...row, boardType: entry.boardType, climbUuid: entry.uuid })),
  );
  if (invalidRows.length > 0) {
    const deleted = await executeRows<{ board_type: string }>(
      executor,
      sql`
        WITH doomed AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            invalidRows.map((row) => ({
              board_type: row.boardType,
              climb_uuid: row.climbUuid,
              hold_id: row.holdId,
              frame_number: row.frameNumber,
              hold_state: row.holdState,
            })),
          )}::jsonb) AS row(board_type text, climb_uuid text, hold_id integer, frame_number integer, hold_state text)
        )
        DELETE FROM board_climb_holds stored
        USING doomed
        WHERE stored.board_type = doomed.board_type
          AND stored.climb_uuid = doomed.climb_uuid
          AND stored.hold_id = doomed.hold_id
          AND stored.frame_number = doomed.frame_number
          AND stored.hold_state = doomed.hold_state
        RETURNING stored.board_type
      `,
    );
    if (deleted.length !== invalidRows.length) throw new Error('deleted invalid row count did not match the manifest');
  }

  const fingerprintUpdates = manifest.entries.filter((candidate) => candidate.fingerprint.shouldUpdate);
  if (fingerprintUpdates.length > 0) {
    const updated = await executeRows<{ board_type: string; uuid: string }>(
      executor,
      sql`
        WITH changes AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            fingerprintUpdates.map((entry) => ({
              board_type: entry.boardType,
              uuid: entry.uuid,
              old_fingerprint: entry.fingerprint.old,
              projected_fingerprint: entry.fingerprint.projected,
            })),
          )}::jsonb)
            AS row(board_type text, uuid text, old_fingerprint text, projected_fingerprint text)
        )
        UPDATE board_climbs stored
        SET hold_fingerprint = changes.projected_fingerprint
        FROM changes
        WHERE stored.board_type = changes.board_type
          AND stored.uuid = changes.uuid
          AND stored.hold_fingerprint IS NOT DISTINCT FROM changes.old_fingerprint
        RETURNING stored.board_type, stored.uuid
      `,
    );
    const updatedKeys = new Set(updated.map((row) => climbIdentityKey(row.board_type, row.uuid)));
    const failedKeys = fingerprintUpdates
      .filter((entry) => !updatedKeys.has(climbIdentityKey(entry.boardType, entry.uuid)))
      .map((entry) => `${entry.boardType}/${entry.uuid}`);
    if (updated.length !== fingerprintUpdates.length || failedKeys.length > 0) {
      throw new Error(`fingerprint guard failed for ${failedKeys.join(', ') || 'unexpected duplicate identity'}`);
    }
  }
}

export async function verifyAppliedRepair(executor: RepairQueryExecutor, manifest: RepairManifest): Promise<void> {
  const changedEntries = manifest.entries.filter((entry) => entry.changed);
  const actualRowsByIdentity = new Map<string, RepairHoldRow[]>(
    changedEntries.map((entry) => [climbIdentityKey(entry.boardType, entry.uuid), []]),
  );
  if (changedEntries.length > 0) {
    const actual = await executeRows<{
      board_type: string;
      climb_uuid: string;
      hold_id: number;
      frame_number: number;
      hold_state: string;
    }>(
      executor,
      sql`
        WITH targets AS (
          SELECT *
          FROM jsonb_to_recordset(${JSON.stringify(
            changedEntries.map((entry) => ({ board_type: entry.boardType, climb_uuid: entry.uuid })),
          )}::jsonb) AS row(board_type text, climb_uuid text)
        )
        SELECT stored.board_type, stored.climb_uuid, stored.hold_id, stored.frame_number, stored.hold_state
        FROM board_climb_holds stored
        INNER JOIN targets
          ON targets.board_type = stored.board_type
         AND targets.climb_uuid = stored.climb_uuid
        ORDER BY stored.board_type, stored.climb_uuid, stored.hold_id, stored.frame_number, stored.hold_state
      `,
    );
    for (const row of actual) {
      const identityRows = actualRowsByIdentity.get(climbIdentityKey(row.board_type, row.climb_uuid));
      if (!identityRows) throw new Error(`post-write verification returned an unexpected identity`);
      identityRows.push({ holdId: row.hold_id, frameNumber: row.frame_number, holdState: row.hold_state });
    }
  }
  for (const entry of changedEntries) {
    const actualRows = sortRepairRows(actualRowsByIdentity.get(climbIdentityKey(entry.boardType, entry.uuid)) ?? []);
    if (JSON.stringify(actualRows) !== JSON.stringify(entry.projectedRows)) {
      throw new Error(`post-write row verification failed for ${entry.boardType}/${entry.uuid}`);
    }
  }
  const [{ invalid_count: invalidCount } = { invalid_count: -1 }] = await executeRows<{ invalid_count: number }>(
    executor,
    sql`
      SELECT COUNT(*)::integer AS invalid_count
      FROM board_climb_holds
      WHERE hold_id <= 0 OR hold_state = '' OR hold_state LIKE '%=%'
    `,
  );
  if (invalidCount !== 0) throw new Error(`post-write global invalid row count is ${invalidCount}, expected 0`);
}

export async function runRepair(
  args: ScriptArgs,
  database: ReturnType<typeof createScriptDb> = createScriptDb(),
): Promise<{ manifest: RepairManifest; digest: string; applied: boolean }> {
  try {
    const initialManifest = await buildManifest(database.db);
    const initialDigest = digestRepairManifest(initialManifest);
    printManifest(initialManifest, initialDigest, args.reportLimit, args.apply);
    if (!args.apply) return { manifest: initialManifest, digest: initialDigest, applied: false };
    verifyGuards(args, initialManifest, initialDigest);

    await database.db.transaction(
      async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout = '120s'`);
        // LOCK TABLE does not freeze a REPEATABLE READ view; PostgreSQL freezes
        // it at the first SELECT or data-modification statement. Keep both
        // writer-blocking locks before the advisory-lock SELECT so the manifest
        // includes writers that committed while lock acquisition waited.
        await transaction.execute(sql`LOCK TABLE board_climbs IN SHARE ROW EXCLUSIVE MODE`);
        await transaction.execute(sql`LOCK TABLE board_climb_holds IN SHARE ROW EXCLUSIVE MODE`);
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:repair-board-climb-holds:v1'))`);

        const lockedManifest = await buildManifest(transaction);
        const lockedDigest = digestRepairManifest(lockedManifest);
        verifyGuards(args, lockedManifest, lockedDigest);
        await applyRepairManifest(transaction, lockedManifest);
        await verifyAppliedRepair(transaction, lockedManifest);
      },
      { isolationLevel: 'repeatable read' },
    );
    console.info('[repair-board-climb-holds] apply committed and post-write verification passed');
    return { manifest: initialManifest, digest: initialDigest, applied: true };
  } finally {
    await database.close();
  }
}

export function getRepairOperatorHint(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if ('code' in current && current.code === '55P03') {
      return 'could not acquire repair locks within 5 seconds; retry after write traffic drops';
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}

function printHelp(): void {
  console.info(`Usage:
  vp run db:repair-board-climb-holds
  vp run db:repair-board-climb-holds -- --report-limit 100
  vp run db:repair-board-climb-holds -- --apply \\
    --expected-digest <sha256> --expected-scanned <n> \\
    --expected-changed <n> --expected-invalid <n> --max-affected <n>

Dry-run is the default. Apply guards must exactly match a reviewed dry-run.`);
}

async function main(): Promise<void> {
  try {
    const args = parseRepairArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const databaseUrl = getScriptDatabaseUrl();
    console.info(`[repair-board-climb-holds] database_host=${describeDatabaseHost(databaseUrl)}`);
    await runRepair(args, createScriptDb(databaseUrl));
  } catch (error) {
    const operatorHint = getRepairOperatorHint(error);
    if (operatorHint) {
      console.error(`[repair-board-climb-holds] failed: ${operatorHint}`, error);
    } else {
      console.error('[repair-board-climb-holds] failed:', error);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
