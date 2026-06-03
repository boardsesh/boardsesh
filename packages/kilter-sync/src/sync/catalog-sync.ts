import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  boardClimbs,
  boardClimbStats,
  boardClimbHolds,
  boardClimbAliases,
  boardLayoutAliases,
  boardPlacements,
  type NewBoardClimb,
} from '@boardsesh/db/schema';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';

import type { KilterTokenProvider } from '../api/token-provider';
import { fetchLayoutClimbs, fetchLayoutClimbStats, fetchDeletedClimbUuids } from '../api/kilter-rest';
import { KilterApiError } from '../api/errors';
import { pullKilterReference, type KilterReferencePull } from './reference-pull';
import { buildLayoutResolver } from './layout-resolver';
import { gripsClimbConcatToFrames, framesToHolds } from './catalog-parse';
import { fingerprintFromHolds } from './fingerprint';
import { createSetterSyncNotifications, type NewClimbInfo } from './notifications';
import { reconcileDeletions, type DeletionReport } from './deletions';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';
const BATCH = 1000;

export type SyncKilterCatalogArgs = {
  db: DrizzleDb;
  tokenProvider: KilterTokenProvider;
  log?: (message: string) => void;
  /** Inject a pre-pulled reference (tests / to skip the PowerSync round-trip). */
  reference?: KilterReferencePull;
  /** Restrict to these Grips product_layout_uuids (testing / partial runs). */
  layoutUuids?: string[];
  /**
   * Apply /delteduuids reconciliation. Default false = classify + report only.
   * Deleting catalog rows is data deletion (see CLAUDE.md) — opt in explicitly.
   */
  applyDeletions?: boolean;
};

export type KilterCatalogSummary = {
  gripsLayoutsProcessed: number;
  layoutsUnmapped: number;
  climbsSeen: number;
  climbsUnmapped: number;
  canonicalsInserted: number;
  aliasesUpserted: number;
  statsUpserted: number;
  deletions: DeletionReport;
};

async function processBatches<T>(rows: T[], fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await fn(rows.slice(i, i + BATCH));
  }
}

/**
 * Run a REST call, refreshing the access token once on 401. A full catalog
 * pull can outlast a single access-token TTL, so we re-mint rather than fail.
 */
type TokenState = { provider: KilterTokenProvider; token: string };
async function withToken<T>(state: TokenState, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(state.token);
  } catch (error) {
    if (error instanceof KilterApiError && error.code === 'unauthorized') {
      state.token = await state.provider();
      return await call(state.token);
    }
    throw error;
  }
}

/** hole_id → placement_id for one board layout (the Grips→Aurora hold bridge). */
async function loadHoleToPlacement(db: DrizzleDb, layoutId: number): Promise<Map<number, number>> {
  const rows = await db
    .select({ holeId: boardPlacements.holeId, id: boardPlacements.id })
    .from(boardPlacements)
    .where(and(eq(boardPlacements.boardType, KILTER), eq(boardPlacements.layoutId, layoutId)));
  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.holeId != null) map.set(row.holeId, row.id);
  }
  return map;
}

type GroupResult = {
  climbsSeen: number;
  climbsUnmapped: number;
  canonicalsInserted: number;
  aliasesUpserted: number;
  statsUpserted: number;
  newCanonicals: NewClimbInfo[];
};

// Mutable per-(canonical, angle) stat accumulator. kilterCount is summed across
// every source UUID that resolves to the canonical; the display fields are
// taken only from the canonical climb's own stat row (Kilter wins for
// Kilter-origin canonicals). Re-running recomputes the same sum → idempotent.
type StatAccum = {
  canonicalUuid: string;
  angle: number;
  kilterCount: number;
  displayDifficulty: number | null;
  difficultyAverage: number | null;
  qualityAverage: number | null;
  faUsername: string | null;
  faAt: string | null;
};

/**
 * Sync every Grips layout that maps to one board_layouts.id. Existing climbs
 * for the layout are loaded once (uuid identity + fingerprint maps) so dedup is
 * fully in-memory; new canonicals + their holds + aliases are flushed per Grips
 * layout, then stats for the whole group are accumulated and upserted.
 */
