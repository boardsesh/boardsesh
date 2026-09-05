import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core';
import {
  boardAttempts,
  boardBetaLinks,
  boardCircuits,
  boardCircuitsClimbs,
  boardClimbHolds,
  boardClimbs,
  boardClimbStats,
  boardClimbStatsHistory,
  boardDifficultyGrades,
  boardHoles,
  boardLayouts,
  boardLeds,
  boardPlacements,
  boardPlacementRoles,
  boardProducts,
  boardProductSizes,
  boardProductSizesLayoutsSets,
  boardSets,
  boardSharedSyncs,
  boardTags,
  boardUserSyncs,
  boardUsers,
  boardWalls,
} from '../src/schema/boards/unified.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { recomputeClimbStatsBulk } from '../src/queries/climb-stats/recompute.js';
import { clearAuroraBoardData, countBoardseshOwnedRows } from '../src/queries/boards/clear-aurora-board.js';
import { normalizeQualityTo5 } from '@boardsesh/shared-schema';
import { sanitizeFirstAscent } from '@boardsesh/sync-runtime';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';
import {
  DIRECT_AURORA_BOARDS,
  resolveImportedClimbHolds,
  type DirectAuroraBoard,
} from './aurora-board-import-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_MAX_BUFFER = 256 * 1024 * 1024;
const BATCH_SIZE = 1000;

type SqliteValue = string | number | null;
type SqliteRow = Record<string, SqliteValue>;

type ImportConfig = {
  sourceTable: string;
  label: string;
  required: boolean;
  destination: PgTable;
  conflictMode?: 'ignore' | 'allowDuplicates';
  mapRow: (row: SqliteRow, boardName: DirectAuroraBoard) => Record<string, unknown>;
};

function parseBoardName(value: string | undefined): DirectAuroraBoard {
  if (!value || !DIRECT_AURORA_BOARDS.includes(value as DirectAuroraBoard)) {
    console.error(
      `Usage: vp exec tsx scripts/import-aurora-board-unified.ts <${DIRECT_AURORA_BOARDS.join('|')}> <sqlite-db-path> [--dry-run]`,
    );
    process.exit(1);
  }

  return value as DirectAuroraBoard;
}

function runSqliteQuery(sqlitePath: string, query: string): string {
  return execFileSync('sqlite3', [sqlitePath, '-json', query], {
    cwd: __dirname,
    encoding: 'utf-8',
    maxBuffer: SQLITE_MAX_BUFFER,
  });
}

function readSqliteJson(sqlitePath: string, query: string): SqliteRow[] {
  const result = runSqliteQuery(sqlitePath, query).trim();
  return result ? (JSON.parse(result) as SqliteRow[]) : [];
}

function listSqliteTables(sqlitePath: string): Set<string> {
  const rows = readSqliteJson(
    sqlitePath,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
  );

  return new Set(rows.map((row) => String(row.name)));
}

function readSqliteTable(sqlitePath: string, tableName: string): SqliteRow[] {
  return readSqliteJson(sqlitePath, `SELECT * FROM "${tableName}";`);
}

