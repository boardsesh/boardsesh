import { sharedSync } from '../api/shared-sync-api';
import { type SyncOptions, type AuroraBoardName, SHARED_SYNC_TABLES } from '../api/types';
import { sql, eq, and, inArray, isNull, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import type {
  Attempt,
  BetaLink,
  Climb,
  ClimbStats,
  Hole,
  Kit,
  Layout,
  Led,
  Placement,
  PlacementRole,
  Product,
  ProductSize,
  ProductSizesLayoutsSet,
  Set as AuroraSet,
  SharedSync,
  SyncPutFields,
} from '../api/sync-api-types';
import { UNIFIED_TABLES } from '../db/table-select';
import { normalizeQualityTo5, isNoMatchClimb, CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import { convertLitUpHoldsStringToMap, isSentinelHoldState } from '@boardsesh/board-constants/hold-states';
import {
  mergeCatalogCharacteristicsSql,
  populateDenormalizedColumns,
  blendedQualityAverageSql,
  setterSyncNotificationUuid,
  snapshotClimbStatsHistoryIfDue,
} from '@boardsesh/db/queries';
import { setterFollows, notifications, userBoardMappings, userFollows } from '@boardsesh/db/schema';
import { sanitizeFirstAscent } from '@boardsesh/sync-runtime';

// Common ancestor of `PostgresJsDatabase` and the `PgTransaction` Drizzle
// hands you inside `db.transaction(async (tx) => …)`. Both expose the same
// query-builder surface (`insert`, `select`, `update`, `execute`), so we type
// against the parent and avoid the `tx as unknown as …` cast at the call site.
type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type NewClimbInfo = {
  uuid: string;
  setterId?: number;
  setterUsername?: string;
  layoutId: number;
  name?: string;
};

// Tables we actually want to process and store, in FK-safe upsert order.
// SHARED_SYNC_TABLES matches the Android app's request order for indistinguishability,
// but that order is not FK-safe — e.g. `product_sizes_layouts_sets` appears before
// `sets` even though the former FKs to the latter. Iterate this list in the upsert
// loop instead. The Aurora API request still uses SHARED_SYNC_TABLES.
//
// Out of scope here:
// - `products_angles`: angles are hardcoded in the `ANGLES` constant in board-data.ts.
const PROCESSING_ORDER: string[] = [
  'products',
  'sets',
  'product_sizes',
  'holes',
  'layouts',
  'placement_roles',
  'leds',
  'placements',
  'product_sizes_layouts_sets',
  'climbs',
  'climb_stats',
  'beta_links',
  'attempts',
  'kits',
];

const TABLES_TO_PROCESS = new Set([...PROCESSING_ORDER, 'shared_syncs']);

const MAX_SYNC_ATTEMPTS = 100;

// Per-run cap on the required_set_ids straggler drain (see healRequiredSetIds).
// Large enough to keep up with any real trickle of late-arriving placements,
// small enough that a one-off historical backlog drains over cycles instead of
// updating tens of thousands of rows in a single sync transaction. Exported
// for tests.
export const REQUIRED_SET_ID_DRAIN_LIMIT = 2000;

// Chunk multi-row INSERTs to keep statement size bounded. Postgres has a hard
// limit of 65535 parameters per statement; the widest table we write here is
// `climbs` at 19 columns, so 1000 rows/statement = 19 000 params, well under
// the ceiling. Aurora caps each shared-sync response at ~2000 records total,
// so 1000 means ≤2 statements per batch per table even at the API page cap.
const BATCH_SIZE = 1000;

async function processBatches<T>(data: T[], processor: (batch: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    await processor(data.slice(i, i + BATCH_SIZE));
  }
}

/**
 * Conflict policy for board_climbs.is_draft / is_listed on the Aurora shared
 * sync. For NON-user climbs (user_id IS NULL — Aurora catalog rows) take the
 * incoming flags VERBATIM: Aurora only re-sends rows it changed, so its flags
 * are authoritative and an upstream delist (listed → hidden) or re-draft
 * (published → draft) must propagate so the climb leaves search. For user
 * climbs (Boardsesh-created) the stored flags are preserved. Exported for tests.
 */
export function climbListingConflictSet() {
  const climbsSchema = UNIFIED_TABLES.climbs;
  return {
    isDraft: sql`CASE WHEN ${climbsSchema.userId} IS NULL THEN excluded.is_draft ELSE ${climbsSchema.isDraft} END`,
    isListed: sql`CASE WHEN ${climbsSchema.userId} IS NULL THEN excluded.is_listed ELSE ${climbsSchema.isListed} END`,
  };
}

/** Preserve explicit authoring rules across Aurora's description-only wire format. */
export function climbCharacteristicsConflictSql() {
  const climbsSchema = UNIFIED_TABLES.climbs;
  const refreshed = mergeCatalogCharacteristicsSql(climbsSchema.characteristics, sql`excluded.characteristics`, [
    CLIMB_CHARACTERISTICS.NO_MATCH,
  ]);
  // Published Aurora climbs are immutable. Their first echo may add a wire
  // prefix, but must not reinterpret the rules explicitly saved in Boardsesh.
  // Drafts can change upstream; preserve explicit false only on an unchanged
  // echo, where the legacy fuzzy parser could mistake setter prose for a rule.
  return sql`CASE WHEN ${climbsSchema.userId} IS NOT NULL
    AND ${climbsSchema.characteristics} IS NOT NULL
    AND (${climbsSchema.isDraft} IS FALSE OR (
      ${climbsSchema.description} IS NOT DISTINCT FROM excluded.description
      AND NOT (${CLIMB_CHARACTERISTICS.NO_MATCH} = ANY(${climbsSchema.characteristics}))
    ))
    THEN ${climbsSchema.characteristics}
    ELSE ${refreshed} END`;
}

/**
 * Conflict policy for board_climb_stats upstream/total ascent counts on the
 * Aurora shared sync. Takes the incoming (cursored) upstream count verbatim —
 * Aurora only re-sends changed rows, so it is the current truth and a legitimate
 * decrease must propagate. (The old GREATEST(stored, incoming) pinned counts at
 * their all-time high, silently swallowing a revoked ascent.) Total is the same
 * incoming upstream plus the independent Boardsesh count.
 *
 * NULL semantics (deliberate): COALESCE(excluded.…, stored, 0) means an incoming
 * NULL count PRESERVES the stored value rather than zeroing it. A NULL from
 * upstream is "no data for this row", not "the count is now zero" — a genuine
 * drop to zero arrives as an explicit 0, which the incoming-first argument order
 * takes verbatim, exactly like any other decrease. So: non-null incoming always
 * wins (increase, decrease, or 0); NULL incoming keeps what we have; the final 0
 * only seeds a row that has never carried a count on either side.
 * Exported for tests.
 */
export function climbStatsUpstreamConflictSet() {
  const climbStatsSchema = UNIFIED_TABLES.climbStats;
  return {
    upstreamAscensionistCount: sql`COALESCE(excluded.upstream_ascensionist_count, ${climbStatsSchema.upstreamAscensionistCount}, 0)`,
    ascensionistCount: sql`COALESCE(excluded.upstream_ascensionist_count, ${climbStatsSchema.upstreamAscensionistCount}, 0) + COALESCE(${climbStatsSchema.boardseshAscensionistCount}, 0)`,
  };
}

/**
 * Conflict policy for board_climb_stats.fa_username / fa_at on the Aurora
 * shared sync. Deliberately a bare `excluded.*` — the incoming value is
 * already sanitized once at INSERT-value construction time (sanitizeFirstAscent,
 * applied in upsertClimbStats' mappedValues construction), so `excluded.*` in this same
 * statement reflects that sanitized value; no SQL-side range check is needed
 * or wanted here (see @boardsesh/sync-runtime's sanitizeFirstAscent docs for
 * why duplicating the range logic in SQL would risk drifting out of sync).
 * Not exported: the test renders the conflict set RECORDED from the query
 * builder, not this helper, so it can't drift from what actually ships.
 */
function firstAscentConflictSet() {
  return {
    faUsername: sql`excluded.fa_username`,
    faAt: sql`excluded.fa_at`,
  };
}

async function upsertProducts(db: DrizzleDb, board: AuroraBoardName, data: Product[]) {
  const productsSchema = UNIFIED_TABLES.products;
  await processBatches(data, async (batch) => {
    await db
      .insert(productsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          name: item.name,
          isListed: Boolean(item.is_listed),
          password: item.password,
          minCountInFrame: Number(item.min_count_in_frame),
          maxCountInFrame: Number(item.max_count_in_frame),
        })),
      )
      .onConflictDoUpdate({
        target: [productsSchema.boardType, productsSchema.id],
        set: {
          name: sql`excluded.name`,
          isListed: sql`excluded.is_listed`,
          password: sql`excluded.password`,
          minCountInFrame: sql`excluded.min_count_in_frame`,
          maxCountInFrame: sql`excluded.max_count_in_frame`,
        },
      });
  });
}

