import { sharedSync } from '../api/shared-sync-api';
import { type SyncOptions, type AuroraBoardName, SHARED_SYNC_TABLES } from '../api/types';
import { sql, eq, and, inArray } from 'drizzle-orm';
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
import { normalizeQualityTo5 } from '@boardsesh/shared-schema';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';
import { setterFollows, notifications, userBoardMappings, userFollows } from '@boardsesh/db/schema';
import { randomUUID } from 'crypto';

// Common ancestor of `PostgresJsDatabase` and the `PgTransaction` Drizzle
// hands you inside `db.transaction(async (tx) => …)`. Both expose the same
// query-builder surface (`insert`, `select`, `update`, `execute`), so we type
// against the parent and avoid the `tx as unknown as …` cast at the call site.
type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// Synthetic `board_shared_syncs.table_name` row that records the last time we
// wrote a `board_climb_stats_history` snapshot for this board. The name
// starts with `__local_` so it can never collide with an Aurora-side table
// returned in the `shared_syncs` array of a `/sync` response.
const HISTORY_CURSOR_TABLE_NAME = '__local_climb_stats_history__';
const HISTORY_SNAPSHOT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

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

async function upsertClimbStats(db: DrizzleDb, board: AuroraBoardName, data: ClimbStats[], writeHistory: boolean) {
  const climbStatsSchema = UNIFIED_TABLES.climbStats;
  const climbStatHistorySchema = UNIFIED_TABLES.climbStatsHistory;

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
    const values = batch.map((item) => {
      const auroraCount = Number(item.ascensionist_count);
      return {
        boardType: board,
        climbUuid: item.climb_uuid,
        angle: Number(item.angle),
        displayDifficulty: Number(item.display_difficulty || item.difficulty_average),
        benchmarkDifficulty: item.benchmark_difficulty != null ? Number(item.benchmark_difficulty) : null,
        ascensionistCount: auroraCount,
        auroraAscensionistCount: auroraCount,
        difficultyAverage: Number(item.difficulty_average),
        // Aurora reports quality on a 1–3 scale; Kilter Grips and MoonBoard use
        // 1–5. Normalise every board to 1–5 (×5/3) so board_climb_stats.quality_average
        // is one scale the UI can render uniformly. quality_average is a stored
        // average (double), so keep it continuous rather than rounding.
        qualityAverage: normalizeQualityTo5(item.quality_average),
        // We just normalised quality_average to 1-5, so the row is on the
        // canonical scale — the one-time 1-3→1-5 backfill must skip it.
        qualityNormalized: true,
        faUsername: item.fa_username,
        faAt: item.fa_at,
      };
    });

    await db
      .insert(climbStatsSchema)
      .values(values)
      .onConflictDoUpdate({
        target: [climbStatsSchema.boardType, climbStatsSchema.climbUuid, climbStatsSchema.angle],
        set: {
          displayDifficulty: sql`excluded.display_difficulty`,
          benchmarkDifficulty: sql`excluded.benchmark_difficulty`,
          auroraAscensionistCount: sql`excluded.aurora_ascensionist_count`,
          // aurora_ and kilter_ are alternate upstream snapshots for Kilter,
          // not independent sources. Use the higher upstream count so stale
          // snapshots do not lower a climb, then add Boardsesh's local count.
          ascensionistCount: sql`GREATEST(COALESCE(${climbStatsSchema.kilterAscensionistCount}, 0), COALESCE(excluded.aurora_ascensionist_count, 0)) + COALESCE(${climbStatsSchema.boardseshAscensionistCount}, 0)`,
          difficultyAverage: sql`excluded.difficulty_average`,
          qualityAverage: sql`excluded.quality_average`,
          qualityNormalized: sql`true`,
          faUsername: sql`excluded.fa_username`,
          faAt: sql`excluded.fa_at`,
        },
      });

    // History snapshot is gated by a per-board cursor in `board_shared_syncs`
    // so we only append a row every ~7 days. Without this gate the table
    // would grow up to 24× faster than under the old daily Vercel cron, with
    // most rows recording zero meaningful change.
    if (writeHistory) {
      await db.insert(climbStatHistorySchema).values(values);
    }
  });
}

async function isClimbStatsHistorySnapshotDue(db: DrizzleDb, board: AuroraBoardName): Promise<boolean> {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;
  const rows = await db
    .select({ lastSynchronizedAt: sharedSyncsSchema.lastSynchronizedAt })
    .from(sharedSyncsSchema)
    .where(and(eq(sharedSyncsSchema.boardType, board), eq(sharedSyncsSchema.tableName, HISTORY_CURSOR_TABLE_NAME)));
  if (rows.length === 0) return true;

  const raw = rows[0].lastSynchronizedAt;
  // last_synchronized_at is stored as a Postgres timestamp string (no zone);
  // treat it as UTC for the comparison.
  const lastMs = Date.parse(`${raw}Z`);
  if (Number.isNaN(lastMs)) return true;
  return Date.now() - lastMs >= HISTORY_SNAPSHOT_INTERVAL_MS;
}

