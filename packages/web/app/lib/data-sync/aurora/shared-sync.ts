import { getDb } from '@/app/lib/db/db';
import type { SyncOptions, AuroraBoardName } from '../../api-wrappers/aurora/types';
import { sharedSync } from '../../api-wrappers/aurora/sharedSync';
import { sql, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type {
  Attempt,
  BetaLink,
  Climb,
  ClimbStats,
  Hole,
  Layout,
  Led,
  PlacementRole,
  Product,
  ProductSize,
  ProductSizesLayoutsSet,
  Set as AuroraSet,
  SharedSync,
  SyncPutFields,
} from '../../api-wrappers/sync-api-types';
import { UNIFIED_TABLES } from '../../db/queries/util/table-select';
import { convertLitUpHoldsStringToMap } from '@/app/components/board-renderer/util';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';

export type NewClimbInfo = {
  uuid: string;
  setterId?: number;
  setterUsername?: string;
  layoutId: number;
  name?: string;
};

// Define shared sync tables in correct dependency order
// Order matches what the Android app sends - keep full list to remain indistinguishable
export const SHARED_SYNC_TABLES: string[] = [
  'products',
  'product_sizes',
  'holes',
  'leds',
  'products_angles',
  'layouts',
  'product_sizes_layouts_sets',
  'placements',
  'sets',
  'placement_roles',
  'climbs',
  'climb_stats',
  'beta_links',
  'attempts',
  'kits',
];

// Tables we actually want to process and store, in FK-safe upsert order.
// SHARED_SYNC_TABLES matches the Android app's request order for indistinguishability,
// but that order is not FK-safe — e.g. `product_sizes_layouts_sets` appears before
// `sets` even though the former FKs to the latter. Iterate this list in the upsert
// loop instead. The Aurora API request still uses SHARED_SYNC_TABLES.
//
// Out of scope here:
// - `products_angles` and `kits`: no `board_*` schema to write to.
// - `placements`: schema exists but `Placement` has no Aurora API type, and the API's
//   SyncDataPUT does not include placements rows.
export const PROCESSING_ORDER: string[] = [
  'products',
  'sets',
  'product_sizes',
  'holes',
  'layouts',
  'placement_roles',
  'leds',
  'product_sizes_layouts_sets',
  'climbs',
  'climb_stats',
  'beta_links',
  'attempts',
];

const TABLES_TO_PROCESS = new Set([...PROCESSING_ORDER, 'shared_syncs']);

const SHARED_BATCH_SIZE = 100;

async function processBatches<T>(
  data: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < data.length; i += batchSize) {
    await processor(data.slice(i, i + batchSize));
  }
}

// First-row shape assertion — catches gross misuse (e.g. Aurora returning the wrong
// shape under a known key, or a mistyped cast) before we hit the DB. Cheap, no Zod dep.
export function expectArrayShape(data: readonly unknown[], requiredKeys: readonly string[], tableName: string): void {
  if (data.length === 0) return;
  const first = data[0] as Record<string, unknown>;
  const missing = requiredKeys.filter((key) => !(key in first));
  if (missing.length > 0) {
    throw new Error(
      `shared-sync: ${tableName} payload missing required key(s) [${missing.join(', ')}]; got keys [${Object.keys(first).join(', ')}]`,
    );
  }
}

async function upsertProducts(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: Product[],
): Promise<void> {
  const schema = UNIFIED_TABLES.products;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      name: item.name,
      isListed: Boolean(item.is_listed),
      password: item.password,
      minCountInFrame: Number(item.min_count_in_frame),
      maxCountInFrame: Number(item.max_count_in_frame),
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
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

async function upsertSets(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: AuroraSet[],
): Promise<void> {
  const schema = UNIFIED_TABLES.sets;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      name: item.name,
      hsm: Number(item.hsm),
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
        set: {
          name: sql`excluded.name`,
          hsm: sql`excluded.hsm`,
        },
      });
  });
}