function toNumber(value: SqliteValue, label: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric ${label}, got ${String(value)}`);
  }
  return parsed;
}

function toNullableNumber(value: SqliteValue): number | null {
  if (value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableText(value: SqliteValue): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function toText(value: SqliteValue, label: string): string {
  const text = toNullableText(value);
  if (!text) {
    throw new Error(`Expected non-empty text ${label}, got ${String(value)}`);
  }
  return text;
}

function toNullableBoolean(value: SqliteValue): boolean | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
    return Number(value) !== 0;
  }
  return null;
}

function createImportConfigs(): ImportConfig[] {
  return [
    {
      sourceTable: 'attempts',
      label: 'attempts',
      required: true,
      destination: boardAttempts,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'attempts.id'),
        position: toNullableNumber(row.position),
        name: toNullableText(row.name),
      }),
    },
    {
      sourceTable: 'difficulty_grades',
      label: 'difficulty grades',
      required: true,
      destination: boardDifficultyGrades,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        difficulty: toNumber(row.difficulty, 'difficulty_grades.difficulty'),
        boulderName: toNullableText(row.boulder_name),
        routeName: toNullableText(row.route_name),
        isListed: toNullableBoolean(row.is_listed),
      }),
    },
    {
      sourceTable: 'products',
      label: 'products',
      required: true,
      destination: boardProducts,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'products.id'),
        name: toNullableText(row.name),
        isListed: toNullableBoolean(row.is_listed),
        password: toNullableText(row.password),
        minCountInFrame: toNullableNumber(row.min_count_in_frame),
        maxCountInFrame: toNullableNumber(row.max_count_in_frame),
      }),
    },
    {
      sourceTable: 'sets',
      label: 'sets',
      required: true,
      destination: boardSets,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'sets.id'),
        name: toNullableText(row.name),
        hsm: toNullableNumber(row.hsm),
      }),
    },
    {
      sourceTable: 'users',
      label: 'users',
      required: true,
      destination: boardUsers,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'users.id'),
        username: toNullableText(row.username),
        createdAt: toNullableText(row.created_at),
      }),
    },
    {
      sourceTable: 'shared_syncs',
      label: 'shared syncs',
      required: true,
      destination: boardSharedSyncs,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        tableName: toText(row.table_name, 'shared_syncs.table_name'),
        lastSynchronizedAt: toNullableText(row.last_synchronized_at),
      }),
    },
    {
      sourceTable: 'layouts',
      label: 'layouts',
      required: true,
      destination: boardLayouts,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'layouts.id'),
        productId: toNullableNumber(row.product_id),
        name: toNullableText(row.name),
        instagramCaption: toNullableText(row.instagram_caption),
        isMirrored: toNullableBoolean(row.is_mirrored),
        isListed: toNullableBoolean(row.is_listed),
        password: toNullableText(row.password),
        createdAt: toNullableText(row.created_at),
      }),
    },
    {
      sourceTable: 'product_sizes',
      label: 'product sizes',
      required: true,
      destination: boardProductSizes,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'product_sizes.id'),
        productId: toNumber(row.product_id, 'product_sizes.product_id'),
        edgeLeft: toNullableNumber(row.edge_left),
        edgeRight: toNullableNumber(row.edge_right),
        edgeBottom: toNullableNumber(row.edge_bottom),
        edgeTop: toNullableNumber(row.edge_top),
        name: toNullableText(row.name),
        description: toNullableText(row.description),
        imageFilename: toNullableText(row.image_filename),
        position: toNullableNumber(row.position),
        isListed: toNullableBoolean(row.is_listed),
      }),
    },
    {
      sourceTable: 'holes',
      label: 'holes',
      required: true,
      destination: boardHoles,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'holes.id'),
        productId: toNullableNumber(row.product_id),
        name: toNullableText(row.name),
        x: toNullableNumber(row.x),
        y: toNullableNumber(row.y),
        mirroredHoleId: toNullableNumber(row.mirrored_hole_id),
        mirrorGroup: toNullableNumber(row.mirror_group) ?? 0,
      }),
    },
    {
      sourceTable: 'placement_roles',
      label: 'placement roles',
      required: true,
      destination: boardPlacementRoles,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'placement_roles.id'),
        productId: toNullableNumber(row.product_id),
        position: toNullableNumber(row.position),
        name: toNullableText(row.name),
        fullName: toNullableText(row.full_name),
        ledColor: toNullableText(row.led_color),
        screenColor: toNullableText(row.screen_color),
      }),
    },
    {
      sourceTable: 'leds',
      label: 'leds',
      required: true,
      destination: boardLeds,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'leds.id'),
        productSizeId: toNullableNumber(row.product_size_id),
        holeId: toNullableNumber(row.hole_id),
        position: toNullableNumber(row.position),
      }),
    },
    {
      sourceTable: 'placements',
      label: 'placements',
      required: true,
      destination: boardPlacements,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'placements.id'),
        layoutId: toNullableNumber(row.layout_id),
        holeId: toNullableNumber(row.hole_id),
        setId: toNullableNumber(row.set_id),
        defaultPlacementRoleId: toNullableNumber(row.default_placement_role_id),
      }),
    },
    {
      sourceTable: 'product_sizes_layouts_sets',
      label: 'product size/layout/set mappings',
      required: true,
      destination: boardProductSizesLayoutsSets,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        id: toNumber(row.id, 'product_sizes_layouts_sets.id'),
        productSizeId: toNullableNumber(row.product_size_id),
        layoutId: toNullableNumber(row.layout_id),
        setId: toNullableNumber(row.set_id),
        imageFilename: toNullableText(row.image_filename),
        isListed: toNullableBoolean(row.is_listed),
      }),
    },
    {
      sourceTable: 'climbs',
      label: 'climbs',
      required: true,
      destination: boardClimbs,
      mapRow: (row, boardName) => ({
        uuid: toText(row.uuid, 'climbs.uuid'),
        boardType: boardName,
        layoutId: toNumber(row.layout_id, 'climbs.layout_id'),
        setterId: toNullableNumber(row.setter_id),
        setterUsername: toNullableText(row.setter_username),
        name: toNullableText(row.name),
        description: toNullableText(row.description) ?? '',
        hsm: toNullableNumber(row.hsm),
        edgeLeft: toNullableNumber(row.edge_left),
        edgeRight: toNullableNumber(row.edge_right),
        edgeBottom: toNullableNumber(row.edge_bottom),
        edgeTop: toNullableNumber(row.edge_top),
        angle: toNullableNumber(row.angle),
        framesCount: toNullableNumber(row.frames_count),
        framesPace: toNullableNumber(row.frames_pace),
        frames: toNullableText(row.frames),
        isDraft: toNullableBoolean(row.is_draft),
        isListed: toNullableBoolean(row.is_listed),
        createdAt: toNullableText(row.created_at),
        synced: true,
        syncError: null,
        userId: null,
      }),
    },
    {
      sourceTable: 'walls',
      label: 'walls',
      required: true,
      destination: boardWalls,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        uuid: toText(row.uuid, 'walls.uuid'),
        userId: toNullableNumber(row.user_id),
        name: toNullableText(row.name),
        productId: toNullableNumber(row.product_id),
        isAdjustable: toNullableBoolean(row.is_adjustable),
        angle: toNullableNumber(row.angle),
        layoutId: toNullableNumber(row.layout_id),
        productSizeId: toNullableNumber(row.product_size_id),
        hsm: toNullableNumber(row.hsm),
        serialNumber: toNullableText(row.serial_number),
        createdAt: toNullableText(row.created_at),
      }),
    },
    {
      sourceTable: 'user_syncs',
      label: 'user syncs',
      required: false,
      destination: boardUserSyncs,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        userId: toNumber(row.user_id, 'user_syncs.user_id'),
        tableName: toText(row.table_name, 'user_syncs.table_name'),
        lastSynchronizedAt: toNullableText(row.last_synchronized_at),
      }),
    },
    {
      sourceTable: 'circuits',
      label: 'circuits',
      required: false,
      destination: boardCircuits,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        uuid: toText(row.uuid, 'circuits.uuid'),
        name: toNullableText(row.name),
        description: toNullableText(row.description),
        color: toNullableText(row.color),
        userId: toNullableNumber(row.user_id),
        isPublic: toNullableBoolean(row.is_public),
        createdAt: toNullableText(row.created_at),
        updatedAt: toNullableText(row.updated_at),
      }),
    },
    {
      sourceTable: 'climb_stats',
      label: 'climb stats',
      required: true,
      destination: boardClimbStats,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        climbUuid: toText(row.climb_uuid, 'climb_stats.climb_uuid'),
        angle: toNumber(row.angle, 'climb_stats.angle'),
        displayDifficulty: toNullableNumber(row.display_difficulty),
        benchmarkDifficulty: toNullableNumber(row.benchmark_difficulty),
        // Aurora's count is this board's upstream source. Seed it alongside the
        // total so a later tick recompute (upstream + boardsesh) adds to it
        // instead of collapsing the row to just its Boardsesh ticks.
        upstreamAscensionistCount: toNullableNumber(row.ascensionist_count),
        ascensionistCount: toNullableNumber(row.ascensionist_count),
        difficultyAverage: toNullableNumber(row.difficulty_average),
        // Aurora quality is 1-3; normalise to the canonical 1-5 on import and
        // mark normalized so the 0116 backfill never double-scales these rows.
        // DIRECT_AURORA_BOARDS (decoy/touchstone/grasshopper/soill) are all 1-3.
        qualityAverage: normalizeQualityTo5(toNullableNumber(row.quality_average)),
        // This importer clears then re-inserts board_climb_stats, so there's no row
        // to blend with — seed upstream_quality_average with the same normalized
        // value, which equals the blend when a climb has no Boardsesh votes.
        upstreamQualityAverage: normalizeQualityTo5(toNullableNumber(row.quality_average)),
        qualityNormalized: true,
        // The Aurora SQLite dumps ship the same impossible fa_at garbage the
        // live sync does (future / pre-2016 dates, issue #3536) — and this
        // bulk importer is the most likely origin of the bad prod rows, so it
        // gets the same guard as the sync writers.
        ...sanitizeFirstAscent({
          faUsername: toNullableText(row.fa_username),
          faAt: toNullableText(row.fa_at),
        }),
      }),
    },
    {
      sourceTable: 'climb_stats_history',
      label: 'climb stats history',
      required: false,
      destination: boardClimbStatsHistory,
      conflictMode: 'allowDuplicates',
      mapRow: (row, boardName) => ({
        boardType: boardName,
        climbUuid: toText(row.climb_uuid, 'climb_stats_history.climb_uuid'),
        angle: toNumber(row.angle, 'climb_stats_history.angle'),
        displayDifficulty: toNullableNumber(row.display_difficulty),
        benchmarkDifficulty: toNullableNumber(row.benchmark_difficulty),
        ascensionistCount: toNullableNumber(row.ascensionist_count),
        difficultyAverage: toNullableNumber(row.difficulty_average),
        qualityAverage: toNullableNumber(row.quality_average),
        // Same fa_at range guard as climb_stats above (issue #3536).
        ...sanitizeFirstAscent({
          faUsername: toNullableText(row.fa_username),
          faAt: toNullableText(row.fa_at),
        }),
        createdAt: toNullableText(row.created_at),
      }),
    },
    {
      sourceTable: 'beta_links',
      label: 'beta links',
      required: true,
      destination: boardBetaLinks,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        climbUuid: toText(row.climb_uuid, 'beta_links.climb_uuid'),
        link: toText(row.link, 'beta_links.link'),
        foreignUsername: toNullableText(row.foreign_username),
        angle: toNullableNumber(row.angle),
        thumbnail: toNullableText(row.thumbnail),
        isListed: toNullableBoolean(row.is_listed),
        createdAt: toNullableText(row.created_at),
      }),
    },
    {
      sourceTable: 'circuits_climbs',
      label: 'circuit climbs',
      required: false,
      destination: boardCircuitsClimbs,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        circuitUuid: toText(row.circuit_uuid, 'circuits_climbs.circuit_uuid'),
        climbUuid: toText(row.climb_uuid, 'circuits_climbs.climb_uuid'),
        position: toNullableNumber(row.position),
      }),
    },
    {
      sourceTable: 'tags',
      label: 'tags',
      required: false,
      destination: boardTags,
      mapRow: (row, boardName) => ({
        boardType: boardName,
        entityUuid: toText(row.entity_uuid, 'tags.entity_uuid'),
        userId: toNumber(row.user_id, 'tags.user_id'),
        name: toText(row.name, 'tags.name'),
        isListed: toNullableBoolean(row.is_listed),
      }),
    },
  ];
}

async function insertBatches(
  tx: PgDatabase<PgQueryResultHKT>,
  destination: PgTable,
  rows: Record<string, unknown>[],
  label: string,
  conflictMode: 'ignore' | 'allowDuplicates' = 'ignore',
) {
  if (rows.length === 0) {
    console.info(`  - ${label}: 0 rows`);
    return;
  }

  console.info(`  - ${label}: ${rows.length} rows`);

  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    const insertQuery = tx.insert(destination).values(batch);
    if (conflictMode === 'ignore') {
      await insertQuery.onConflictDoNothing();
    } else {
      await insertQuery;
    }
  }
}

// Thrown at the end of the import transaction under --dry-run to force Postgres
// to roll the whole thing back; caught by identity in main() so the process
// still exits 0. Nothing is committed, but the operator sees the full plan
// (preserved counts, per-table row counts, recompute) exactly as a real run.
const DRY_RUN_ROLLBACK = new Error('__dry_run_rollback__');

async function main() {
  const args = process.argv.slice(2);
  // Fail closed on any unrecognised dash-arg: a typo'd flag (`--dryrun`,
  // `-dry-run`) must abort, never be silently dropped so a REAL import runs when
  // the operator meant --dry-run.
  const flags = args.filter((arg) => arg.startsWith('-'));
  const unknownFlags = flags.filter((flag) => flag !== '--dry-run');
  if (unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${unknownFlags.join(', ')}`);
    console.error(
      `Usage: vp exec tsx scripts/import-aurora-board-unified.ts <${DIRECT_AURORA_BOARDS.join('|')}> <sqlite-db-path> [--dry-run]`,
    );
    process.exit(1);
  }
  const dryRun = flags.includes('--dry-run');
  const positionals = args.filter((arg) => !arg.startsWith('-'));
  const boardName = parseBoardName(positionals[0]);
  const sqlitePath = positionals[1] ? path.resolve(process.cwd(), positionals[1]) : '';

  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    console.error(`SQLite database not found: ${sqlitePath || '<missing path>'}`);
    process.exit(1);
  }

  const databaseUrl = getScriptDatabaseUrl();
  const dbHost = new URL(databaseUrl).host;
  console.info(`Importing ${boardName} from ${sqlitePath}`);
  console.info(`Target database: ${dbHost}`);
  if (dryRun) {
    console.info('Dry run: the import transaction will be rolled back — nothing is committed.');
  }

  const availableTables = listSqliteTables(sqlitePath);
  const tableCache = new Map<string, SqliteRow[]>();
  const importConfigs = createImportConfigs();

  const getRows = (tableName: string, required: boolean): SqliteRow[] => {
    if (!availableTables.has(tableName)) {
      if (required) {
        throw new Error(`Required SQLite table is missing: ${tableName}`);
      }
      console.info(`  - ${tableName}: table missing, skipping`);
      return [];
    }

    if (!tableCache.has(tableName)) {
      tableCache.set(tableName, readSqliteTable(sqlitePath, tableName));
    }

    return tableCache.get(tableName) ?? [];
  };

  const climbRows = getRows('climbs', true);
  const sourceClimbRows = climbRows.map((row) => ({
    uuid: toText(row.uuid, 'climbs.uuid'),
    frames: toNullableText(row.frames),
  }));

  const climbHoldsRows = availableTables.has('climb_holds') ? getRows('climb_holds', false) : [];
  const importedClimbHolds = resolveImportedClimbHolds(
    sourceClimbRows,
    climbHoldsRows as Array<{
      climb_uuid: string | null;
      hold_id: number | null;
      frame_number: number | null;
      hold_state: string | null;
      created_at?: string | null;
    }>,
    boardName,
  );

  if (sourceClimbRows.length > 0 && importedClimbHolds.length === 0) {
    throw new Error(`No climb holds could be imported for ${boardName}; aborting to avoid empty set-filter data`);
  }

  const mappedClimbHolds = importedClimbHolds.map((row) => ({
    boardType: boardName,
    climbUuid: row.climbUuid,
    holdId: row.holdId,
    frameNumber: row.frameNumber,
    holdState: row.holdState,
  }));

  const { db, close } = createScriptDb(databaseUrl);

  try {
    const transactionalDb = db as unknown as PgDatabase<PgQueryResultHKT>;
    await transactionalDb.transaction(async (tx) => {
      // Preflight: report the Boardsesh-owned rows this refresh must preserve
      // (user-created climbs + their holds/stats, and Boardsesh-attached beta
      // links). clearAuroraBoardData asserts these counts are unchanged after
      // the scoped clear and rolls back if not (issue #3540).
      const preserved = await countBoardseshOwnedRows(tx, boardName);
      console.info(
        `Preserving ${preserved.ownedClimbs} Boardsesh-owned climb(s) and ` +
          `${preserved.boardseshBetaLinks} Boardsesh-attached beta link(s) for ${boardName}.`,
      );
      console.info(`Clearing existing upstream ${boardName} rows from unified tables...`);
      await clearAuroraBoardData(tx, boardName);

      console.info(`Loading ${boardName} tables into unified schema...`);

      for (const config of importConfigs) {
        const sourceRows = getRows(config.sourceTable, config.required);
        if (sourceRows.length === 0 && !config.required) {
          continue;
        }

        const mappedRows = sourceRows.map((row) => config.mapRow(row, boardName));
        await insertBatches(
          tx,
          config.destination,
          mappedRows,
          config.label,
          config.conflictMode === 'allowDuplicates' ? 'allowDuplicates' : 'ignore',
        );
      }

      await insertBatches(
        tx,
        boardClimbHolds,
        mappedClimbHolds,
        climbHoldsRows.length > 0 ? 'climb holds (frames with source fallback)' : 'climb holds (derived from frames)',
      );

      // Populate denormalized required_set_ids from climb_holds -> placements
      console.info(`  Computing required_set_ids for ${boardName}...`);
      await tx.execute(sql`
        UPDATE board_climbs c SET required_set_ids = sub.sets
        FROM (
          SELECT bch.climb_uuid,
            ARRAY_AGG(DISTINCT bp.set_id ORDER BY bp.set_id) as sets
          FROM board_climb_holds bch
          JOIN board_placements bp
            ON bp.id = bch.hold_id AND bp.board_type = bch.board_type
          JOIN board_climbs cl
            ON cl.uuid = bch.climb_uuid AND cl.board_type = bch.board_type
            AND cl.layout_id = bp.layout_id
          WHERE bch.board_type = ${boardName}
          GROUP BY bch.climb_uuid
        ) sub
        WHERE c.uuid = sub.climb_uuid AND c.board_type = ${boardName}
      `);

      // Populate denormalized compatible_size_ids from edge comparison
      console.info(`  Computing compatible_size_ids for ${boardName}...`);
      await tx.execute(sql`
        UPDATE board_climbs c SET compatible_size_ids = sub.size_ids
        FROM (
          SELECT c2.uuid,
            ARRAY_AGG(ps.id ORDER BY ps.id) as size_ids
          FROM board_climbs c2
          JOIN board_product_sizes ps
            ON ps.board_type = c2.board_type
            AND c2.edge_left > ps.edge_left
            AND c2.edge_right < ps.edge_right
            AND c2.edge_bottom > ps.edge_bottom
            AND c2.edge_top < ps.edge_top
          WHERE c2.board_type = ${boardName}
            AND c2.edge_left IS NOT NULL
          GROUP BY c2.uuid
        ) sub
        WHERE c.uuid = sub.uuid AND c.board_type = ${boardName}
      `);

      // Restore the Boardsesh tick-derived stats terms (issue #3540):
      // clearAuroraBoardData replaced every UPSTREAM board_climb_stats row and the
      // climb_stats reinsert above restores only the upstream side, so without this
      // pass a re-run zeroes boardsesh_ascensionist_count AND the quality blend's
      // boardsesh_quality_sum/count (leaving quality_average a stale pure-upstream
      // value). Re-derive them from boardsesh_ticks for every key with >=1
      // attached flash/send tick on this board — recomputeClimbStatsBulk rebuilds the
      // Boardsesh count, the materialized ascensionist total, the Boardsesh quality
      // terms and the blended quality_average in one set-based pass, updating both
      // the reinserted upstream rows and the preserved owned-climb rows in place;
      // its defensive seed re-creates stats rows for tick keys the reinsert didn't
      // cover. Same transaction, so a crash can't leave the board with upstream-only
      // stats. DIRECT_AURORA_BOARDS are small (decoy & friends), so the key set is
      // at most a few thousand. Owned climbs are no longer dropped, so their ticks
      // stay live; only upstream climbs genuinely removed from the new dump orphan
      // their ticks — an upstream-catalog fact, not Boardsesh data loss.
      console.info(`  Recomputing Boardsesh tick-derived stats for ${boardName}...`);
      const tickKeys = await tx
        .selectDistinct({
          boardType: boardseshTicks.boardType,
          climbUuid: boardseshTicks.climbUuid,
          angle: boardseshTicks.angle,
        })
        .from(boardseshTicks)
        .where(and(eq(boardseshTicks.boardType, boardName), inArray(boardseshTicks.status, ['flash', 'send'])));
      if (tickKeys.length > 0) {
        await recomputeClimbStatsBulk(tx, tickKeys);
        console.info(`  Recomputed ${tickKeys.length} tick key(s) for ${boardName}`);
      }

      if (dryRun) {
        console.info(`Dry run: rolling back the ${boardName} import — no changes committed.`);
        throw DRY_RUN_ROLLBACK;
      }
    });

    console.info(`Finished importing ${boardName}.`);
  } catch (error) {
    if (error === DRY_RUN_ROLLBACK) {
      console.info(`Dry run complete for ${boardName}. Transaction rolled back; nothing was written.`);
    } else {
      throw error;
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error('Aurora board import failed:', error);
  process.exit(1);
});