async function syncBoardLayoutGroup(
  db: DrizzleDb,
  state: TokenState,
  boardLayoutId: number,
  gripsLayoutUuids: string[],
  log: (message: string) => void,
): Promise<GroupResult> {
  const result: GroupResult = {
    climbsSeen: 0,
    climbsUnmapped: 0,
    canonicalsInserted: 0,
    aliasesUpserted: 0,
    statsUpserted: 0,
    newCanonicals: [],
  };

  // Existing catalog for this layout: uuid identity + fingerprint → canonical.
  const existingRows = await db
    .select({ uuid: boardClimbs.uuid, fingerprint: boardClimbs.holdFingerprint })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, KILTER), eq(boardClimbs.layoutId, boardLayoutId)));
  const existingByLowerUuid = new Map<string, string>();
  const fingerprintToCanonical = new Map<string, string>();
  for (const row of existingRows) {
    existingByLowerUuid.set(row.uuid.toLowerCase(), row.uuid);
    if (row.fingerprint && !fingerprintToCanonical.has(row.fingerprint)) {
      fingerprintToCanonical.set(row.fingerprint, row.uuid);
    }
  }

  const holeToPlacement = await loadHoleToPlacement(db, boardLayoutId);

  // lower(sourceUuid) → canonicalUuid, for routing stats. Spans the whole group.
  const climbUuidToCanonical = new Map<string, string>();

  for (const gripsLayoutUuid of gripsLayoutUuids) {
    const climbs = await withToken(state, (token) => fetchLayoutClimbs(token, gripsLayoutUuid));

    const newClimbInserts: NewBoardClimb[] = [];
    const newHoldRows: Array<{
      boardType: string;
      climbUuid: string;
      holdId: number;
      frameNumber: number;
      holdState: string;
    }> = [];
    const aliasRows: Array<{ boardType: string; aliasUuid: string; canonicalUuid: string; source: string }> = [];

    for (const climb of climbs) {
      if (!climb.isListed || climb.isDraft || climb.isDeleted) continue;
      result.climbsSeen += 1;

      const frames = gripsClimbConcatToFrames(climb.climbConcat, holeToPlacement);
      if (frames === null) {
        result.climbsUnmapped += 1;
        continue;
      }
      const fingerprint = fingerprintFromHolds(framesToHolds(frames));
      const lowerUuid = climb.climbUuid.toLowerCase();

      // 1. UUID identity — the Grips catalog inherited Aurora's climb UUIDs, so
      //    most incoming climbs already exist as their own canonical.
      const existingUuid = existingByLowerUuid.get(lowerUuid);
      if (existingUuid) {
        climbUuidToCanonical.set(lowerUuid, existingUuid);
        // Make sure later duplicates in this run can collapse onto it.
        if (!fingerprintToCanonical.has(fingerprint)) fingerprintToCanonical.set(fingerprint, existingUuid);
        continue;
      }

      // 2. Fingerprint dedup — a new UUID whose holds match an existing (or
      //    already-seen-this-run) canonical becomes an alias, not a new row.
      const canonicalByFingerprint = fingerprintToCanonical.get(fingerprint);
      if (canonicalByFingerprint) {
        climbUuidToCanonical.set(lowerUuid, canonicalByFingerprint);
        aliasRows.push({
          boardType: KILTER,
          aliasUuid: climb.climbUuid,
          canonicalUuid: canonicalByFingerprint,
          source: KILTER,
        });
        continue;
      }

      // 3. Genuinely new canonical.
      fingerprintToCanonical.set(fingerprint, climb.climbUuid);
      existingByLowerUuid.set(lowerUuid, climb.climbUuid);
      climbUuidToCanonical.set(lowerUuid, climb.climbUuid);
      newClimbInserts.push({
        uuid: climb.climbUuid,
        boardType: KILTER,
        layoutId: boardLayoutId,
        setterId: null,
        setterUsername: climb.username,
        name: climb.name,
        description: climb.description ?? '',
        edgeLeft: climb.edgeLeft,
        edgeRight: climb.edgeRight,
        edgeBottom: climb.edgeBottom,
        edgeTop: climb.edgeTop,
        framesCount: climb.frameCount,
        framesPace: climb.framesPace,
        frames,
        isDraft: climb.isDraft,
        isListed: climb.isListed,
        createdAt: climb.createdAt,
        holdFingerprint: fingerprint,
      });
      for (const hold of framesToHolds(frames)) {
        newHoldRows.push({
          boardType: KILTER,
          climbUuid: climb.climbUuid,
          holdId: hold.holdId,
          frameNumber: hold.frameNumber,
          holdState: hold.holdState,
        });
      }
      aliasRows.push({ boardType: KILTER, aliasUuid: climb.climbUuid, canonicalUuid: climb.climbUuid, source: KILTER });
      result.newCanonicals.push({
        uuid: climb.climbUuid,
        setterUsername: climb.username,
        layoutId: boardLayoutId,
        name: climb.name,
      });
    }

    // Flush this Grips layout. Order matters: climbs before holds (FK) before
    // aliases (canonical FK). Stats are deferred to the group-level pass.
    if (newClimbInserts.length > 0) {
      await processBatches(newClimbInserts, async (chunk) => {
        await db
          .insert(boardClimbs)
          .values(chunk)
          .onConflictDoUpdate({
            target: [boardClimbs.uuid],
            set: {
              holdFingerprint: sql`COALESCE(${boardClimbs.holdFingerprint}, excluded.hold_fingerprint)`,
              frames: sql`COALESCE(${boardClimbs.frames}, excluded.frames)`,
            },
          });
      });
      result.canonicalsInserted += newClimbInserts.length;
    }
    if (newHoldRows.length > 0) {
      await processBatches(newHoldRows, async (chunk) => {
        await db.insert(boardClimbHolds).values(chunk).onConflictDoNothing();
      });
    }
    if (aliasRows.length > 0) {
      await processBatches(aliasRows, async (chunk) => {
        await db
          .insert(boardClimbAliases)
          .values(chunk)
          .onConflictDoUpdate({
            target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
            set: { lastSeenAt: sql`now()`, source: sql`excluded.source` },
          });
      });
      result.aliasesUpserted += aliasRows.length;
    }
    if (newClimbInserts.length > 0) {
      await populateDenormalizedColumns(
        db,
        KILTER,
        newClimbInserts.map((climb) => climb.uuid),
      );
    }
    log(
      `[kilter-catalog] layout ${gripsLayoutUuid}: ${climbs.length} climbs, +${newClimbInserts.length} canonical, +${aliasRows.length} aliases`,
    );
  }

  // Stats for the whole group (after every climb is in climbUuidToCanonical).
  const statsByCanonicalAngle = new Map<string, StatAccum>();
  for (const gripsLayoutUuid of gripsLayoutUuids) {
    const stats = await withToken(state, (token) => fetchLayoutClimbStats(token, gripsLayoutUuid));
    for (const stat of stats) {
      const canonicalUuid = climbUuidToCanonical.get(stat.climbUuid.toLowerCase());
      if (!canonicalUuid) continue; // stat for a filtered/unknown climb
      const key = `${canonicalUuid}|${stat.angle}`;
      let accum = statsByCanonicalAngle.get(key);
      if (!accum) {
        accum = {
          canonicalUuid,
          angle: stat.angle,
          kilterCount: 0,
          displayDifficulty: null,
          difficultyAverage: null,
          qualityAverage: null,
          faUsername: null,
          faAt: null,
        };
        statsByCanonicalAngle.set(key, accum);
      }
      accum.kilterCount += stat.ascentCount;
      // Display fields come from the canonical climb's OWN stat row.
      if (stat.climbUuid.toLowerCase() === canonicalUuid.toLowerCase()) {
        accum.displayDifficulty = stat.currentDifficultyId ?? stat.difficultyAverage;
        accum.difficultyAverage = stat.difficultyAverage;
        accum.qualityAverage = stat.qualityAverage;
        accum.faUsername = stat.faUsername;
        accum.faAt = stat.faAt;
      }
    }
  }

  const statValues = [...statsByCanonicalAngle.values()].map((accum) => ({
    boardType: KILTER,
    climbUuid: accum.canonicalUuid,
    angle: accum.angle,
    displayDifficulty: accum.displayDifficulty,
    difficultyAverage: accum.difficultyAverage,
    qualityAverage: accum.qualityAverage,
    faUsername: accum.faUsername,
    faAt: accum.faAt,
    kilterAscensionistCount: accum.kilterCount,
    ascensionistCount: accum.kilterCount,
  }));
  if (statValues.length > 0) {
    await processBatches(statValues, async (chunk) => {
      await db
        .insert(boardClimbStats)
        .values(chunk)
        .onConflictDoUpdate({
          target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
          set: {
            kilterAscensionistCount: sql`excluded.kilter_ascensionist_count`,
            ascensionistCount: sql`COALESCE(${boardClimbStats.auroraAscensionistCount}, 0) + COALESCE(excluded.kilter_ascensionist_count, 0) + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0)`,
            // Kilter-origin canonicals: clobber with Grips values. Aurora-origin
            // canonicals (no Grips display row): excluded is null → keep existing.
            displayDifficulty: sql`COALESCE(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
            difficultyAverage: sql`COALESCE(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
            qualityAverage: sql`COALESCE(excluded.quality_average, ${boardClimbStats.qualityAverage})`,
            faUsername: sql`COALESCE(excluded.fa_username, ${boardClimbStats.faUsername})`,
            faAt: sql`COALESCE(excluded.fa_at, ${boardClimbStats.faAt})`,
          },
        });
    });
    result.statsUpserted += statValues.length;
  }

  return result;
}

