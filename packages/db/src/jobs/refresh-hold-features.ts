/**
 * Nightly per-hold feature refresh — the generated substrate for the Climb2Vec
 * content model (grade content_prior), climb similarity, and style recs.
 *
 * For each (board_type, layout) it:
 *   1. Loads placements ⋈ holes ⋈ sets and computes angle-independent GEOMETRY
 *      features (normalized position, edge/neighbour distance, pull direction).
 *   2. Loads graded climbs (board_climb_stats, ascensionist_count ≥ MIN_ASCENTS)
 *      and their per-role holds, and fits a de-confounded per-hold BEHAVIORAL
 *      difficulty via ridge over the hold-incidence matrix (hand vs foot).
 *   3. Upserts board_hold_features (placement-keyed) and SHADOW-WRITES
 *      user_hold_classifications under a reserved system user so the dormant
 *      per-hold UI lights up (hand/foot rating quintiles + pull direction; the
 *      jug/crimp enum stays NULL — no physical shape data exists).
 *
 * Callers: the CLI `packages/db/scripts/refresh-hold-features.ts` (flags
 * --dry-run, --board=<name>, --no-shadow) and the batch worker's
 * `refresh-hold-features` family (docs/background-workers.md). Reads go
 * through `db` one at a time (the worker's pool holds two connections, one of
 * them for its heartbeat); each layout's writes commit in one `transact` batch.
 *
 * Idempotent: every write is an upsert keyed by its natural key.
 */
import { sql } from 'drizzle-orm';
import { boardHoldFeatures } from '../schema/app/hold-features';
import { userHoldClassifications } from '../schema/app/hold-classifications';
import { climbHoldPlacementMatchSql, moonBoardPlacementCoverageSql } from '../queries/climbs/placement-match';
import {
  computeGeometryFeatures,
  estimateHoldDifficulty,
  makeQuintileScaler,
  coarseTypeFromSetName,
  isKickboardHole,
  type PlacementGeom,
  type ClimbHoldObservation,
  type HoldDifficulty,
} from '../queries/hold-features';
import { ensureSystemUser } from './system-user';
import { defaultTransact, type JobDatabase, type JobLogger, type JobRunOptions, type JobTransact } from './types';

const SYSTEM_USER_ID = 'system-hold-classifier';
const SYSTEM_USER_EMAIL = 'hold-classifier@boardsesh.com';
const FEATURE_VERSION = 'v1';
const MIN_ASCENTS = 20;
const UPSERT_CHUNK = 1000;

interface PlacementRow {
  placement_id: number;
  layout_id: number | null;
  hole_id: number | null;
  set_id: number | null;
  x: number | null;
  y: number | null;
  hole_name: string | null;
  set_name: string | null;
}

interface StatRow {
  climb_uuid: string;
  label: number;
  n: number;
}

interface HoldRow {
  climb_uuid: string;
  placement_id: number;
  hold_state: string;
}

const HAND_STATES = new Set(['STARTING', 'HAND', 'FINISH']);

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