async function upsertSets(db: DrizzleDb, board: AuroraBoardName, data: AuroraSet[]) {
  const setsSchema = UNIFIED_TABLES.sets;
  await processBatches(data, async (batch) => {
    await db
      .insert(setsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          name: item.name,
          hsm: Number(item.hsm),
        })),
      )
      .onConflictDoUpdate({
        target: [setsSchema.boardType, setsSchema.id],
        set: { name: sql`excluded.name`, hsm: sql`excluded.hsm` },
      });
  });
}

async function upsertHoles(db: DrizzleDb, board: AuroraBoardName, data: Hole[]) {
  const holesSchema = UNIFIED_TABLES.holes;
  await processBatches(data, async (batch) => {
    await db
      .insert(holesSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          productId: Number(item.product_id),
          name: item.name,
          x: Number(item.x),
          y: Number(item.y),
          mirroredHoleId: item.mirrored_hole_id != null ? Number(item.mirrored_hole_id) : null,
          mirrorGroup: Number(item.mirror_group),
        })),
      )
      .onConflictDoUpdate({
        target: [holesSchema.boardType, holesSchema.id],
        set: {
          productId: sql`excluded.product_id`,
          name: sql`excluded.name`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          mirroredHoleId: sql`excluded.mirrored_hole_id`,
          mirrorGroup: sql`excluded.mirror_group`,
        },
      });
  });
}

async function upsertLayouts(db: DrizzleDb, board: AuroraBoardName, data: Layout[]) {
  const layoutsSchema = UNIFIED_TABLES.layouts;
  await processBatches(data, async (batch) => {
    await db
      .insert(layoutsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          productId: Number(item.product_id),
          name: item.name,
          instagramCaption: item.instagram_caption,
          isMirrored: Boolean(item.is_mirrored),
          isListed: Boolean(item.is_listed),
          password: item.password,
          createdAt: item.created_at,
        })),
      )
      .onConflictDoUpdate({
        target: [layoutsSchema.boardType, layoutsSchema.id],
        set: {
          productId: sql`excluded.product_id`,
          name: sql`excluded.name`,
          instagramCaption: sql`excluded.instagram_caption`,
          isMirrored: sql`excluded.is_mirrored`,
          isListed: sql`excluded.is_listed`,
          password: sql`excluded.password`,
          createdAt: sql`excluded.created_at`,
        },
      });
  });
}

async function upsertPlacementRoles(db: DrizzleDb, board: AuroraBoardName, data: PlacementRole[]) {
  const placementRolesSchema = UNIFIED_TABLES.placementRoles;
  await processBatches(data, async (batch) => {
    await db
      .insert(placementRolesSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          productId: Number(item.product_id),
          position: Number(item.position),
          name: item.name,
          fullName: item.full_name,
          ledColor: item.led_color,
          screenColor: item.screen_color,
        })),
      )
      .onConflictDoUpdate({
        target: [placementRolesSchema.boardType, placementRolesSchema.id],
        set: {
          productId: sql`excluded.product_id`,
          position: sql`excluded.position`,
          name: sql`excluded.name`,
          fullName: sql`excluded.full_name`,
          ledColor: sql`excluded.led_color`,
          screenColor: sql`excluded.screen_color`,
        },
      });
  });
}