async function upsertHoles(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: Hole[],
): Promise<void> {
  const schema = UNIFIED_TABLES.holes;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      productId: Number(item.product_id),
      name: item.name,
      x: Number(item.x),
      y: Number(item.y),
      mirroredHoleId: item.mirrored_hole_id != null ? Number(item.mirrored_hole_id) : null,
      mirrorGroup: Number(item.mirror_group),
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
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

async function upsertLayouts(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: Layout[],
): Promise<void> {
  const schema = UNIFIED_TABLES.layouts;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      productId: Number(item.product_id),
      name: item.name,
      instagramCaption: item.instagram_caption,
      isMirrored: Boolean(item.is_mirrored),
      isListed: Boolean(item.is_listed),
      password: item.password,
      createdAt: item.created_at,
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
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

async function upsertPlacementRoles(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: PlacementRole[],
): Promise<void> {
  const schema = UNIFIED_TABLES.placementRoles;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      productId: Number(item.product_id),
      position: Number(item.position),
      name: item.name,
      fullName: item.full_name,
      ledColor: item.led_color,
      screenColor: item.screen_color,
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
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

async function upsertLeds(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: Led[],
): Promise<void> {
  const schema = UNIFIED_TABLES.leds;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      productSizeId: Number(item.product_size_id),
      holeId: Number(item.hole_id),
      position: Number(item.position),
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
        set: {
          productSizeId: sql`excluded.product_size_id`,
          holeId: sql`excluded.hole_id`,
          position: sql`excluded.position`,
        },
      });
  });
}

