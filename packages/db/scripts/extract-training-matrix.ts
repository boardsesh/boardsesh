/**
 * Export the Climb2Vec training matrix — one JSONL row per graded (climb, angle)
 * — for offline model training + validation (ml/climb2vec/). Each row carries the
 * climb's holds, each hold's generated board_hold_features, the angle, the
 * selected crowd/frozen-Stage-2 label, its signal weight, and physical identity.
 *
 * Requires board_hold_features to be populated first
 * (`refresh-hold-features.ts`). Reads only; writes a JSONL file, no DB writes.
 *
 * Run: `node --import tsx packages/db/scripts/extract-training-matrix.ts \
 *        --board=kilter,tension --out=ml/climb2vec/data/stage3-train.jsonl`
 * Flags: --board=<name[,name...]> · --out=<path> · --min-ascents=<n> (20)
 *        · --target=crowd|stage2 · --coeff-version=<persisted snapshot>
 *        · --morphology=<hold-morphology JSONL> · --score
 *        · --angle=<deg> · --limit=<n> (`--limit` is forbidden for Stage 2).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { climbHoldPlacementMatchSql, moonBoardPlacementCoverageSql } from '../src/queries/climbs/placement-match.js';
import {
  buildBehaviorEvidence,
  buildBehaviorSampleSql,
  buildRaterEvidence,
  buildRaterSampleSql,
  type BehaviorSampleRow,
  type GradeCoefficients,
  type RaterSampleRow,
  type Stage2EvidenceMap,
} from '../src/queries/grade-model/index.js';
import {
  hydrateFrozenGradeCoefficients,
  type FrozenCoefficientRow,
} from '../src/queries/content-model/frozen-coefficients.js';
import {
  buildFrozenTrainingTargets,
  contentTrainingStatKey,
  resolveTrainingTarget,
  type ContentTrainingStat,
} from '../src/queries/content-model/training-targets.js';
import { physicalProblemIdentity } from '../src/queries/content-model/physical-signature.js';
import { canonicalizeMirrorFeatures } from '../src/queries/content-model/mirror-canonicalization.js';
import {
  buildTrainingRow,
  deduplicateTrainingRowsWithReport,
  type HoldFeatureLite,
  type ClimbStatLite,
  type HoldLite,
  type TrainingRow,
} from '../src/queries/hold-features/index.js';
import { rowsOf } from '../src/queries/util/rows.js';

const DEFAULT_OUT = 'ml/climb2vec/data/kilter-train.jsonl';
const DEFAULT_MIN_ASCENTS = 20;
const MORPHOLOGY_VECTOR_LENGTH = 12;

type Db = ReturnType<typeof createScriptDb>['db'];
type ReadDb = Pick<Db, 'execute'>;

interface Options {
  boards: string[];
  out: string;
  minAscents: number;
  angle: number | null;
  limit: number | null;
  target: 'crowd' | 'stage2';
  coeffVersion: string | null;
  morphologyPath: string | null;
  morphologyManifestPath: string | null;
  /** Score mode: emit EVERY listed (climb, angle) with holds — no ascent/label gate — for model scoring. */
  scoreAll: boolean;
}

interface MorphologyRecord {
  morphologyVersion: string;
  boardType: string;
  layoutId: number;
  placementId?: number;
  gridCellId?: number;
  normalizedCenterDistance: number;
  vector: number[];
}

interface MorphologyBundle {
  byHold: Map<string, MorphologyRecord>;
  morphologyVersion: string;
  sourceVersionHash: string;
  artifactSha256: string;
  coverage: number | null;
}

function morphologyKey(boardType: string, layoutId: number, holdId: number): string {
  return `${boardType}\u0000${layoutId}\u0000${holdId}`;
}

