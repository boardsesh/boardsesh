/**
 * Export the Climb2Vec training matrix — one JSONL row per graded (climb, angle)
 * — for offline model training + validation (ml/climb2vec/). Each row carries the
 * climb's holds, each hold's generated board_hold_features, the angle, the crowd
 * grade label, the ascent weight, and the hold_fingerprint.
 *
 * Requires board_hold_features to be populated first
 * (`refresh-hold-features.ts`). Reads only; writes a JSONL file, no DB writes.
 *
 * Run: `node --import tsx packages/db/scripts/extract-training-matrix.ts \
 *        --board=kilter --out=ml/climb2vec/data/kilter-train.jsonl`
 * Flags: --board=<name> (default kilter) · --out=<path> · --min-ascents=<n> (20)
 *        · --angle=<deg> (optional single-angle slice, e.g. 40) · --limit=<n>.
 */
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { climbHoldPlacementMatchSql, moonBoardPlacementCoverageSql } from '../src/queries/climbs/placement-match.js';
import {
  buildTrainingRow,
  type HoldFeatureLite,
  type ClimbStatLite,
  type HoldLite,
} from '../src/queries/hold-features/index.js';
import { DEFAULT_ECHO_FRACTION } from '../src/queries/grade-model/index.js';

const DEFAULT_OUT = 'ml/climb2vec/data/kilter-train.jsonl';
const DEFAULT_MIN_ASCENTS = 20;

type Db = ReturnType<typeof createScriptDb>['db'];

interface Options {
  board: string;
  out: string;
  minAscents: number;
  angle: number | null;
  limit: number | null;
  /** Score mode: emit EVERY listed (climb, angle) with holds — no ascent/label gate — for model scoring. */
  scoreAll: boolean;
}