export async function syncKilterCatalog(args: SyncKilterCatalogArgs): Promise<KilterCatalogSummary> {
  const log = args.log ?? (() => {});
  const state: TokenState = { provider: args.tokenProvider, token: await args.tokenProvider() };

  const reference = args.reference ?? (await pullKilterReference({ accessToken: state.token, log }));
  const resolver = await buildLayoutResolver(args.db);

  let listed = reference.productLayouts.filter((layout) => layout.isListed);
  if (args.layoutUuids) {
    const wanted = new Set(args.layoutUuids);
    listed = listed.filter((layout) => wanted.has(layout.productLayoutUuid));
  }

  // Group Grips layouts by the board_layouts.id they resolve to, so we load the
  // existing catalog once per board layout and dedup across size variants.
  const byBoardLayout = new Map<number, string[]>();
  let layoutsUnmapped = 0;
  for (const layout of listed) {
    const layoutId = resolver.resolve(layout.productLayoutUuid, layout.productName);
    if (layoutId === null) {
      layoutsUnmapped += 1;
      continue;
    }
    const group = byBoardLayout.get(layoutId) ?? [];
    group.push(layout.productLayoutUuid);
    byBoardLayout.set(layoutId, group);
  }

  const summary: KilterCatalogSummary = {
    gripsLayoutsProcessed: 0,
    layoutsUnmapped,
    climbsSeen: 0,
    climbsUnmapped: 0,
    canonicalsInserted: 0,
    aliasesUpserted: 0,
    statsUpserted: 0,
    deletions: {
      reported: 0,
      aliasDeletes: 0,
      softDeletes: 0,
      skippedCanonicalWithAliases: 0,
      unknown: 0,
      applied: false,
    },
  };
  const allNewCanonicals: NewClimbInfo[] = [];

  for (const [boardLayoutId, gripsLayoutUuids] of byBoardLayout) {
    const groupResult = await syncBoardLayoutGroup(args.db, state, boardLayoutId, gripsLayoutUuids, log);
    summary.gripsLayoutsProcessed += gripsLayoutUuids.length;
    summary.climbsSeen += groupResult.climbsSeen;
    summary.climbsUnmapped += groupResult.climbsUnmapped;
    summary.canonicalsInserted += groupResult.canonicalsInserted;
    summary.aliasesUpserted += groupResult.aliasesUpserted;
    summary.statsUpserted += groupResult.statsUpserted;
    allNewCanonicals.push(...groupResult.newCanonicals);
  }

  // Persist the layout uuid → layout_id mappings discovered this run.
  const newAliases = resolver.drainNewAliases();
  if (newAliases.length > 0) {
    await persistLayoutAliases(args.db, newAliases);
  }
  const unmapped = resolver.unmapped();
  if (unmapped.length > 0) {
    log(
      `[kilter-catalog] ${unmapped.length} unmapped layout(s): ${unmapped.map((entry) => `${entry.productLayoutUuid}(${entry.productName})`).join(', ')}`,
    );
  }

  if (allNewCanonicals.length > 0) {
    try {
      await createSetterSyncNotifications(args.db, allNewCanonicals, log);
    } catch (error) {
      log(`[kilter-catalog] setter notifications failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Deletion reconciliation runs last (report-only unless applyDeletions).
  try {
    const deletedUuids = await withToken(state, (token) => fetchDeletedClimbUuids(token));
    summary.deletions = await reconcileDeletions(args.db, deletedUuids, args.applyDeletions ?? false, log);
  } catch (error) {
    log(`[kilter-catalog] deletion reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  log(`[kilter-catalog] done: ${JSON.stringify(summary)}`);
  return summary;
}

async function persistLayoutAliases(
  db: DrizzleDb,
  aliases: Array<{ boardType: string; layoutUuid: string; layoutId: number; source: string }>,
): Promise<void> {
  await db
    .insert(boardLayoutAliases)
    .values(aliases)
    .onConflictDoUpdate({
      target: [boardLayoutAliases.boardType, boardLayoutAliases.layoutUuid],
      set: { layoutId: sql`excluded.layout_id`, source: sql`excluded.source`, lastSeenAt: sql`now()` },
    });
}