async function loadMorphology(options: Options): Promise<MorphologyBundle | null> {
  if (!options.morphologyPath) return null;
  const artifact = await readFile(options.morphologyPath, 'utf8');
  const records = artifact
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MorphologyRecord);
  const versions = new Set(records.map((record) => record.morphologyVersion));
  if (versions.size !== 1) throw new Error(`Morphology artifact has mixed versions: ${[...versions].join(', ')}`);
  const morphologyVersion = records[0]?.morphologyVersion;
  if (!morphologyVersion) throw new Error(`Morphology artifact ${options.morphologyPath} is empty.`);

  const byHold = new Map<string, MorphologyRecord>();
  for (const record of records) {
    if (record.vector.length !== MORPHOLOGY_VECTOR_LENGTH || !record.vector.every(Number.isFinite)) {
      throw new Error(
        `Invalid morphology vector for ${record.boardType}:${record.layoutId}:` +
          `${record.placementId ?? record.gridCellId}`,
      );
    }
    const holdId = record.boardType === 'moonboard' ? record.gridCellId : record.placementId;
    if (holdId === undefined) throw new Error('Morphology record is missing its hold identity.');
    const key = morphologyKey(record.boardType, Number(record.layoutId), Number(holdId));
    if (byHold.has(key)) throw new Error(`Duplicate morphology record ${key}.`);
    byHold.set(key, record);
  }

  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  let sourceVersionHash = artifactSha256;
  let coverage: number | null = null;
  if (options.morphologyManifestPath) {
    const manifest = JSON.parse(await readFile(options.morphologyManifestPath, 'utf8')) as {
      morphologyVersion?: string;
      sourceVersionHash?: string;
      coverage?: { coverage?: number };
    };
    if (manifest.morphologyVersion !== morphologyVersion || !manifest.sourceVersionHash) {
      throw new Error('Morphology manifest does not match the artifact version or has no sourceVersionHash.');
    }
    sourceVersionHash = manifest.sourceVersionHash;
    coverage =
      manifest.coverage?.coverage !== undefined && Number.isFinite(manifest.coverage.coverage)
        ? Number(manifest.coverage.coverage)
        : null;
  }
  return {
    byHold,
    morphologyVersion,
    sourceVersionHash,
    artifactSha256,
    coverage,
  };
}