async function markClimbStatsHistorySnapshotDone(db: DrizzleDb, board: AuroraBoardName): Promise<void> {
  const sharedSyncsSchema = UNIFIED_TABLES.sharedSyncs;
  // Match the `last_synchronized_at` text format Aurora uses elsewhere in
  // this table (`YYYY-MM-DD HH:MM:SS.ffffff`, no timezone). It's interpreted
  // as UTC by `isClimbStatsHistorySnapshotDue` above.
  const nowText = new Date().toISOString().replace('T', ' ').replace('Z', '');
  await db
    .insert(sharedSyncsSchema)
    .values({
      boardType: board,
      tableName: HISTORY_CURSOR_TABLE_NAME,
      lastSynchronizedAt: nowText,
    })
    .onConflictDoUpdate({
      target: [sharedSyncsSchema.boardType, sharedSyncsSchema.tableName],
      set: {
        lastSynchronizedAt: sql`excluded.last_synchronized_at`,
      },
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

  // Climbs: chunked multi-row upsert. The conflict policy is asymmetric on
  // the two boolean flags (inherited verbatim from the original web cron):
  //   - isDraft (true = draft, false = published) is only allowed to flip
  //     false → true, i.e. let Aurora pull a previously-published climb back
  //     to draft. The reverse direction (draft → published) is NOT honored
  //     here; a draft climb stays draft in our copy until it's seen as
  //     published on insert (new row) or until this is reworked.
  //   - isListed (true = visible, false = hidden) only flips false → true,
  //     i.e. once a climb is publicly listed we keep it listed even if a
  //     later remote re-edit tries to hide it.
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
        })),
      )
      .onConflictDoUpdate({
        target: [climbsSchema.uuid],
        set: {
          isDraft: sql`CASE WHEN ${climbsSchema.isDraft} = false AND excluded.is_draft = true THEN true ELSE ${climbsSchema.isDraft} END`,
          isListed: sql`CASE WHEN ${climbsSchema.isListed} = false AND excluded.is_listed = true THEN true ELSE ${climbsSchema.isListed} END`,
          name: sql`excluded.name`,
          description: sql`excluded.description`,
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
      Object.entries(holds).map(([holdId, { state }]) => ({
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

async function upsertSharedTableData(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  tableName: string,
  data: SyncPutFields[],
  log: (message: string) => void,
  writeClimbStatsHistory: boolean,
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
      await upsertClimbStats(db, boardName, data as ClimbStats[], writeClimbStatsHistory);
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

  // Decide once per syncSharedData run whether this is the week's history
  // snapshot. We commit the cursor at the end (only if we actually wrote
  // history rows), so a crash mid-loop will retry on the next invocation
  // rather than silently skip a week.
  const writeClimbStatsHistory = await isClimbStatsHistorySnapshotDue(db, board);
  let didWriteClimbStatsHistory = false;
  if (writeClimbStatsHistory) {
    log(`[SharedSync] Weekly climb_stats_history snapshot is due for ${board}`);
  }

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
        const newClimbs = await upsertSharedTableData(
          tx,
          board,
          tableName,
          data as SyncPutFields[],
          log,
          writeClimbStatsHistory,
        );
        allNewClimbs.push(...newClimbs);
        if (tableName === 'climb_stats' && writeClimbStatsHistory && data.length > 0) {
          didWriteClimbStatsHistory = true;
        }
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

  if (didWriteClimbStatsHistory) {
    await markClimbStatsHistorySnapshotDone(db, board);
    log(`[SharedSync] Recorded climb_stats_history snapshot timestamp for ${board}`);
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

    const firstClimbUuid = climbs[0].uuid;
    const notificationValues = Array.from(recipientIds).map((recipientId) => ({
      uuid: randomUUID(),
      recipientId,
      actorId: linkedUserId ?? null,
      type: 'new_climbs_synced' as const,
      entityType: 'climb' as const,
      entityId: firstClimbUuid,
    }));

    // Chunked to stay under Postgres's 65 535-parameter ceiling. The
    // notifications insert touches 6 columns per row, so a single statement
    // tops out around 10 900 rows — a popular setter with more followers
    // than that would silently fail without the chunk.
    await processBatches(notificationValues, async (chunk) => {
      await db.insert(notifications).values(chunk);
    });
    log(
      `[SharedSync] Created ${notificationValues.length} notifications for setter "${setterUsername}" (${climbs.length} new climbs on ${boardName})`,
    );
  }
}