/** The ascent/label gate for training; empty in score mode (grade everything). */
function gradeGate(options: Options) {
  return options.scoreAll
    ? sql``
    : sql`AND st.ascensionist_count >= ${options.minAscents} AND st.difficulty_average IS NOT NULL`;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

async function loadFeatures(db: Db, board: string): Promise<Map<number, HoldFeatureLite>> {
  const rows = (await db.execute(sql`
    SELECT placement_id, norm_x, norm_y, edge_dist, neighbor_dist,
           hand_difficulty, foot_difficulty, pull_direction, is_kickboard, coarse_type
    FROM board_hold_features WHERE board_type = ${board}
  `)) as unknown as HoldFeatureLite[];
  const map = new Map<number, HoldFeatureLite>();
  for (const row of rows) map.set(toNumber(row.placement_id), row);
  return map;
}

async function loadStats(db: Db, options: Options): Promise<ClimbStatLite[]> {
  const angleFilter = options.angle === null ? sql`` : sql`AND st.angle = ${options.angle}`;
  const limitClause = options.limit === null ? sql`` : sql`LIMIT ${options.limit}`;
  const placementCoverage = moonBoardPlacementCoverageSql({
    boardType: sql.raw('c.board_type'),
    climbUuid: sql.raw('c.uuid'),
    layoutId: sql.raw('c.layout_id'),
  });
  return (await db.execute(sql`
    SELECT st.climb_uuid AS climb_uuid, st.angle AS angle, COALESCE(st.difficulty_average, 0) AS label,
           COALESCE(st.ascensionist_count, 0) AS n, c.layout_id AS layout_id, c.hold_fingerprint AS fingerprint,
           st.display_difficulty AS display, st.benchmark_difficulty AS benchmark
    FROM board_climb_stats st
    JOIN board_climbs c ON c.uuid = st.climb_uuid
    WHERE st.board_type = ${options.board}
      AND c.is_listed = true
      AND COALESCE(c.is_draft, false) = false
      ${gradeGate(options)}
      ${angleFilter}
      AND ${placementCoverage}
    ORDER BY st.climb_uuid, st.angle
    ${limitClause}
  `)) as unknown as ClimbStatLite[];
}

/**
 * The board's quick-log echo share (λ) from the freshest coefficient set, so the
 * extract de-herds crowd labels exactly as the grade pipeline does. Mirrors the
 * freshest-coeff_version subquery in `loadFrozenCoefficients` (refresh-climb-grades.ts),
 * scoped to this board's echo_fraction row; falls back to the model default when
 * no coefficients are stored yet. Unlike the grade pipeline it skips the
 * COEFF_MAX_AGE_DAYS staleness guard — the extract runs right after the nightly
 * refresh, and a slightly stale λ beats refitting from ticks here.
 */
async function loadEchoFraction(db: Db, board: string): Promise<{ lambda: number; ageDays: number | null }> {
  const rows = (await db.execute(sql`
    SELECT payload, created_at
    FROM board_grade_coefficients
    WHERE kind = 'echo_fraction'
      AND key = ${board}
      AND coeff_version = (
        SELECT coeff_version
        FROM board_grade_coefficients
        WHERE kind <> 'gate_results'
        GROUP BY coeff_version
        ORDER BY MAX(created_at) DESC
        LIMIT 1
      )
    LIMIT 1
  `)) as unknown as Array<{ payload: { lambda?: number } | null; created_at: string | Date | null }>;
  const lambda = rows[0]?.payload?.lambda;
  if (typeof lambda !== 'number' || !Number.isFinite(lambda)) {
    return { lambda: DEFAULT_ECHO_FRACTION, ageDays: null };
  }
  const createdAt = rows[0]?.created_at ? new Date(rows[0].created_at) : null;
  const ageDays =
    createdAt && Number.isFinite(createdAt.getTime())
      ? Math.round((Date.now() - createdAt.getTime()) / 86_400_000)
      : null;
  return { lambda, ageDays };
}

async function loadHoldsByClimb(db: Db, options: Options): Promise<Map<string, HoldLite[]>> {
  const placementMatch = climbHoldPlacementMatchSql({
    boardType: sql.raw('ch.board_type'),
    climbHoldId: sql.raw('ch.hold_id'),
    placementId: sql.raw('p.id'),
    placementHoleId: sql.raw('p.hole_id'),
  });
  const placementCoverage = moonBoardPlacementCoverageSql({
    boardType: sql.raw('c.board_type'),
    climbUuid: sql.raw('c.uuid'),
    layoutId: sql.raw('c.layout_id'),
  });
  const rows = (await db.execute(sql`
    SELECT ch.climb_uuid AS climb_uuid, p.id AS placement_id, ch.hold_state AS hold_state
    FROM board_climb_holds ch
    JOIN board_climbs c
      ON c.board_type = ch.board_type AND c.uuid = ch.climb_uuid
    JOIN board_placements p
      ON p.board_type = ch.board_type
      AND p.layout_id = c.layout_id
      AND ${placementMatch}
    WHERE ch.board_type = ${options.board}
      AND ch.climb_uuid IN (
        SELECT st.climb_uuid FROM board_climb_stats st
        JOIN board_climbs c ON c.uuid = st.climb_uuid
        WHERE st.board_type = ${options.board}
          AND c.is_listed = true
          AND COALESCE(c.is_draft, false) = false
          ${gradeGate(options)}
          AND ${placementCoverage}
      )
  `)) as unknown as Array<{ climb_uuid: string; placement_id: number; hold_state: string }>;
  const byClimb = new Map<string, HoldLite[]>();
  for (const row of rows) {
    let list = byClimb.get(row.climb_uuid);
    if (!list) {
      list = [];
      byClimb.set(row.climb_uuid, list);
    }
    list.push({ placement_id: toNumber(row.placement_id), hold_state: row.hold_state });
  }
  return byClimb;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const angleArg = get('--angle');
  const limitArg = get('--limit');
  return {
    board: get('--board') ?? 'kilter',
    out: get('--out') ?? DEFAULT_OUT,
    minAscents: get('--min-ascents') ? Number(get('--min-ascents')) : DEFAULT_MIN_ASCENTS,
    angle: angleArg ? Number(angleArg) : null,
    limit: limitArg ? Number(limitArg) : null,
    scoreAll: argv.includes('--score'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { db, close } = createScriptDb();
  console.log(
    `[extract] board=${options.board} minAscents=${options.minAscents} angle=${options.angle ?? 'all'} → ${options.out}`,
  );
  try {
    // Score mode sorts the full catalog; disable parallel-worker shared-memory
    // segments so a big sort can't exhaust the server's /dev/shm (matches the
    // grade pipeline's guard). Session-scoped on the single script connection.
    await db.execute(sql`SET max_parallel_workers_per_gather = 0`);
    const [features, stats, holdsByClimb, echo] = await Promise.all([
      loadFeatures(db, options.board),
      loadStats(db, options),
      loadHoldsByClimb(db, options),
      loadEchoFraction(db, options.board),
    ]);
    if (features.size === 0) {
      throw new Error(`board_hold_features is empty for ${options.board} — run refresh-hold-features.ts first.`);
    }
    const echoFraction = echo.lambda;
    const echoAge = echo.ageDays === null ? 'model default (no frozen row)' : `${echo.ageDays}d old`;
    console.log(`[extract] echo fraction λ=${echoFraction.toFixed(3)} for ${options.board} (${echoAge})`);

    mkdirSync(dirname(options.out), { recursive: true });
    const stream = createWriteStream(options.out, { encoding: 'utf8' });
    let written = 0;
    let holdTotal = 0;
    for (const stat of stats) {
      const holds = holdsByClimb.get(stat.climb_uuid);
      if (!holds || holds.length === 0) continue;
      const row = buildTrainingRow(stat, holds, features, options.board, echoFraction);
      if (row.holds.length === 0) continue;
      stream.write(`${JSON.stringify(row)}\n`);
      written++;
      holdTotal += row.holds.length;
    }
    await new Promise<void>((resolve, reject) =>
      stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    console.log(
      `[extract] wrote ${written} rows (${features.size} placement features, avg ${
        written ? (holdTotal / written).toFixed(1) : 0
      } holds/row) → ${options.out}`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[extract] failed:', error);
  process.exit(1);
});