async function upsertProductSizesLayoutsSets(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: ProductSizesLayoutsSet[],
): Promise<void> {
  const schema = UNIFIED_TABLES.productSizesLayoutsSets;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
      boardType: board,
      id: Number(item.id),
      productSizeId: Number(item.product_size_id),
      layoutId: Number(item.layout_id),
      setId: Number(item.set_id),
      imageFilename: item.image_filename,
      isListed: Boolean(item.is_listed),
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
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

async function upsertProductSizes(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: ProductSize[],
): Promise<void> {
  const schema = UNIFIED_TABLES.productSizes;
  await processBatches(data, SHARED_BATCH_SIZE, async (batch) => {
    const rows = batch.map((item) => ({
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
    }));
    await db
      .insert(schema)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.boardType, schema.id],
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

const upsertAttempts = (
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: Attempt[],
) =>
  Promise.all(
    data.map(async (item) => {
      const attemptsSchema = UNIFIED_TABLES.attempts;
      return db
        .insert(attemptsSchema)
        .values({
          boardType: board,
          id: Number(item.id),
          position: Number(item.position),
          name: item.name,
        })
        .onConflictDoUpdate({
          target: [attemptsSchema.boardType, attemptsSchema.id],
          set: {
            // Only allow position updates if they're reasonable (0-100)
            position: sql`CASE WHEN ${Number(item.position)} >= 0 AND ${Number(item.position)} <= 100 THEN ${Number(item.position)} ELSE ${attemptsSchema.position} END`,
            // Allow name updates for display purposes
            name: item.name,
          },
        });
    }),
  );

async function upsertClimbStats(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: ClimbStats[],
) {
  const climbStatsSchema = UNIFIED_TABLES.climbStats;
  const climbStatHistorySchema = UNIFIED_TABLES.climbStatsHistory;

  await Promise.all(
    data.map((item) => {
      return Promise.all([
        // Update current stats
        db
          .insert(climbStatsSchema)
          .values({
            boardType: board,
            climbUuid: item.climb_uuid,
            angle: Number(item.angle),
            displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
            benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
            ascensionistCount: Number(item.ascensionist_count),
            difficultyAverage: Number(item.difficulty_average),
            qualityAverage: Number(item.quality_average),
            faUsername: item.fa_username,
            faAt: item.fa_at,
          })
          .onConflictDoUpdate({
            target: [climbStatsSchema.boardType, climbStatsSchema.climbUuid, climbStatsSchema.angle],
            set: {
              displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
              benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
              ascensionistCount: Number(item.ascensionist_count),
              difficultyAverage: Number(item.difficulty_average),
              qualityAverage: Number(item.quality_average),
              faUsername: item.fa_username,
              faAt: item.fa_at,
            },
          }),

        // Also insert into history table
        db.insert(climbStatHistorySchema).values({
          boardType: board,
          climbUuid: item.climb_uuid,
          angle: Number(item.angle),
          displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
          benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
          ascensionistCount: Number(item.ascensionist_count),
          difficultyAverage: Number(item.difficulty_average),
          qualityAverage: Number(item.quality_average),
          faUsername: item.fa_username,
          faAt: item.fa_at,
        }),
      ]);
    }),
  );
}

async function upsertBetaLinks(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: BetaLink[],
) {
  const betaLinksSchema = UNIFIED_TABLES.betaLinks;

  await Promise.all(
    data.map((item) => {
      return db
        .insert(betaLinksSchema)
        .values({
          boardType: board,
          climbUuid: item.climb_uuid,
          link: item.link,
          foreignUsername: item.foreign_username,
          angle: item.angle,
          thumbnail: item.thumbnail,
          isListed: item.is_listed,
          createdAt: item.created_at,
        })
        .onConflictDoUpdate({
          target: [betaLinksSchema.boardType, betaLinksSchema.climbUuid, betaLinksSchema.link],
          set: {
            foreignUsername: item.foreign_username,
            angle: item.angle,
            thumbnail: item.thumbnail,
            isListed: item.is_listed,
            createdAt: item.created_at,
          },
        });
    }),
  );
}

async function upsertClimbs(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  board: AuroraBoardName,
  data: Climb[],
): Promise<NewClimbInfo[]> {
  const climbsSchema = UNIFIED_TABLES.climbs;
  const climbHoldsSchema = UNIFIED_TABLES.climbHolds;

  if (data.length === 0) return [];

  // Check which UUIDs already exist to track new climbs
  const uuids = data.map((c) => c.uuid);
  const existingRows = await db
    .select({ uuid: climbsSchema.uuid })
    .from(climbsSchema)
    .where(inArray(climbsSchema.uuid, uuids));
  const existingUuids = new Set(existingRows.map((r) => r.uuid));

  await Promise.all(
    data.map(async (item: Climb) => {
      // Insert or update the climb
      await db
        .insert(climbsSchema)
        .values({
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
        })
        .onConflictDoUpdate({
          target: [climbsSchema.uuid],
          set: {
            // Only allow isDraft to change from false to true (publishing)
            isDraft: sql`CASE WHEN ${climbsSchema.isDraft} = false AND ${item.is_draft} = true THEN true ELSE ${climbsSchema.isDraft} END`,
            // Only allow isListed to change from false to true (making public)
            isListed: sql`CASE WHEN ${climbsSchema.isListed} = false AND ${item.is_listed} = true THEN true ELSE ${climbsSchema.isListed} END`,
            // Allow updates to descriptive fields
            name: item.name,
            description: item.description,
            // Preserve all core climb data - never allow hostile updates to these critical fields
            hsm: climbsSchema.hsm,
            edgeLeft: climbsSchema.edgeLeft,
            edgeRight: climbsSchema.edgeRight,
            edgeBottom: climbsSchema.edgeBottom,
            edgeTop: climbsSchema.edgeTop,
            framesCount: climbsSchema.framesCount,
            framesPace: climbsSchema.framesPace,
            frames: climbsSchema.frames,
            setterId: climbsSchema.setterId,
            setterUsername: climbsSchema.setterUsername,
            layoutId: climbsSchema.layoutId,
            angle: climbsSchema.angle,
          },
        });

      const holdsByFrame = convertLitUpHoldsStringToMap(item.frames, board);

      const holdsToInsert = Object.entries(holdsByFrame).flatMap(([frameNumber, holds]) =>
        Object.entries(holds).map(([holdId, { state }]) => ({
          boardType: board,
          climbUuid: item.uuid,
          frameNumber: Number(frameNumber),
          holdId: Number(holdId),
          holdState: state,
        })),
      );

      await db.insert(climbHoldsSchema).values(holdsToInsert).onConflictDoNothing(); // Avoid duplicate inserts
    }),
  );

  // Populate denormalized required_set_ids and compatible_size_ids for the synced climbs
  const uuids_to_populate = data.map((c) => c.uuid);
  await populateDenormalizedColumns(db, board, uuids_to_populate);

  // Return info about newly inserted climbs
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

export async function upsertSharedTableData(
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardName: AuroraBoardName,
  tableName: string,
  data: SyncPutFields[],
): Promise<NewClimbInfo[]> {
  switch (tableName) {
    case 'attempts':
      await upsertAttempts(db, boardName, data as Attempt[]);
      return [];
    case 'products':
      expectArrayShape(data, ['id', 'name', 'is_listed', 'min_count_in_frame', 'max_count_in_frame'], 'products');
      await upsertProducts(db, boardName, data as Product[]);
      return [];
    case 'sets':
      expectArrayShape(data, ['id', 'name', 'hsm'], 'sets');
      await upsertSets(db, boardName, data as AuroraSet[]);
      return [];
    case 'product_sizes':
      expectArrayShape(
        data,
        ['id', 'product_id', 'edge_left', 'edge_right', 'edge_bottom', 'edge_top', 'name', 'is_listed'],
        'product_sizes',
      );
      await upsertProductSizes(db, boardName, data as ProductSize[]);
      return [];
    case 'holes':
      expectArrayShape(data, ['id', 'product_id', 'name', 'x', 'y', 'mirror_group'], 'holes');
      await upsertHoles(db, boardName, data as Hole[]);
      return [];
    case 'layouts':
      expectArrayShape(data, ['id', 'product_id', 'name', 'is_mirrored', 'is_listed'], 'layouts');
      await upsertLayouts(db, boardName, data as Layout[]);
      return [];
    case 'placement_roles':
      expectArrayShape(
        data,
        ['id', 'product_id', 'position', 'name', 'full_name', 'led_color', 'screen_color'],
        'placement_roles',
      );
      await upsertPlacementRoles(db, boardName, data as PlacementRole[]);
      return [];
    case 'leds':
      expectArrayShape(data, ['id', 'product_size_id', 'hole_id', 'position'], 'leds');
      await upsertLeds(db, boardName, data as Led[]);
      return [];
    case 'product_sizes_layouts_sets':
      expectArrayShape(
        data,
        ['id', 'product_size_id', 'layout_id', 'set_id', 'is_listed'],
        'product_sizes_layouts_sets',
      );
      await upsertProductSizesLayoutsSets(db, boardName, data as ProductSizesLayoutsSet[]);
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
      // Tables not in TABLES_TO_PROCESS are handled in the main sync loop
      console.info(`Table ${tableName} not handled in upsertSharedTableData`);
      return [];
  }
}
async function updateSharedSyncs(
  tx: PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  boardName: AuroraBoardName,
  sharedSyncs: SharedSync[],
) {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;

  for (const sync of sharedSyncs) {
    await tx
      .insert(sharedSyncsSchema)
      .values({
        boardType: boardName,
        tableName: sync.table_name,
        lastSynchronizedAt: sync.last_synchronized_at,
      })
      .onConflictDoUpdate({
        target: [sharedSyncsSchema.boardType, sharedSyncsSchema.tableName],
        set: {
          lastSynchronizedAt: sync.last_synchronized_at,
        },
      });
  }
}

export async function getLastSharedSyncTimes(boardName: AuroraBoardName) {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;
  const db = getDb();

  const result = await db
    .select({
      table_name: sharedSyncsSchema.tableName,
      last_synchronized_at: sharedSyncsSchema.lastSynchronizedAt,
    })
    .from(sharedSyncsSchema)
    .where(eq(sharedSyncsSchema.boardType, boardName));

  return result;
}

export async function syncSharedData(
  board: AuroraBoardName,
  token: string,
): Promise<{
  complete: boolean;
  results: Record<string, { synced: number; complete: boolean }>;
  newClimbs: NewClimbInfo[];
}> {
  try {
    // Get shared sync times
    const allSyncTimes = await getLastSharedSyncTimes(board);

    // Create a map of existing sync times
    const sharedSyncMap = new Map(allSyncTimes.map((sync) => [sync.table_name, sync.last_synchronized_at]));

    // Ensure all shared tables have a sync entry (default to 1970 if not synced)
    const defaultTimestamp = '1970-01-01 00:00:00.000000';

    const syncParams: SyncOptions = {
      tables: [...SHARED_SYNC_TABLES],
      sharedSyncs: SHARED_SYNC_TABLES.map((tableName) => ({
        table_name: tableName,
        last_synchronized_at: sharedSyncMap.get(tableName) || defaultTimestamp,
      })),
    };

    // Initialize results tracking
    const totalResults: Record<string, { synced: number; complete: boolean }> = {};
    const allNewClimbs: NewClimbInfo[] = [];
    let isComplete = false;

    const syncResults = await sharedSync(board, syncParams, token);

    // Process this batch in a transaction
    const db = getDb();
    await db.transaction(async (tx) => {
      // Upsert in FK-safe PROCESSING_ORDER, not SHARED_SYNC_TABLES (request) order.
      for (const tableName of PROCESSING_ORDER) {
        const data = syncResults[tableName];
        if (!Array.isArray(data)) continue;
        console.info(`Syncing ${tableName}: ${data.length} records`);
        const newClimbs = await upsertSharedTableData(tx, board, tableName, data);
        allNewClimbs.push(...newClimbs);
        if (!totalResults[tableName]) {
          totalResults[tableName] = { synced: 0, complete: false };
        }
        totalResults[tableName].synced += data.length;
      }

      // Track every table the API responded with — including ones we don't process —
      // so totalResults stays comparable across runs and skipped tables are visible.
      for (const tableName of SHARED_SYNC_TABLES) {
        const data = syncResults[tableName];
        if (TABLES_TO_PROCESS.has(tableName)) {
          if (!totalResults[tableName]) {
            totalResults[tableName] = { synced: 0, complete: false };
          }
          continue;
        }
        if (Array.isArray(data)) {
          console.info(`Skipping ${tableName}: ${data.length} records (not processed)`);
        }
        if (!totalResults[tableName]) {
          totalResults[tableName] = { synced: 0, complete: false };
        }
      }

      // Update shared_syncs table with new sync times from this batch
      if (syncResults['shared_syncs']) {
        console.info('Updating shared_syncs with data:', syncResults['shared_syncs']);
        await updateSharedSyncs(tx, board, syncResults['shared_syncs']);

        // Update sync params for next iteration with new timestamps
        const newSharedSyncs = syncResults['shared_syncs'].map(
          (sync: { table_name: string; last_synchronized_at: string }) => ({
            table_name: sync.table_name,
            last_synchronized_at: sync.last_synchronized_at,
          }),
        );

        // Log timestamp updates for debugging
        const climbsSync = newSharedSyncs.find((s: { table_name: string }) => s.table_name === 'climbs');
        if (climbsSync) {
          console.info(`Climbs table sync timestamp updated to: ${climbsSync.last_synchronized_at}`);
        }

        // Update syncParams for next batch
        syncParams.sharedSyncs = newSharedSyncs;
      } else {
        console.info('No shared_syncs data in sync results');
      }
    });

    // Check if sync is complete - default to true if _complete is not present (matches Android app behavior)
    isComplete = syncResults._complete !== false;

    console.info(`Sync complete. _complete flag: ${syncResults._complete}, isComplete: ${isComplete}`);

    // Mark completion status for all tables
    Object.keys(totalResults).forEach((table) => {
      totalResults[table].complete = isComplete;
    });

    // Log summary of what was synced
    console.info('Sync batch summary:');
    Object.entries(totalResults).forEach(([table, result]) => {
      if (result.synced > 0) {
        console.info(`  ${table}: ${result.synced} records synced`);
      }
    });
    console.info(`Sync complete: ${isComplete}`);

    return { complete: isComplete, results: totalResults, newClimbs: allNewClimbs };
  } catch (error) {
    console.error('Error syncing shared data:', error);
    throw error;
  }
}