/** The ascent/label gate for training; empty in score mode (grade everything). */
function gradeGate(options: Options) {
  if (options.scoreAll) return sql``;
  if (options.target === 'stage2') {
    // Stage 2 applies minAscents after aliases are pooled by physical problem + angle.
    // Filtering individual rows here would discard aliases that jointly clear the
    // threshold; cold Tension benchmarks must also remain available as sealed rows.
    return sql`
      AND (
        st.difficulty_average IS NOT NULL
        OR (st.board_type = 'tension' AND st.benchmark_difficulty IS NOT NULL)
      )
    `;
  }
  return sql`AND st.ascensionist_count >= ${options.minAscents} AND st.difficulty_average IS NOT NULL`;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

async function loadFeatures(
  db: ReadDb,
  board: string,
  morphology: MorphologyBundle | null,
): Promise<Map<number, HoldFeatureLite>> {
  const rows = (await db.execute(sql`
    SELECT feature.placement_id, feature.layout_id, feature.hole_id, hole.mirrored_hole_id,
           feature.norm_x, feature.norm_y, feature.edge_dist, feature.neighbor_dist,
           feature.hand_difficulty, feature.foot_difficulty, feature.pull_direction,
           feature.is_kickboard, feature.coarse_type
    FROM board_hold_features feature
    LEFT JOIN board_holes hole
      ON hole.board_type = feature.board_type AND hole.id = feature.hole_id
    WHERE feature.board_type = ${board}
  `)) as unknown as HoldFeatureLite[];
  const map = new Map<number, HoldFeatureLite>();
  for (const row of rows) {
    const layoutId = row.layout_id === undefined || row.layout_id === null ? null : toNumber(row.layout_id);
    const morphologyHoldId =
      board === 'moonboard'
        ? row.hole_id === undefined || row.hole_id === null
          ? null
          : toNumber(row.hole_id)
        : toNumber(row.placement_id);
    const morphologyRecord =
      morphology && layoutId !== null && morphologyHoldId !== null
        ? morphology.byHold.get(morphologyKey(board, layoutId, morphologyHoldId))
        : undefined;
    map.set(toNumber(row.placement_id), {
      ...row,
      ...(morphologyRecord
        ? {
            morphology_vector: morphologyRecord.vector,
            morphology_center_distance: morphologyRecord.normalizedCenterDistance,
          }
        : {}),
    });
  }
  return map;
}

async function loadStats(db: ReadDb, options: Options, board: string): Promise<ClimbStatLite[]> {
  const angleFilter = options.angle === null ? sql`` : sql`AND st.angle = ${options.angle}`;
  const limitClause = options.limit === null ? sql`` : sql`LIMIT ${options.limit}`;
  const placementCoverage = moonBoardPlacementCoverageSql({
    boardType: sql.raw('c.board_type'),
    climbUuid: sql.raw('c.uuid'),
    layoutId: sql.raw('c.layout_id'),
  });
  return (await db.execute(sql`
    SELECT st.board_type AS board_type, st.climb_uuid AS climb_uuid, st.angle AS angle,
           COALESCE(st.difficulty_average, 0) AS label,
           st.difficulty_average AS difficulty_average,
           COALESCE(st.ascensionist_count, 0) AS n,
           st.display_difficulty AS display_difficulty,
           st.benchmark_difficulty AS benchmark_difficulty,
           c.layout_id AS layout_id, layout.product_id AS product_id,
           c.hold_fingerprint AS fingerprint
    FROM board_climb_stats st
    JOIN board_climbs c
      ON c.board_type = st.board_type AND c.uuid = st.climb_uuid
    LEFT JOIN board_layouts layout
      ON layout.board_type = c.board_type AND layout.id = c.layout_id
    WHERE st.board_type = ${board}
      AND c.is_listed = true
      AND COALESCE(c.is_draft, false) = false
      ${gradeGate(options)}
      ${angleFilter}
      AND ${placementCoverage}
    ORDER BY st.climb_uuid, st.angle
    ${limitClause}
  `)) as unknown as ClimbStatLite[];
}

async function loadFrozenCoefficients(db: ReadDb, requestedVersion: string | null): Promise<GradeCoefficients> {
  const versions = rowsOf<{ coeff_version: string }>(
    await db.execute(
      requestedVersion
        ? sql`SELECT ${requestedVersion}::text AS coeff_version`
        : sql`
            SELECT coeff_version
            FROM board_grade_coefficients
            WHERE kind <> 'gate_results'
            GROUP BY coeff_version
            ORDER BY MAX(created_at) DESC
            LIMIT 1
          `,
    ),
  );
  const coeffVersion = versions[0]?.coeff_version;
  if (!coeffVersion) {
    throw new Error('No frozen grade coefficient set exists; stage2 targets require a published coefficient snapshot.');
  }
  const rows = rowsOf<FrozenCoefficientRow>(
    await db.execute(sql`
      SELECT coeff_version, kind, key, payload
      FROM board_grade_coefficients
      WHERE coeff_version = ${coeffVersion} AND kind <> 'gate_results'
    `),
  );
  const coefficients = hydrateFrozenGradeCoefficients(rows);
  if (!coefficients) throw new Error(`Coefficient snapshot ${coeffVersion} is empty.`);
  return coefficients;
}

async function loadStage2Evidence(db: ReadDb, coefficients: GradeCoefficients): Promise<Stage2EvidenceMap> {
  await db.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
  const raterTrainingRows = rowsOf<RaterSampleRow>(
    await db.execute(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: true })),
  );
  const raterPredictionRows = rowsOf<RaterSampleRow>(
    await db.execute(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: false })),
  );
  const raterEvidence = buildRaterEvidence(raterPredictionRows, coefficients.raterModel, raterTrainingRows);
  const behaviorTrainingRows = rowsOf<BehaviorSampleRow>(
    await db.execute(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: true })),
  );
  const behaviorPredictionRows = rowsOf<BehaviorSampleRow>(
    await db.execute(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: false })),
  );
  return buildBehaviorEvidence(behaviorPredictionRows, coefficients.behaviorModel, raterEvidence, behaviorTrainingRows);
}