async function upsertLeds(db: DrizzleDb, board: AuroraBoardName, data: Led[]) {
  const ledsSchema = UNIFIED_TABLES.leds;
  await processBatches(data, async (batch) => {
    await db
      .insert(ledsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          productSizeId: Number(item.product_size_id),
          holeId: Number(item.hole_id),
          position: Number(item.position),
        })),
      )
      .onConflictDoUpdate({
        target: [ledsSchema.boardType, ledsSchema.id],
        set: {
          productSizeId: sql`excluded.product_size_id`,
          holeId: sql`excluded.hole_id`,
          position: sql`excluded.position`,
        },
      });
  });
}

async function upsertPlacements(db: DrizzleDb, board: AuroraBoardName, data: Placement[]) {
  const placementsSchema = UNIFIED_TABLES.placements;
  await processBatches(data, async (batch) => {
    await db
      .insert(placementsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          layoutId: Number(item.layout_id),
          holeId: Number(item.hole_id),
          setId: Number(item.set_id),
          defaultPlacementRoleId:
            item.default_placement_role_id != null ? Number(item.default_placement_role_id) : null,
        })),
      )
      .onConflictDoUpdate({
        target: [placementsSchema.boardType, placementsSchema.id],
        set: {
          layoutId: sql`excluded.layout_id`,
          holeId: sql`excluded.hole_id`,
          setId: sql`excluded.set_id`,
          defaultPlacementRoleId: sql`excluded.default_placement_role_id`,
        },
      });
  });
}

async function upsertKits(db: DrizzleDb, board: AuroraBoardName, data: Kit[]) {
  const kitsSchema = UNIFIED_TABLES.kits;
  await processBatches(data, async (batch) => {
    await db
      .insert(kitsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          serialNumber: item.serial_number,
          name: item.name,
          isAutoconnect: Boolean(item.is_autoconnect),
          isListed: Boolean(item.is_listed),
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        })),
      )
      .onConflictDoUpdate({
        target: [kitsSchema.boardType, kitsSchema.serialNumber],
        set: {
          name: sql`excluded.name`,
          isAutoconnect: sql`excluded.is_autoconnect`,
          isListed: sql`excluded.is_listed`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  });
}

async function upsertProductSizesLayoutsSets(db: DrizzleDb, board: AuroraBoardName, data: ProductSizesLayoutsSet[]) {
  const pslsSchema = UNIFIED_TABLES.productSizesLayoutsSets;
  await processBatches(data, async (batch) => {
    await db
      .insert(pslsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          productSizeId: Number(item.product_size_id),
          layoutId: Number(item.layout_id),
          setId: Number(item.set_id),
          imageFilename: item.image_filename,
          isListed: Boolean(item.is_listed),
        })),
      )
      .onConflictDoUpdate({
        target: [pslsSchema.boardType, pslsSchema.id],
        set: {
          productSizeId: sql`excluded.product_size_id`,
          layoutId: sql`excluded.layout_id`,
          setId: sql`excluded.set_id`,
          imageFilename: sql`excluded.image_filename`,
          isListed: sql`excluded.is_listed`,
        },
      });
  });
}

async function upsertProductSizes(db: DrizzleDb, board: AuroraBoardName, data: ProductSize[]) {
  const productSizesSchema = UNIFIED_TABLES.productSizes;
  await processBatches(data, async (batch) => {
    await db
      .insert(productSizesSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          productId: Number(item.product_id),
          edgeLeft: Number(item.edge_left),
          edgeRight: Number(item.edge_right),
          edgeBottom: Number(item.edge_bottom),
          edgeTop: Number(item.edge_top),
          name: item.name,
          description: item.description,
          imageFilename: item.image_filename,
          position: Number(item.position),
          isListed: Boolean(item.is_listed),
        })),
      )
      .onConflictDoUpdate({
        target: [productSizesSchema.boardType, productSizesSchema.id],
        set: {
          productId: sql`excluded.product_id`,
          edgeLeft: sql`excluded.edge_left`,
          edgeRight: sql`excluded.edge_right`,
          edgeBottom: sql`excluded.edge_bottom`,
          edgeTop: sql`excluded.edge_top`,
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          imageFilename: sql`excluded.image_filename`,
          position: sql`excluded.position`,
          isListed: sql`excluded.is_listed`,
        },
      });
  });
}

async function upsertAttempts(db: DrizzleDb, board: AuroraBoardName, data: Attempt[]) {
  const attemptsSchema = UNIFIED_TABLES.attempts;
  await processBatches(data, async (batch) => {
    await db
      .insert(attemptsSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          id: Number(item.id),
          position: Number(item.position),
          name: item.name,
        })),
      )
      .onConflictDoUpdate({
        target: [attemptsSchema.boardType, attemptsSchema.id],
        set: {
          // Only accept remote position updates inside the trusted 0..100 range; reject hostile values
          position: sql`CASE WHEN excluded.position >= 0 AND excluded.position <= 100 THEN excluded.position ELSE ${attemptsSchema.position} END`,
          name: sql`excluded.name`,
        },
      });
  });
}

// Aurora uses 0/1 as missing-difficulty sentinels; neither is a real difficulty
// id. Apply one guard to every upstream difficulty field so average, display,
// and benchmark cannot drift. Non-finite values are rejected before they reach
// Postgres. display_difficulty falls back to a valid normalized average when
// Aurora omits it or sends an invalid sentinel.
export function normalizeDifficulty(difficulty: number | null): number | null {
  if (difficulty == null) return null;
  const numericDifficulty = Number(difficulty);
  return Number.isFinite(numericDifficulty) && numericDifficulty > 1 ? numericDifficulty : null;
}

export function parseDifficultyFields(
  item: Pick<ClimbStats, 'difficulty_average' | 'display_difficulty' | 'benchmark_difficulty'>,
): {
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  benchmarkDifficulty: number | null;
} {
  const difficultyAverage = normalizeDifficulty(item.difficulty_average);
  const displayDifficulty = normalizeDifficulty(item.display_difficulty) ?? difficultyAverage;
  const benchmarkDifficulty = normalizeDifficulty(item.benchmark_difficulty);
  return { difficultyAverage, displayDifficulty, benchmarkDifficulty };
}