async function listLayouts(db: JobDatabase, board: string): Promise<number[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT layout_id FROM board_placements
    WHERE board_type = ${board} AND layout_id IS NOT NULL
    ORDER BY layout_id
  `)) as unknown as Array<{ layout_id: number }>;
  return rows.map((row) => toNumber(row.layout_id));
}

async function loadPlacements(db: JobDatabase, board: string, layout: number): Promise<PlacementRow[]> {
  return (await db.execute(sql`
    SELECT p.id AS placement_id, p.layout_id, p.hole_id, p.set_id,
           h.x AS x, h.y AS y, h.name AS hole_name, s.name AS set_name
    FROM board_placements p
    JOIN board_holes h ON h.board_type = p.board_type AND h.id = p.hole_id
    LEFT JOIN board_sets s ON s.board_type = p.board_type AND s.id = p.set_id
    WHERE p.board_type = ${board} AND p.layout_id = ${layout}
  `)) as unknown as PlacementRow[];
}

/** One graded observation per (climb, angle); the climb's holds are shared across its angles. */
async function loadStats(db: JobDatabase, board: string, layout: number): Promise<StatRow[]> {
  const placementCoverage = moonBoardPlacementCoverageSql({
    boardType: sql.raw('c.board_type'),
    climbUuid: sql.raw('c.uuid'),
    layoutId: sql.raw('c.layout_id'),
  });
  return (await db.execute(sql`
    SELECT st.climb_uuid AS climb_uuid, st.difficulty_average AS label, st.ascensionist_count AS n
    FROM board_climb_stats st
    JOIN board_climbs c ON c.uuid = st.climb_uuid
    WHERE st.board_type = ${board}
      AND c.layout_id = ${layout}
      AND c.is_listed = true
      AND COALESCE(c.is_draft, false) = false
      AND st.ascensionist_count >= ${MIN_ASCENTS}
      AND st.difficulty_average IS NOT NULL
      AND ${placementCoverage}
  `)) as unknown as StatRow[];
}

async function loadHolds(db: JobDatabase, board: string, layout: number): Promise<HoldRow[]> {
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
  return (await db.execute(sql`
    SELECT ch.climb_uuid AS climb_uuid, p.id AS placement_id, ch.hold_state AS hold_state
    FROM board_climb_holds ch
    JOIN board_climbs c
      ON c.board_type = ch.board_type AND c.uuid = ch.climb_uuid
    JOIN board_placements p
      ON p.board_type = ch.board_type
      AND p.layout_id = c.layout_id
      AND ${placementMatch}
    WHERE ch.board_type = ${board}
      AND c.layout_id = ${layout}
      AND ch.climb_uuid IN (
        SELECT st.climb_uuid
        FROM board_climb_stats st
        JOIN board_climbs c ON c.uuid = st.climb_uuid
        WHERE st.board_type = ${board}
          AND c.layout_id = ${layout}
          AND c.is_listed = true
          AND COALESCE(c.is_draft, false) = false
          AND st.ascensionist_count >= ${MIN_ASCENTS}
          AND st.difficulty_average IS NOT NULL
          AND ${placementCoverage}
      )
  `)) as unknown as HoldRow[];
}

async function canonicalSizeId(db: JobDatabase, board: string, layout: number): Promise<number | null> {
  const rows = (await db.execute(sql`
    SELECT product_size_id FROM board_product_sizes_layouts_sets
    WHERE board_type = ${board} AND layout_id = ${layout} AND product_size_id IS NOT NULL
    ORDER BY product_size_id
    LIMIT 1
  `)) as unknown as Array<{ product_size_id: number }>;
  return rows.length > 0 ? toNumber(rows[0].product_size_id) : null;
}

/** Group each climb's holds into hand / foot placement lists. */
function groupHoldsByClimb(holds: HoldRow[]): Map<string, { hand: number[]; foot: number[] }> {
  const byClimb = new Map<string, { hand: number[]; foot: number[] }>();
  for (const hold of holds) {
    const state = hold.hold_state;
    const isFoot = state === 'FOOT';
    const isHand = HAND_STATES.has(state);
    if (!isFoot && !isHand) continue; // skip malformed states
    let entry = byClimb.get(hold.climb_uuid);
    if (!entry) {
      entry = { hand: [], foot: [] };
      byClimb.set(hold.climb_uuid, entry);
    }
    (isFoot ? entry.foot : entry.hand).push(toNumber(hold.placement_id));
  }
  return byClimb;
}

function buildObservations(
  stats: StatRow[],
  byClimb: Map<string, { hand: number[]; foot: number[] }>,
): ClimbHoldObservation[] {
  const observations: ClimbHoldObservation[] = [];
  for (const stat of stats) {
    const holds = byClimb.get(stat.climb_uuid);
    if (!holds || (holds.hand.length === 0 && holds.foot.length === 0)) continue;
    observations.push({
      label: toNumber(stat.label),
      weight: Math.sqrt(Math.max(1, toNumber(stat.n))),
      handPlacementIds: holds.hand,
      footPlacementIds: holds.foot,
    });
  }
  return observations;
}

type FeatureRow = typeof boardHoldFeatures.$inferInsert;

async function upsertFeatures(db: JobDatabase, rows: FeatureRow[]): Promise<void> {
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
    const chunk = rows.slice(start, start + UPSERT_CHUNK);
    await db
      .insert(boardHoldFeatures)
      .values(chunk)
      .onConflictDoUpdate({
        target: [boardHoldFeatures.boardType, boardHoldFeatures.placementId],
        set: {
          layoutId: sql`excluded.layout_id`,
          holeId: sql`excluded.hole_id`,
          setId: sql`excluded.set_id`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          normX: sql`excluded.norm_x`,
          normY: sql`excluded.norm_y`,
          edgeDist: sql`excluded.edge_dist`,
          neighborDist: sql`excluded.neighbor_dist`,
          isKickboard: sql`excluded.is_kickboard`,
          handDifficulty: sql`excluded.hand_difficulty`,
          footDifficulty: sql`excluded.foot_difficulty`,
          handSampleCount: sql`excluded.hand_sample_count`,
          footSampleCount: sql`excluded.foot_sample_count`,
          pullDirection: sql`excluded.pull_direction`,
          coarseType: sql`excluded.coarse_type`,
          featureVersion: sql`excluded.feature_version`,
          updatedAt: sql`now()`,
        },
      });
  }
}

type ClassificationRow = typeof userHoldClassifications.$inferInsert;

async function shadowWriteClassifications(db: JobDatabase, rows: ClassificationRow[]): Promise<void> {
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
    const chunk = rows.slice(start, start + UPSERT_CHUNK);
    await db
      .insert(userHoldClassifications)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          userHoldClassifications.userId,
          userHoldClassifications.boardType,
          userHoldClassifications.layoutId,
          userHoldClassifications.sizeId,
          userHoldClassifications.holdId,
        ],
        set: {
          handRating: sql`excluded.hand_rating`,
          footRating: sql`excluded.foot_rating`,
          pullDirection: sql`excluded.pull_direction`,
          updatedAt: sql`now()`,
        },
      });
  }
}

export type RefreshHoldFeaturesParams = {
  board: string;
  /** Compute and log, write nothing. */
  dryRun: boolean;
  /** Shadow-write user_hold_classifications under the system user. */
  shadow: boolean;
};

export type RefreshHoldFeaturesOptions = JobRunOptions & RefreshHoldFeaturesParams;

export type RefreshHoldFeaturesResult = { layouts: number; features: number; classifications: number };

async function processLayout(
  db: JobDatabase,
  transact: JobTransact,
  log: JobLogger,
  options: RefreshHoldFeaturesParams,
  layout: number,
): Promise<{ features: number; classifications: number }> {
  const { board, dryRun, shadow } = options;
  const placements = await loadPlacements(db, board, layout);
  if (placements.length === 0) return { features: 0, classifications: 0 };

  const geomInput: PlacementGeom[] = placements
    .filter((placement) => placement.x !== null && placement.y !== null)
    .map((placement) => ({
      placementId: toNumber(placement.placement_id),
      holeId: placement.hole_id === null ? null : toNumber(placement.hole_id),
      setId: placement.set_id === null ? null : toNumber(placement.set_id),
      x: toNumber(placement.x),
      y: toNumber(placement.y),
      isKickboard: isKickboardHole(placement.hole_name, placement.set_name),
    }));
  const geometry = computeGeometryFeatures(geomInput);

  // One after the other: the worker's pool is two connections and the heartbeat
  // needs one of them.
  const stats = await loadStats(db, board, layout);
  const holds = await loadHolds(db, board, layout);
  const byClimb = groupHoldsByClimb(holds);
  const observations = buildObservations(stats, byClimb);
  const difficulty = estimateHoldDifficulty(observations);

  const holeNameById = new Map<number, string | null>();
  const setNameById = new Map<number, string | null>();
  for (const placement of placements) {
    holeNameById.set(toNumber(placement.placement_id), placement.hole_name);
    setNameById.set(toNumber(placement.placement_id), placement.set_name);
  }

  const featureRows: FeatureRow[] = placements.map((placement) => {
    const placementId = toNumber(placement.placement_id);
    const geom = geometry.get(placementId);
    const diff: HoldDifficulty | undefined = difficulty.get(placementId);
    return {
      boardType: board,
      placementId,
      layoutId: placement.layout_id === null ? null : toNumber(placement.layout_id),
      holeId: placement.hole_id === null ? null : toNumber(placement.hole_id),
      setId: placement.set_id === null ? null : toNumber(placement.set_id),
      x: placement.x === null ? null : toNumber(placement.x),
      y: placement.y === null ? null : toNumber(placement.y),
      normX: geom?.normX ?? null,
      normY: geom?.normY ?? null,
      edgeDist: geom?.edgeDist ?? null,
      neighborDist: geom?.neighborDist ?? null,
      isKickboard: isKickboardHole(placement.hole_name, placement.set_name),
      handDifficulty: diff?.hand ?? null,
      footDifficulty: diff?.foot ?? null,
      handSampleCount: diff?.handSampleCount ?? 0,
      footSampleCount: diff?.footSampleCount ?? 0,
      pullDirection: geom ? geom.pullDirection : null,
      coarseType: coarseTypeFromSetName(placement.set_name),
      featureVersion: FEATURE_VERSION,
    };
  });

  // Shadow classifications: quintile-scale contributions to 1..5 (only rated placements).
  const handValues = [...difficulty.values()]
    .map((entry) => entry.hand)
    .filter((value): value is number => value !== null);
  const footValues = [...difficulty.values()]
    .map((entry) => entry.foot)
    .filter((value): value is number => value !== null);
  const handScale = makeQuintileScaler(handValues);
  const footScale = makeQuintileScaler(footValues);

  const classificationRows: ClassificationRow[] = [];
  if (shadow) {
    const sizeId = await canonicalSizeId(db, board, layout);
    if (sizeId !== null) {
      for (const placement of placements) {
        const placementId = toNumber(placement.placement_id);
        const diff = difficulty.get(placementId);
        if (!diff || (diff.hand === null && diff.foot === null)) continue;
        const geom = geometry.get(placementId);
        const holdId = placement.hole_id === null ? null : toNumber(placement.hole_id);
        if (holdId === null) continue;
        classificationRows.push({
          userId: SYSTEM_USER_ID,
          boardType: board,
          layoutId: layout,
          sizeId,
          holdId, // user_hold_classifications keys on board_holes.id (translated from placement)
          handRating: diff.hand === null ? null : handScale(diff.hand),
          footRating: diff.foot === null ? null : footScale(diff.foot),
          pullDirection: geom ? geom.pullDirection : null,
        });
      }
    }
  }

  if (!dryRun) {
    // One batch per layout: a few hundred rows, and never half a layout.
    await transact(async (transaction) => {
      await upsertFeatures(transaction, featureRows);
      if (classificationRows.length > 0) await shadowWriteClassifications(transaction, classificationRows);
    });
  }

  // Log a sanity sample: the hardest hand holds this layout surfaced.
  const hardest = featureRows
    .filter((row) => row.handDifficulty !== null)
    .sort((a, b) => (b.handDifficulty as number) - (a.handDifficulty as number))
    .slice(0, 3)
    .map((row) => `p${row.placementId}=${(row.handDifficulty as number).toFixed(2)} (n=${row.handSampleCount})`);
  log.info(
    `[hold-features] layout ${layout}: ${featureRows.length} placements, ${observations.length} graded obs, ` +
      `${handValues.length} hand-rated, ${footValues.length} foot-rated, ${classificationRows.length} shadow rows` +
      (hardest.length ? ` · hardest hands: ${hardest.join(', ')}` : ''),
  );

  return { features: featureRows.length, classifications: classificationRows.length };
}

export async function runRefreshHoldFeatures(options: RefreshHoldFeaturesOptions): Promise<RefreshHoldFeaturesResult> {
  const { db, signal, log, board, dryRun, shadow } = options;
  const transact = options.transact ?? defaultTransact(db);
  log.info(`[hold-features] board=${board} dryRun=${dryRun} shadow=${shadow} version=${FEATURE_VERSION}`);
  signal.throwIfAborted();
  if (!dryRun && shadow) {
    await transact((transaction) =>
      ensureSystemUser(transaction, {
        id: SYSTEM_USER_ID,
        name: 'Boardsesh Hold Classifier',
        email: SYSTEM_USER_EMAIL,
      }),
    );
  }
  const layouts = await listLayouts(db, board);
  let totalFeatures = 0;
  let totalClassifications = 0;
  for (const layout of layouts) {
    signal.throwIfAborted();
    const result = await processLayout(db, transact, log, { board, dryRun, shadow }, layout);
    totalFeatures += result.features;
    totalClassifications += result.classifications;
  }
  log.info(
    `[hold-features] done: ${totalFeatures} placement features, ${totalClassifications} shadow classifications ` +
      `across ${layouts.length} layouts${dryRun ? ' (dry-run, nothing written)' : ''}.`,
  );
  return { layouts: layouts.length, features: totalFeatures, classifications: totalClassifications };
}