function applyStage2Targets(
  stats: readonly ClimbStatLite[],
  board: string,
  minAscents: number,
  coefficients: GradeCoefficients,
  evidence: Stage2EvidenceMap,
): ClimbStatLite[] {
  const targetStats: ContentTrainingStat[] = stats.flatMap((stat) => {
    if (stat.difficulty_average === undefined || stat.difficulty_average === null) return [];
    return [
      {
        boardType: stat.board_type ?? board,
        climbUuid: stat.climb_uuid,
        layoutId: stat.layout_id,
        fingerprint: stat.fingerprint,
        physicalKey: stat.physical_key,
        angle: toNumber(stat.angle),
        difficultyAverage: toNumber(stat.difficulty_average),
        displayDifficulty:
          stat.display_difficulty === undefined || stat.display_difficulty === null
            ? null
            : toNumber(stat.display_difficulty),
        ascensionistCount: toNumber(stat.n),
      },
    ];
  });
  const targets = buildFrozenTrainingTargets(targetStats, coefficients, evidence);

  return stats.flatMap((stat) => {
    const target = targets.get(contentTrainingStatKey(stat.board_type ?? board, stat.climb_uuid, toNumber(stat.angle)));
    const benchmarkDifficulty =
      stat.benchmark_difficulty === undefined || stat.benchmark_difficulty === null
        ? null
        : toNumber(stat.benchmark_difficulty);
    const resolved = resolveTrainingTarget({
      boardType: board,
      ascensionistCount: toNumber(stat.n),
      benchmarkDifficulty,
      minimumAscents: minAscents,
      coefficients,
      target,
    });
    if (!resolved) return [];
    return [
      {
        ...stat,
        label: resolved.label,
        local_label: resolved.localLabel,
        label_weight: resolved.labelWeight,
        coeff_version: resolved.coeffVersion,
        target_version: resolved.targetVersion,
        n: resolved.pooledAscensionistCount,
      },
    ];
  });
}