type MappedClimbStat = {
  boardType: AuroraBoardName;
  climbUuid: string;
  angle: number;
  displayDifficulty: number | null;
  benchmarkDifficulty: number | null;
  ascensionistCount: number | null;
  upstreamAscensionistCount: number | null;
  difficultyAverage: number | null;
  qualityAverage: number | null;
  qualityNormalized: true;
  faUsername: string | null;
  faAt: string | null;
};

function normalizeAscensionistCount(count: unknown): number | null {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function mapClimbStat(board: AuroraBoardName, item: ClimbStats): MappedClimbStat {
  // Some Aurora rows omit this field or carry malformed values. Preserve that
  // distinction as NULL: ON CONFLICT treats it as "no count update", while an
  // explicit numeric 0 remains an authoritative reset.
  const upstreamAscensionistCount = normalizeAscensionistCount(item.ascensionist_count);
  const { difficultyAverage, displayDifficulty, benchmarkDifficulty } = parseDifficultyFields(item);
  return {
    boardType: board,
    climbUuid: item.climb_uuid,
    angle: Number(item.angle),
    displayDifficulty,
    benchmarkDifficulty,
    ascensionistCount: upstreamAscensionistCount,
    upstreamAscensionistCount,
    difficultyAverage,
    // Keep normalizeQualityTo5's established clamp semantics unchanged.
    qualityAverage: normalizeQualityTo5(item.quality_average),
    qualityNormalized: true,
    ...sanitizeFirstAscent({ faUsername: item.fa_username, faAt: item.fa_at }),
  };
}

function climbStatKey(climbUuid: string, angle: number): string {
  return JSON.stringify([climbUuid, angle]);
}

function isEmptyUpstreamClimbStat(value: MappedClimbStat): boolean {
  return (
    (value.upstreamAscensionistCount ?? 0) === 0 &&
    value.difficultyAverage == null &&
    value.displayDifficulty == null &&
    value.benchmarkDifficulty == null &&
    value.qualityAverage == null &&
    value.faUsername == null &&
    value.faAt == null
  );
}

async function upsertClimbStats(db: DrizzleDb, board: AuroraBoardName, data: ClimbStats[]) {
  const climbStatsSchema = UNIFIED_TABLES.climbStats;

  await processBatches(data, async (batch) => {
    // Three cooperating writers feed this row: Aurora sync (here), Kilter sync
    // (packages/kilter-sync), and the Boardsesh tick recompute
    // (recomputeClimbStats). Each owns its own count column; ascensionist_count
    // is the materialized sum kept in lockstep — every writer touching its own
    // share also recomputes the sum in the same statement.
    //
    // FA fields are written verbatim from Aurora's payload — including null,
    // which is how Aurora signals a correction (revoked / re-attributed FA).
    // Boardsesh-created climbs are never synced through this path, so a
    // Boardsesh-supplied FA on those climbs cannot be clobbered here.
    // recomputeClimbStats is the one that handles the ownership branch
    // explicitly for ticks-driven updates.
    // Normalize and sanitize the whole payload before deciding whether it has
    // meaningful upstream data. An empty payload is skipped only for a NEW
    // key: for an existing key it must reach ON CONFLICT to apply the other
    // upstream-owned fields. An explicit count 0 clears the stored upstream
    // count; a missing or malformed count maps to NULL and preserves it.
    // Boardsesh-owned counts and quality votes are preserved by the conflict
    // SET below.
    const mappedValues = batch.map((item) => mapClimbStat(board, item));
    // existingKeys is only consulted below for empty payloads (the filter's
    // first disjunct short-circuits for non-empty rows), so bound the
    // pre-read to just the empty candidates and skip the SELECT entirely
    // when there are none — in a real catalog sync almost every stats row is
    // non-empty, so this keeps the common case free of a batch-wide pre-read.
    const emptyMappedValues = mappedValues.filter((value) => isEmptyUpstreamClimbStat(value));
    const existingKeys = new Set<string>();
    if (emptyMappedValues.length > 0) {
      const candidateClimbUuids = [...new Set(emptyMappedValues.map((value) => value.climbUuid))];
      const candidateAngles = [...new Set(emptyMappedValues.map((value) => value.angle))];
      const existingRows = await db
        .select({ climbUuid: climbStatsSchema.climbUuid, angle: climbStatsSchema.angle })
        .from(climbStatsSchema)
        .where(
          and(
            eq(climbStatsSchema.boardType, board),
            inArray(climbStatsSchema.climbUuid, candidateClimbUuids),
            inArray(climbStatsSchema.angle, candidateAngles),
          ),
        );
      for (const row of existingRows) existingKeys.add(climbStatKey(row.climbUuid, row.angle));
    }
    const values = mappedValues.filter(
      (value) => !isEmptyUpstreamClimbStat(value) || existingKeys.has(climbStatKey(value.climbUuid, value.angle)),
    );

    if (values.length === 0) return;

    // Stamp upstream_synced_at on the stats row (records that a manufacturer
    // sync just touched it). upstream_quality_average carries the normalized
    // manufacturer average (== value.qualityAverage) into the blend column; the
    // base `values.qualityAverage` still feeds the fresh-row INSERT (blend ==
    // upstream when no Boardsesh votes exist yet). The weekly
    // board_climb_stats_history snapshot is written separately at the end of
    // syncSharedData (a full cross-section, not this per-batch delta) — see
    // snapshotClimbStatsHistoryIfDue.
    const nowIso = new Date().toISOString();
    const statsValues = values.map((value) => ({
      ...value,
      upstreamQualityAverage: value.qualityAverage,
      upstreamSyncedAt: nowIso,
    }));

    // The upstream conflict policy (climbStatsUpstreamConflictSet): take the
    // incoming cursored count verbatim so a legitimate decrease propagates.
    // Resolved ONCE and reused for the
    // count SET, the total, AND the blend weight, because a Postgres SET
    // expression sees the OLD row value of a bare column — the blend must weight
    // by this NEW upstream count, not the stale stored one. Single source keeps
    // the three in lockstep: the blend follows the count policy automatically.
    const upstreamConflictSet = climbStatsUpstreamConflictSet();
    const blendedQualityAverage = blendedQualityAverageSql({
      upstreamQualityAverage: sql`excluded.upstream_quality_average`,
      upstreamAscensionistCount: upstreamConflictSet.upstreamAscensionistCount,
      boardseshQualitySum: sql`${climbStatsSchema.boardseshQualitySum}`,
      boardseshQualityCount: sql`${climbStatsSchema.boardseshQualityCount}`,
    });

    await db
      .insert(climbStatsSchema)
      .values(statsValues)
      .onConflictDoUpdate({
        target: [climbStatsSchema.boardType, climbStatsSchema.climbUuid, climbStatsSchema.angle],
        set: {
          displayDifficulty: sql`excluded.display_difficulty`,
          benchmarkDifficulty: sql`excluded.benchmark_difficulty`,
          // upstream_ = the board's single manufacturer count; take the incoming
          // cursored value verbatim (not GREATEST) so a legitimate decrease
          // propagates. See climbStatsUpstreamConflictSet. Same object drives the
          // blend weight above, keeping count and blend in lockstep.
          ...upstreamConflictSet,
          difficultyAverage: sql`excluded.difficulty_average`,
          // Manufacturer average lands in upstream_quality_average; quality_average
          // is the blend of it and Boardsesh's own votes.
          upstreamQualityAverage: sql`excluded.upstream_quality_average`,
          qualityAverage: blendedQualityAverage,
          qualityNormalized: sql`true`,
          // See firstAscentConflictSet: sanitized once at INSERT-value
          // construction time, so excluded.* here is already safe.
          ...firstAscentConflictSet(),
          // Record that an upstream (manufacturer) sync last touched this row.
          upstreamSyncedAt: sql`excluded.upstream_synced_at`,
          // Aurora owns this row's grade now (#4798). display_difficulty above
          // takes excluded verbatim — including NULL, which is Aurora saying
          // "no grade here" — so the tick-derived marker can never still
          // describe what is stored. Clearing it also releases a grade the
          // recompute had derived: if Aurora nulled the grade, the row now reads
          // "ungraded" and the next recompute re-derives it from ticks.
          tickGradedAt: sql`NULL`,
        },
      });
  });
}

async function upsertBetaLinks(db: DrizzleDb, board: AuroraBoardName, data: BetaLink[]) {
  const betaLinksSchema = UNIFIED_TABLES.betaLinks;
  await processBatches(data, async (batch) => {
    await db
      .insert(betaLinksSchema)
      .values(
        batch.map((item) => ({
          boardType: board,
          climbUuid: item.climb_uuid,
          link: item.link,
          foreignUsername: item.foreign_username,
          angle: item.angle,
          thumbnail: item.thumbnail,
          isListed: item.is_listed,
          createdAt: item.created_at,
        })),
      )
      .onConflictDoUpdate({
        target: [betaLinksSchema.boardType, betaLinksSchema.climbUuid, betaLinksSchema.link],
        set: {
          foreignUsername: sql`excluded.foreign_username`,
          angle: sql`excluded.angle`,
          thumbnail: sql`excluded.thumbnail`,
          isListed: sql`excluded.is_listed`,
          createdAt: sql`excluded.created_at`,
        },
      });
  });
}

async function upsertClimbs(db: DrizzleDb, board: AuroraBoardName, data: Climb[]): Promise<NewClimbInfo[]> {
  const climbsSchema = UNIFIED_TABLES.climbs;
  const climbHoldsSchema = UNIFIED_TABLES.climbHolds;

  if (data.length === 0) return [];

  const uuids = data.map((c) => c.uuid);
  const existingRows = await db
    .select({ uuid: climbsSchema.uuid })
    .from(climbsSchema)
    .where(inArray(climbsSchema.uuid, uuids));
  const existingUuids = new Set(existingRows.map((r) => r.uuid));

  // Climbs: chunked multi-row upsert. The conflict policy splits on ownership:
  //   - NON-user climbs (board_climbs.user_id IS NULL — Aurora catalog rows):
  //     is_draft and is_listed are taken from the incoming payload VERBATIM.
  //     Aurora only re-sends rows it changed, so its flags are authoritative —
  //     an upstream delist (listed → hidden) or re-draft (published → draft)
  //     must propagate so the climb leaves search, matching the deletion the
  //     manufacturer made. (The old policy only ever let the flags flip toward
  //     visible, silently pinning delisted catalog climbs as listed forever.)
  //   - USER climbs (user_id set — Boardsesh-created): flags are preserved on
  //     conflict. A Boardsesh climb is never synced through this path, but the
  //     ownership guard protects it belt-and-suspenders if a UUID ever collides.
  // Everything else (frames/edges/setter/layout/angle) is preserved on
  // conflict — Aurora seeds these on insert, but we don't trust remote
  // re-edits to overwrite our copy.
  await processBatches(data, async (batch) => {
    await db
      .insert(climbsSchema)
      .values(
        batch.map((item) => ({
          uuid: item.uuid,
          boardType: board,
          name: item.name,
          description: item.description,
          hsm: item.hsm,
          edgeLeft: item.edge_left,
          edgeRight: item.edge_right,
          edgeBottom: item.edge_bottom,
          edgeTop: item.edge_top,
          framesCount: item.frames_count,
          framesPace: item.frames_pace,
          frames: item.frames,
          setterId: item.setter_id,
          setterUsername: item.setter_username,
          layoutId: item.layout_id,
          isDraft: item.is_draft,
          isListed: item.is_listed,
          createdAt: item.created_at,
          angle: item.angle,
          // Derive the structured no_match characteristic from Aurora's "No match"
          // description convention on ingest. Other stored rules are preserved
          // by the conflict merge below.
          characteristics: isNoMatchClimb(item.description) ? [CLIMB_CHARACTERISTICS.NO_MATCH] : null,
        })),
      )
      .onConflictDoUpdate({
        target: [climbsSchema.uuid],
        set: {
          // is_draft/is_listed: verbatim for catalog rows, preserved for user
          // climbs. See climbListingConflictSet.
          ...climbListingConflictSet(),
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          characteristics: climbCharacteristicsConflictSql(),
        },
      });
  });

  // Flatten all per-climb holds into a single multi-row INSERT chunked by
  // BATCH_SIZE. With the previous per-climb pattern this was N round-trips for
  // N climbs; flattening turns it into ceil(totalHolds/BATCH_SIZE) round-trips
  // regardless of climb count.
  const allHolds = data.flatMap((item) => {
    const holdsByFrame = convertLitUpHoldsStringToMap(item.frames, board);
    return Object.entries(holdsByFrame).flatMap(([frameNumber, holds]) =>
      Object.entries(holds)
        // An unmapped role code decodes to the `{holdId}={code}` sentinel
        // rather than a real hold state. `backfill-board-climb-holds.ts`
        // already drops those; the two hold writers should agree, or the
        // sentinel poisons `backfill-hold-fingerprints` and the similarity
        // signatures downstream of it (issue #3948).
        .filter(([, { state }]) => !isSentinelHoldState(state))
        .map(([holdId, { state }]) => ({
          boardType: board,
          climbUuid: item.uuid,
          frameNumber: Number(frameNumber),
          holdId: Number(holdId),
          holdState: state,
        })),
    );
  });

  if (allHolds.length > 0) {
    await processBatches(allHolds, async (batch) => {
      await db.insert(climbHoldsSchema).values(batch).onConflictDoNothing();
    });
  }

  await populateDenormalizedColumns(db, board, uuids);

  return data
    .filter((c) => !existingUuids.has(c.uuid))
    .map((c) => ({
      uuid: c.uuid,
      setterId: c.setter_id,
      setterUsername: c.setter_username,
      layoutId: c.layout_id,
      name: c.name,
    }));
}

/**
 * Gate for the required_set_ids straggler drain: run it only when this sync
 * cycle actually moved climbs OR placements, so an idle run never scans the
 * catalog. Late placements (climbs.synced == 0 but placements.synced > 0) must
 * trigger it too — that's exactly the cursor hole being healed. Pure + exported
 * for unit testing.
 */
export function shouldHealRequiredSetIds(totalResults: Record<string, { synced: number }>): boolean {
  return (totalResults['climbs']?.synced ?? 0) > 0 || (totalResults['placements']?.synced ?? 0) > 0;
}

/**
 * Heal climbs whose denormalized `required_set_ids` never populated because
 * their layout's placements arrived in a different sync batch/run than the
 * climb itself — the per-batch populateDenormalizedColumns then found no
 * placements to join and left the column NULL. A NULL `required_set_ids`
 * silently excludes a climb from every set-filtered search (`NULL <@ array` is
 * false), so an otherwise-live climb goes invisible. Runs once at the tail of a
 * sync loop, when every placement this run carried is present; bounded per run
 * so a historical backlog drains over cycles rather than updating tens of
 * thousands of rows in one transaction. (MoonBoard, which uses a separate
 * cell→set path, never flows through this Aurora shared-sync at all.)
 *
 * This is a single capped SELECT per run, not a loop — it cannot spin within a
 * run. A climb whose frames reference holds with no placement on its layout is
 * un-healable (populateDenormalizedColumns leaves it NULL) and would re-appear in
 * the next qualifying run's scan; that's harmless (an idempotent no-op re-write)
 * and bounded by REQUIRED_SET_ID_DRAIN_LIMIT. Prod-verified 2026-07-08: 0 such
 * un-healable rows across kilter/tension/grasshopper/decoy, so no marker column is
 * warranted. If a large un-healable population ever emerges it would occupy the
 * cap and slow (never block) healable stragglers — revisit with a marker then.
 *
 * Exported for tests (gating lives in shouldHealRequiredSetIds).
 */
export async function healRequiredSetIds(db: DrizzleDb, board: AuroraBoardName, log: (message: string) => void) {
  const climbsSchema = UNIFIED_TABLES.climbs;
  const stragglers = await db
    .select({ uuid: climbsSchema.uuid })
    .from(climbsSchema)
    .where(
      and(
        eq(climbsSchema.boardType, board),
        // Synced catalog rows only (user_id IS NULL): the shared sync owns their
        // denormalization. User-authored climbs are populated by their creation
        // path; an un-healable one (frames referencing another layout's
        // placements) would otherwise squat in the drain cap on every run.
        // Prod 2026-07-08: 0 user-authored listed rows with NULL required_set_ids,
        // so this changes no current behaviour — it fences the future.
        isNull(climbsSchema.userId),
        eq(climbsSchema.isListed, true),
        isNull(climbsSchema.requiredSetIds),
        isNotNull(climbsSchema.frames),
      ),
    )
    // TODO(required-set-ids): un-healable rows (frames referencing holds with no
    // placement on the climb's layout) stay NULL and would re-occupy this cap on
    // every run. Prod 2026-07-08: 0 such rows exist; if a population ever
    // emerges, add a marker column (e.g. required_set_ids_unhealable_at) and
    // exclude marked rows here so healable stragglers aren't crowded out.
    .limit(REQUIRED_SET_ID_DRAIN_LIMIT);
  if (stragglers.length === 0) return;
  await populateDenormalizedColumns(
    db,
    board,
    stragglers.map((row) => row.uuid),
  );
  log(`[SharedSync] ${board}: healed required_set_ids for ${stragglers.length} straggler climb(s)`);
}

async function upsertSharedTableData(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  tableName: string,
  data: SyncPutFields[],
  log: (message: string) => void,
): Promise<NewClimbInfo[]> {
  switch (tableName) {
    case 'attempts':
      await upsertAttempts(db, boardName, data as Attempt[]);
      return [];
    case 'products':
      await upsertProducts(db, boardName, data as Product[]);
      return [];
    case 'sets':
      await upsertSets(db, boardName, data as AuroraSet[]);
      return [];
    case 'product_sizes':
      await upsertProductSizes(db, boardName, data as ProductSize[]);
      return [];
    case 'holes':
      await upsertHoles(db, boardName, data as Hole[]);
      return [];
    case 'layouts':
      await upsertLayouts(db, boardName, data as Layout[]);
      return [];
    case 'placement_roles':
      await upsertPlacementRoles(db, boardName, data as PlacementRole[]);
      return [];
    case 'leds':
      await upsertLeds(db, boardName, data as Led[]);
      return [];
    case 'product_sizes_layouts_sets':
      await upsertProductSizesLayoutsSets(db, boardName, data as ProductSizesLayoutsSet[]);
      return [];
    case 'placements':
      await upsertPlacements(db, boardName, data as Placement[]);
      return [];
    case 'kits':
      await upsertKits(db, boardName, data as Kit[]);
      return [];
    case 'climb_stats':
      await upsertClimbStats(db, boardName, data as ClimbStats[]);
      return [];
    case 'beta_links':
      await upsertBetaLinks(db, boardName, data as BetaLink[]);
      return [];
    case 'climbs':
      return upsertClimbs(db, boardName, data as Climb[]);
    case 'shared_syncs':
      await updateSharedSyncs(db, boardName, data as SharedSync[]);
      return [];
    default:
      log(`Table ${tableName} not handled in upsertSharedTableData`);
      return [];
  }
}

async function updateSharedSyncs(tx: DrizzleDb, boardName: AuroraBoardName, sharedSyncs: SharedSync[]) {
  if (sharedSyncs.length === 0) return;
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;
  await tx
    .insert(sharedSyncsSchema)
    .values(
      sharedSyncs.map((sync) => ({
        boardType: boardName,
        tableName: sync.table_name,
        lastSynchronizedAt: sync.last_synchronized_at,
      })),
    )
    .onConflictDoUpdate({
      target: [sharedSyncsSchema.boardType, sharedSyncsSchema.tableName],
      set: {
        lastSynchronizedAt: sql`excluded.last_synchronized_at`,
      },
    });
}

async function getAllSharedSyncTimes(db: DrizzleDb, boardName: AuroraBoardName) {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;

  return db
    .select({
      table_name: sharedSyncsSchema.tableName,
      last_synchronized_at: sharedSyncsSchema.lastSynchronizedAt,
    })
    .from(sharedSyncsSchema)
    .where(eq(sharedSyncsSchema.boardType, boardName));
}

export type SharedSyncResult = {
  complete: boolean;
  results: Record<string, { synced: number; complete: boolean }>;
  newClimbs: NewClimbInfo[];
};

/**
 * Sync shared (non-user-specific) board data — products, sizes, layouts, climbs,
 * climb stats, beta links, etc. Uses the supplied `token` (typically a fresh
 * user token from the daemon) to authenticate against Aurora's `/sync` endpoint.
 *
 * Loops until the response's `_complete` flag is true, persisting each batch
 * before requesting the next. After a successful sync, fires setter-follow
 * notifications for any newly-published climbs.
 */
export async function syncSharedData(
  pgClient: ReturnType<typeof postgres>,
  board: AuroraBoardName,
  token: string,
  log: (message: string) => void = console.info,
): Promise<SharedSyncResult> {
  const db = drizzle(pgClient);

  const allSyncTimes = await getAllSharedSyncTimes(db, board);
  // Single source of truth for cursors across batches — keyed by table name.
  // We seed it from the DB once, then merge each batch's `shared_syncs`
  // response into it. Aurora's response only includes entries for tables it
  // actually returned data for; replacing the whole map (as the original web
  // cron implicitly did by re-reading the DB on every recursion) loses the
  // cursors of untouched tables and resets them to 1970, which sends the same
  // small tables back forever.
  const sharedSyncMap = new Map(allSyncTimes.map((sync) => [sync.table_name, sync.last_synchronized_at]));

  // Floor for any cursor we don't yet have a row for. 2024-05-01 was the
  // pre-existing default seeded across most boards; before that date, Aurora
  // boards Boardsesh tracks weren't in production (or the data isn't worth
  // re-fetching). Sending 1970 here would ask Aurora for ~50 years of changes
  // a brand-new (board, table) tuple could go without ever being touched.
  const defaultTimestamp = '2024-05-01 00:00:00.000000';

  const buildSyncParams = (): SyncOptions => ({
    sharedSyncs: SHARED_SYNC_TABLES.map((tableName) => ({
      table_name: tableName,
      last_synchronized_at: sharedSyncMap.get(tableName) || defaultTimestamp,
    })),
  });

  const totalResults: Record<string, { synced: number; complete: boolean }> = {};
  const allNewClimbs: NewClimbInfo[] = [];
  let isComplete = false;
  let attempts = 0;

  while (!isComplete && attempts < MAX_SYNC_ATTEMPTS) {
    attempts++;
    log(`[SharedSync] Batch ${attempts} for ${board}`);

    const syncResults = await sharedSync(board, buildSyncParams(), token);

    await db.transaction(async (tx) => {
      for (const tableName of PROCESSING_ORDER) {
        const data = syncResults[tableName];
        if (!Array.isArray(data)) continue;
        log(`[SharedSync] ${tableName}: ${data.length} records`);
        const newClimbs = await upsertSharedTableData(tx, board, tableName, data as SyncPutFields[], log);
        allNewClimbs.push(...newClimbs);
        if (!totalResults[tableName]) {
          totalResults[tableName] = { synced: 0, complete: false };
        }
        totalResults[tableName].synced += data.length;
      }

      // Track every requested table so totalResults stays comparable across runs.
      for (const tableName of SHARED_SYNC_TABLES) {
        if (TABLES_TO_PROCESS.has(tableName)) {
          if (!totalResults[tableName]) {
            totalResults[tableName] = { synced: 0, complete: false };
          }
          continue;
        }
        const data = syncResults[tableName];
        if (Array.isArray(data) && data.length > 0) {
          log(`[SharedSync] Skipping ${tableName}: ${data.length} records (not processed)`);
        }
        if (!totalResults[tableName]) {
          totalResults[tableName] = { synced: 0, complete: false };
        }
      }

      const newSharedSyncs = syncResults['shared_syncs'];
      if (Array.isArray(newSharedSyncs)) {
        await updateSharedSyncs(tx, board, newSharedSyncs as SharedSync[]);

        // Merge — never replace. Tables Aurora didn't return this batch keep
        // their existing cursor, instead of being silently reset to 1970.
        for (const sync of newSharedSyncs as SharedSync[]) {
          sharedSyncMap.set(sync.table_name, sync.last_synchronized_at);
        }
      }
    });

    isComplete = syncResults._complete !== false;
    if (!isComplete) {
      log(`[SharedSync] Batch ${attempts} not complete, continuing...`);
    }
  }

  if (attempts >= MAX_SYNC_ATTEMPTS && !isComplete) {
    log(`[SharedSync] Reached max attempts (${MAX_SYNC_ATTEMPTS}) for ${board} without seeing _complete`);
  }

  Object.keys(totalResults).forEach((table) => {
    totalResults[table].complete = isComplete;
  });

  log(
    `[SharedSync] ${board} complete in ${attempts} batch(es); ${allNewClimbs.length} new climb(s); per-table: ${
      Object.entries(totalResults)
        .filter(([, r]) => r.synced > 0)
        .map(([t, r]) => `${t}=${r.synced}`)
        .join(', ') || 'no changes'
    }`,
  );

  // Weekly board_climb_stats_history snapshot: a full cross-section of every
  // climb on the board with ascents, gated by a 7-day per-board watermark.
  // Replaces the old per-batch delta piggyback, which only captured the tiny
  // slice of rows a given /sync batch happened to touch. Runs after the sync
  // loop so it snapshots the freshly-synced counts. A failure here must not
  // fail the sync (the user/shared data already committed).
  try {
    await snapshotClimbStatsHistoryIfDue(db, board, log);
  } catch (error) {
    log(
      `[SharedSync] climb_stats_history snapshot failed for ${board} (sync was OK): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Close the required_set_ids cursor hole: after the whole run is persisted,
  // heal any climbs still missing set ids — gated so an idle sync never scans
  // the catalog (see shouldHealRequiredSetIds).
  if (shouldHealRequiredSetIds(totalResults)) {
    try {
      await healRequiredSetIds(db, board, log);
    } catch (error) {
      log(`[SharedSync] required_set_ids heal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (allNewClimbs.length > 0) {
    try {
      await createSetterSyncNotifications(db, board, allNewClimbs, log);
    } catch (error) {
      log(
        `[SharedSync] Failed to create setter notifications: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { complete: isComplete, results: totalResults, newClimbs: allNewClimbs };
}

/**
 * Create batched notifications for setter followers when new climbs are synced.
 * Mirrors the behavior previously in the web shared-sync route.
 */
export async function createSetterSyncNotifications(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  newClimbs: NewClimbInfo[],
  log: (message: string) => void,
): Promise<void> {
  const climbsBySetter = new Map<string, NewClimbInfo[]>();
  for (const climb of newClimbs) {
    if (!climb.setterUsername) continue;
    const existing = climbsBySetter.get(climb.setterUsername) ?? [];
    existing.push(climb);
    climbsBySetter.set(climb.setterUsername, existing);
  }

  if (climbsBySetter.size === 0) return;

  const setterUsernames = Array.from(climbsBySetter.keys());

  const followers = await db
    .select({
      followerId: setterFollows.followerId,
      setterUsername: setterFollows.setterUsername,
    })
    .from(setterFollows)
    .where(inArray(setterFollows.setterUsername, setterUsernames));

  const linkedMappings = await db
    .select({
      userId: userBoardMappings.userId,
      boardUsername: userBoardMappings.boardUsername,
    })
    .from(userBoardMappings)
    .where(inArray(userBoardMappings.boardUsername, setterUsernames));

  const linkedUsernameToUserId = new Map<string, string>();
  for (const mapping of linkedMappings) {
    if (mapping.boardUsername) {
      linkedUsernameToUserId.set(mapping.boardUsername, mapping.userId);
    }
  }

  const linkedUserIds = Array.from(linkedUsernameToUserId.values());
  let userFollowsList: Array<{ followerId: string; followingId: string }> = [];
  if (linkedUserIds.length > 0) {
    userFollowsList = await db
      .select({
        followerId: userFollows.followerId,
        followingId: userFollows.followingId,
      })
      .from(userFollows)
      .where(inArray(userFollows.followingId, linkedUserIds));
  }

  for (const [setterUsername, climbs] of climbsBySetter) {
    const recipientIds = new Set<string>();

    for (const follow of followers) {
      if (follow.setterUsername === setterUsername) {
        recipientIds.add(follow.followerId);
      }
    }

    const linkedUserId = linkedUsernameToUserId.get(setterUsername);
    if (linkedUserId) {
      for (const follow of userFollowsList) {
        if (follow.followingId === linkedUserId) {
          recipientIds.add(follow.followerId);
        }
      }
    }

    if (recipientIds.size === 0) continue;

    // The batch's HEAD climb identifies the notification, so the dedup below
    // only holds while two concurrent syncs derive the same head. They do
    // today: both pre-read the same set of new climbs, and climbsBySetter
    // preserves Aurora's response order, which is identical for both. If you
    // ever sort, filter or re-chunk `climbs` before this point, keep it
    // deterministic — a differing head uuid gives the two runs different
    // notification uuids and the duplicate lands despite the unique constraint.
    const firstClimbUuid = climbs[0].uuid;
    const actorId = linkedUserId ?? null;
    // Deterministic uuid, so a repeat of this exact notification collides on
    // notifications.uuid (already NOT NULL UNIQUE) instead of landing twice.
    // New-climb detection is a pre-read of existing uuids, so two shared syncs
    // running at once both classify the same climbs as new — this is the
    // backstop for that, independent of the cooldown claim that stops the two
    // runs overlapping in the first place. See setterSyncNotificationUuid.
    const notificationValues = Array.from(recipientIds).map((recipientId) => ({
      uuid: setterSyncNotificationUuid({ recipientId, entityId: firstClimbUuid, actorId }),
      recipientId,
      actorId,
      type: 'new_climbs_synced' as const,
      entityType: 'climb' as const,
      entityId: firstClimbUuid,
    }));

    // Chunked to stay under Postgres's 65 535-parameter ceiling. The
    // notifications insert touches 6 columns per row, so a single statement
    // tops out around 10 900 rows — a popular setter with more followers
    // than that would silently fail without the chunk.
    await processBatches(notificationValues, async (chunk) => {
      // No conflict target: `uuid` is the only unique constraint on the table,
      // so an untargeted DO NOTHING is unambiguous and needs no index predicate.
      await db.insert(notifications).values(chunk).onConflictDoNothing();
    });
    log(
      `[SharedSync] Created ${notificationValues.length} notifications for setter "${setterUsername}" (${climbs.length} new climbs on ${boardName})`,
    );
  }
}