async function loadHoldsByClimb(db: ReadDb, options: Options, board: string): Promise<Map<string, HoldLite[]>> {
  const angleFilter = options.angle === null ? sql`` : sql`AND st.angle = ${options.angle}`;
  const limitClause = options.limit === null ? sql`` : sql`LIMIT ${options.limit}`;
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
    WITH selected_stats AS (
      SELECT st.climb_uuid
      FROM board_climb_stats st
      JOIN board_climbs selected_climb
        ON selected_climb.board_type = st.board_type AND selected_climb.uuid = st.climb_uuid
      WHERE st.board_type = ${board}
        AND selected_climb.is_listed = true
        AND COALESCE(selected_climb.is_draft, false) = false
        ${gradeGate(options)}
        ${angleFilter}
        AND ${moonBoardPlacementCoverageSql({
          boardType: sql.raw('selected_climb.board_type'),
          climbUuid: sql.raw('selected_climb.uuid'),
          layoutId: sql.raw('selected_climb.layout_id'),
        })}
      ORDER BY st.climb_uuid, st.angle
      ${limitClause}
    ),
    selected_climbs AS (
      SELECT DISTINCT climb_uuid FROM selected_stats
    )
    SELECT ch.climb_uuid AS climb_uuid, p.id AS placement_id, ch.hold_state AS hold_state
    FROM board_climb_holds ch
    JOIN selected_climbs selected ON selected.climb_uuid = ch.climb_uuid
    JOIN board_climbs c
      ON c.board_type = ch.board_type AND c.uuid = ch.climb_uuid
    JOIN board_placements p
      ON p.board_type = ch.board_type
      AND p.layout_id = c.layout_id
      AND ${placementMatch}
    WHERE ch.board_type = ${board}
      AND ${placementCoverage}
    ORDER BY ch.climb_uuid, ch.hold_state, p.id
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
  const targetArg = get('--target');
  const morphologyPath = get('--morphology') ?? null;
  const options: Options = {
    boards: (get('--board') ?? 'kilter')
      .split(',')
      .map((board) => board.trim())
      .filter(Boolean),
    out: get('--out') ?? DEFAULT_OUT,
    minAscents: get('--min-ascents') ? Number(get('--min-ascents')) : DEFAULT_MIN_ASCENTS,
    angle: angleArg ? Number(angleArg) : null,
    limit: limitArg ? Number(limitArg) : null,
    target: targetArg === 'stage2' ? 'stage2' : 'crowd',
    coeffVersion: get('--coeff-version') ?? null,
    morphologyPath,
    morphologyManifestPath: get('--morphology-manifest') ?? (morphologyPath ? `${morphologyPath}.failures.json` : null),
    scoreAll: argv.includes('--score'),
  };
  if (targetArg !== undefined && targetArg !== 'crowd' && targetArg !== 'stage2') {
    throw new Error(`--target must be crowd or stage2, received ${targetArg}.`);
  }
  const knownBoards = new Set(['kilter', 'tension', 'moonboard']);
  const unknownBoards = options.boards.filter((board) => !knownBoards.has(board));
  if (unknownBoards.length > 0) {
    throw new Error(`Unsupported --board value: ${unknownBoards.join(', ')}.`);
  }
  if (!Number.isInteger(options.minAscents) || options.minAscents < 1) {
    throw new Error('--min-ascents must be a positive integer.');
  }
  if (options.angle !== null && !Number.isInteger(options.angle)) {
    throw new Error('--angle must be an integer.');
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  if (options.scoreAll && options.target === 'stage2') {
    throw new Error('--score is label-free and cannot be combined with --target=stage2.');
  }
  if (options.target === 'stage2' && options.boards.includes('moonboard')) {
    throw new Error('MoonBoard feed grades are circular and cannot be used as frozen Stage-2 training targets.');
  }
  if (options.target === 'stage2' && options.limit !== null) {
    throw new Error('--limit is incompatible with --target=stage2 because it can split duplicate physical problems.');
  }
  if (options.boards.length === 0) {
    throw new Error('--board must contain at least one board name.');
  }
  if (new Set(options.boards).size !== options.boards.length) {
    throw new Error('--board contains a duplicate board name.');
  }
  return options;
}

function attachPhysicalKeys(
  stats: readonly ClimbStatLite[],
  holdsByClimb: ReadonlyMap<string, readonly HoldLite[]>,
  features: ReadonlyMap<number, HoldFeatureLite>,
  board: string,
): ClimbStatLite[] {
  return stats.map((stat) => {
    const holds = holdsByClimb.get(stat.climb_uuid) ?? [];
    const row = buildTrainingRow(stat, holds, features);
    if (row.holds.length === 0) {
      return {
        ...stat,
        physical_key: `${board}\u0000unsupported-empty\u0000${stat.climb_uuid}`,
        physical_mirrored: false,
      };
    }
    const identity = physicalProblemIdentity({
      boardType: row.boardType ?? board,
      layoutId: row.layoutId,
      productId: row.productId,
      fingerprint: row.fingerprint,
      holds: row.holds,
    });
    return {
      ...stat,
      physical_key: identity.key,
      physical_mirrored: identity.mirrored,
    };
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { db, close } = createScriptDb();
  console.log(
    `[extract] boards=${options.boards.join(',')} target=${options.target} minAscents=${options.minAscents} ` +
      `angle=${options.angle ?? 'all'} → ${options.out}`,
  );
  try {
    const morphology = await loadMorphology(options);
    const extracted = await db.transaction(
      async (transaction) => {
        // Every feature, stat, hold, coefficient, and evidence read for every
        // requested board shares this immutable database snapshot.
        await transaction.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
        const snapshotRows = rowsOf<{ snapshot_id: string; captured_at: string }>(
          await transaction.execute(sql`
            SELECT txid_current_snapshot()::text AS snapshot_id,
                   transaction_timestamp()::text AS captured_at
          `),
        );
        const snapshot = snapshotRows[0];
        if (!snapshot) throw new Error('Could not identify the extraction snapshot.');

        const coefficients =
          options.target === 'stage2' && !options.scoreAll
            ? await loadFrozenCoefficients(transaction, options.coeffVersion)
            : null;
        const evidence = coefficients ? await loadStage2Evidence(transaction, coefficients) : null;
        const assembledRows: TrainingRow[] = [];
        let placementFeatureCount = 0;

        for (const board of options.boards) {
          const features = await loadFeatures(transaction, board, morphology);
          const loadedStats = await loadStats(transaction, options, board);
          const holdsByClimb = await loadHoldsByClimb(transaction, options, board);
          const statsWithPhysicalKeys = attachPhysicalKeys(loadedStats, holdsByClimb, features, board);
          const stats =
            coefficients && evidence
              ? applyStage2Targets(statsWithPhysicalKeys, board, options.minAscents, coefficients, evidence)
              : statsWithPhysicalKeys;
          if (features.size === 0) {
            throw new Error(`board_hold_features is empty for ${board} — run refresh-hold-features.ts first.`);
          }
          placementFeatureCount += features.size;

          for (const stat of stats) {
            const holds = holdsByClimb.get(stat.climb_uuid) ?? [];
            const row = buildTrainingRow(stat, holds, features);
            row.physicalKey = stat.physical_key;
            row.extractionSnapshot = snapshot.snapshot_id;
            row.extractedAt = snapshot.captured_at;
            row.holds = canonicalizeMirrorFeatures(row.holds, {
              usesFingerprint: row.fingerprint !== null,
              mirrored: stat.physical_mirrored ?? false,
            });
            if (morphology) {
              row.morphologyVersion = morphology.morphologyVersion;
              row.morphologySourceVersion = morphology.sourceVersionHash;
              row.morphologyArtifactSha256 = morphology.artifactSha256;
            }
            assembledRows.push(row);
          }
        }
        return { assembledRows, placementFeatureCount, snapshot };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    mkdirSync(dirname(options.out), { recursive: true });
    const deduplication =
      options.target === 'stage2' && !options.scoreAll
        ? deduplicateTrainingRowsWithReport(extracted.assembledRows)
        : {
            rows: extracted.assembledRows,
            rejectedPhysicalKeys: [],
            rejectedBenchmarkGroups: [],
            rejectedRows: 0,
          };
    const outputRows = deduplication.rows;
    const rejectionManifest =
      options.target === 'stage2' && !options.scoreAll
        ? {
            extractionSnapshot: extracted.snapshot.snapshot_id,
            rejectedPhysicalKeys: deduplication.rejectedPhysicalKeys,
            rejectedRows: deduplication.rejectedRows,
            benchmarkConflicts: deduplication.rejectedBenchmarkGroups,
          }
        : null;
    const rejectionManifestSha256 =
      rejectionManifest === null ? null : createHash('sha256').update(JSON.stringify(rejectionManifest)).digest('hex');
    if (rejectionManifestSha256 !== null) {
      for (const row of outputRows) {
        row.benchmarkRejectionManifestSha256 = rejectionManifestSha256;
        row.rejectedBenchmarkPhysicalProblems = deduplication.rejectedPhysicalKeys.length;
      }
    }
    const stream = createWriteStream(options.out, { encoding: 'utf8' });
    let written = 0;
    let holdTotal = 0;
    for (const row of outputRows) {
      stream.write(`${JSON.stringify(row)}\n`);
      written++;
      holdTotal += row.holds.length;
    }
    await new Promise<void>((resolve, reject) =>
      stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    if (options.target === 'stage2' && !options.scoreAll) {
      await writeFile(
        `${options.out}.rejections.json`,
        `${JSON.stringify(
          {
            ...rejectionManifest,
            manifestSha256: rejectionManifestSha256,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    console.log(
      `[extract] wrote ${written} rows (${extracted.placementFeatureCount} placement features, avg ${
        written ? (holdTotal / written).toFixed(1) : 0
      } holds/row${morphology ? `, morphology coverage=${morphology.coverage ?? 'unknown'}` : ''}, ` +
        `snapshot=${extracted.snapshot.snapshot_id}, rejected-benchmark-physical=${deduplication.rejectedPhysicalKeys.length}) ` +
        `→ ${options.out}`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[extract] failed:', error);
  process.exit(1);
});
