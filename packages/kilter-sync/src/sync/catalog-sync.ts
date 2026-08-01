import { and, eq, gt, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
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
import { populateDenormalizedColumns, blendedQualityAverageSql } from '@boardsesh/db/queries';
import { isNoMatchClimb, CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';

import type { KilterTokenProvider } from '../api/token-provider';
import {
  fetchLayoutClimbs,
  fetchLayoutClimbStats,
  fetchDeletedClimbUuids,
  type KilterCatalogStat,
} from '../api/kilter-rest';
import { KilterApiError } from '../api/errors';
import { pullKilterReference, type KilterReferencePull } from './reference-pull';
import { correctGripsQualityAverage } from './quality-scale';
import { buildLayoutResolver } from './layout-resolver';
import { sanitizeFirstAscent } from '@boardsesh/sync-runtime';
import { decodeGripsClimbConcat } from './catalog-parse';
import {
  buildSkipRow,
  describeSkip,
  loadOpenSkips,
  markSkipsResolved,
  persistSkips,
  summarizeSkipReasons,
  type ClimbIngestSkip,
} from './catalog-backlog';
import {
  decideCatalogFingerprint,
  enrichFingerprintOwnersWithLegacyCompatibility,
  indexStoredFingerprintOwners,
  partitionLegacyFingerprintCompatibilityRows,
  type LegacyFingerprintCompatibilityRow,
} from './catalog-fingerprint-compat';
import { createSetterSyncNotifications, type NewClimbInfo } from './notifications';
import { reconcileDeletions, type DeletionReport } from './deletions';
import { syncKilterLocations } from './locations-sync';
import type { LocationSyncSummary } from '@boardsesh/location-sync';

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
   * Only ever touches Kilter-synced climbs (never user-authored). See deletions.ts.
   */
  applyDeletions?: boolean;
  /** Max deletion changes to apply per run; the backlog drains over cycles. */
  deleteBatchLimit?: number;
  /**
   * Skip setter-follow notifications for newly-inserted canonicals. Use for the
   * first bulk ingest — it backfills tens of thousands of *historical* climbs,
   * and firing "your followed setter posted a new climb" for all of them would
   * spam followers. Leave false for steady-state runs, where a new canonical is
   * a genuinely new climb worth notifying about.
   */
  suppressNotifications?: boolean;
};

export type KilterCatalogSummary = {
  gripsLayoutsProcessed: number;
  layoutsUnmapped: number;
  climbsSeen: number;
  climbsUnmapped: number;
  canonicalsInserted: number;
  aliasesUpserted: number;
  statsUpserted: number;
  selfAliasesBackfilled: number;
  canonicalsRelisted: number;
  /** Skipped climbs written to board_climb_ingest_skips this run. */
  skipsRecorded: number;
  /** Previously-skipped climbs this run managed to ingest. */
  skipsResolved: number;
  /**
   * The skip backlog write failed. Surfaced on the summary (not just the log)
   * because a persistent failure here means climbs are being dropped silently
   * again — the exact condition board_climb_ingest_skips exists to prevent.
   */
  skipsWriteFailed: boolean;
  locations: LocationSyncSummary | null;
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

/**
 * Existing rows must reach the first-fingerprint-owner index in stable order.
 * Duplicate stored fingerprints are legal, so UUID order is the tie-breaker
 * shared with the compatibility preload below.
 */
export function existingCatalogLayoutRowsQuery(db: DrizzleDb, boardLayoutId: number) {
  return db
    .select({
      uuid: boardClimbs.uuid,
      fingerprint: boardClimbs.holdFingerprint,
      isListed: boardClimbs.isListed,
      userId: boardClimbs.userId,
    })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, KILTER), eq(boardClimbs.layoutId, boardLayoutId)))
    .orderBy(boardClimbs.uuid);
}

/**
 * Load every catalog-owned multi-frame row that could still carry the legacy
 * raw-event fingerprint. One catalog-wide query keeps this compatibility
 * bridge out of the per-layout hot loop; rows are partitioned in memory.
 */
async function loadLegacyFingerprintCompatibilityRows(
  db: DrizzleDb,
): Promise<Map<number, LegacyFingerprintCompatibilityRow[]>> {
  const rows = await db
    .select({
      layoutId: boardClimbs.layoutId,
      uuid: boardClimbs.uuid,
      frames: boardClimbs.frames,
      fingerprint: boardClimbs.holdFingerprint,
    })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.boardType, KILTER),
        isNull(boardClimbs.userId),
        gt(boardClimbs.framesCount, 1),
        isNotNull(boardClimbs.frames),
        ne(boardClimbs.frames, ''),
        isNotNull(boardClimbs.holdFingerprint),
      ),
    )
    .orderBy(boardClimbs.layoutId, boardClimbs.uuid);

  return partitionLegacyFingerprintCompatibilityRows(
    rows.flatMap((row) =>
      row.frames && row.fingerprint
        ? [{ layoutId: row.layoutId, uuid: row.uuid, frames: row.frames, fingerprint: row.fingerprint }]
        : [],
    ),
  );
}

type GroupResult = {
  climbsSeen: number;
  climbsUnmapped: number;
  canonicalsInserted: number;
  aliasesUpserted: number;
  statsUpserted: number;
  /** Self-aliases inserted this run for existing canonicals that lacked one. */
  selfAliasesBackfilled: number;
  /** Unlisted synced canonicals re-listed because a listed Grips climb folded on. */
  canonicalsRelisted: number;
  newCanonicals: NewClimbInfo[];
  /** Every climb this group couldn't ingest, for board_climb_ingest_skips. */
  skips: ClimbIngestSkip[];
  /** Climbs that were in the backlog and ingested successfully this run. */
  resolvedSkipUuids: string[];
};

/**
 * Decide whether an existing canonical should be re-listed because a currently
 * LISTED Grips climb just folded onto it. Every climb that reaches the fold has
 * already passed the `isListed && !isDraft && !isDeleted` gate upstream, so the
 * incoming alias demonstrably exists on the wall again. If the canonical is a
 * synced (non-user) row we'd previously unlisted, re-list it so it stops being
 * invisible in search. User-authored canonicals are never touched, and a
 * canonical created earlier this run (no meta entry → `undefined`) is already
 * listed. Pure + exported for unit testing.
 */
export function shouldRelistFoldedCanonical(
  canonicalMeta: { isListed: boolean | null; userId: string | null } | undefined,
): boolean {
  // Map.get yields `undefined` for a canonical created this run; the userId
  // column is `string | null` (never undefined), so both checks are exact.
  return canonicalMeta !== undefined && canonicalMeta.userId === null && canonicalMeta.isListed !== true;
}

// Cap the uuids named in the log line — the full set is in the skips table, so
// a systemic mapping break can't balloon the log.
const UNMAPPED_SAMPLE_LIMIT = 10;

// A newly-ingested climb only fires "your setter posted a new climb" if it was
// actually created upstream recently. Without this, any ingest that recovers a
// backlog — like the multi-frame decoder landing in #3523, which picks up
// animated climbs first published as far back as 2021 — would spam every
// follower of those setters with years-old climbs presented as new.
const NOTIFY_MAX_CLIMB_AGE_DAYS = 30;

/**
 * Whether a newly-inserted canonical should notify the setter's followers.
 * A climb with no parseable upstream `createdAt` is treated as new, matching
 * the behaviour before this gate existed. Pure + exported for unit testing.
 */
export function shouldNotifyForNewCanonical(createdAt: string | null | undefined, now: Date): boolean {
  if (!createdAt) return true;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return true;
  return now.getTime() - createdMs <= NOTIFY_MAX_CLIMB_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// Mutable per-(canonical, angle) stat accumulator. kilterCount is summed across
// every source UUID that resolves to the canonical; the display fields are
// taken only from the canonical climb's own stat row (Kilter wins for
// Kilter-origin canonicals). Re-running recomputes the same sum → idempotent.
export type StatAccum = {
  canonicalUuid: string;
  angle: number;
  kilterCount: number;
  displayDifficulty: number | null;
  difficultyAverage: number | null;
  qualityAverage: number | null;
  faUsername: string | null;
  faAt: string | null;
  // True once the canonical climb's OWN Grips stat row has set the display
  // fields. Until then a fingerprint-merged duplicate's row may fill them, so a
  // climb folded onto an aurora-origin canonical still contributes a grade.
  hasOwnRowStats: boolean;
};

export function catalogStatSourceKey(stat: KilterCatalogStat): string {
  return `${stat.climbUuid.toLowerCase()}|${stat.angle}`;
}

/**
 * Fold one Grips (climb, angle) stat row into the per-(canonical, angle)
 * accumulator. `kilterCount` sums ascents across every source UUID that
 * resolves to the canonical. Display fields (grade/quality/FA) prefer the
 * canonical's OWN Grips row (authoritative — overwrites); when the canonical
 * has no own row (a purely aurora-origin canonical that a Grips climb merged
 * onto by fingerprint) a merged duplicate fills the still-null fields so the
 * climb still shows a grade instead of NULL. Re-running over the same stats
 * recomputes the same totals → idempotent. Exported for unit testing.
 */
export function foldCatalogStat(
  accumByKey: Map<string, StatAccum>,
  stat: KilterCatalogStat,
  canonicalUuid: string,
): void {
  const key = `${canonicalUuid}|${stat.angle}`;
  let accum = accumByKey.get(key);
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
      hasOwnRowStats: false,
    };
    accumByKey.set(key, accum);
  }
  accum.kilterCount += stat.ascentCount;
  // Kilter Grips' qualityAverage is ALREADY on the 1-5 scale (Kilter migrated
  // its legacy 1-3 ratings to 1-5 itself), so we store it verbatim —
  // correctGripsQualityAverage only guards against non-ratings (≤0 / >5 → null).
  // Do NOT rescale it: an earlier 2q−1 "correction" double-converted every
  // climb rated ≥3 up to 5 stars (see quality-scale.ts).
  const incomingQuality = correctGripsQualityAverage(stat.qualityAverage);
  // Difficulty ingest guard: id 1 doesn't exist and 0 is a "no data" sentinel
  // (valid grade ids are ~10-33), so treat anything ≤ 1 as "no grade" → null.
  const incomingDisplayDifficulty = guardDifficulty(stat.currentDifficultyId ?? stat.difficultyAverage);
  const incomingDifficultyAverage = guardDifficulty(stat.difficultyAverage);
  // Guard against impossible upstream fa_at values (future/pre-2016 dates)
  // before they reach either branch below — see sanitizeFirstAscent for why
  // nulling (not clamping) is correct here.
  const { faUsername: sanitizedFaUsername, faAt: sanitizedFaAt } = sanitizeFirstAscent({
    faUsername: stat.faUsername,
    faAt: stat.faAt,
  });
  const isCanonicalOwnRow = stat.climbUuid.toLowerCase() === canonicalUuid.toLowerCase();
  if (isCanonicalOwnRow) {
    // The canonical's own Grips row is authoritative — overwrite.
    accum.displayDifficulty = incomingDisplayDifficulty;
    accum.difficultyAverage = incomingDifficultyAverage;
    accum.qualityAverage = incomingQuality;
    accum.faUsername = sanitizedFaUsername;
    accum.faAt = sanitizedFaAt;
    accum.hasOwnRowStats = true;
  } else if (!accum.hasOwnRowStats) {
    // Fingerprint-merged duplicate: fill only the fields the canonical hasn't
    // supplied yet, so a climb folded onto an aurora-origin canonical (no own
    // Grips row) still contributes a grade/quality instead of NULL.
    if (accum.displayDifficulty == null) accum.displayDifficulty = incomingDisplayDifficulty;
    if (accum.difficultyAverage == null) accum.difficultyAverage = incomingDifficultyAverage;
    if (accum.qualityAverage == null) accum.qualityAverage = incomingQuality;
    if (accum.faUsername == null) accum.faUsername = sanitizedFaUsername;
    if (accum.faAt == null) accum.faAt = sanitizedFaAt;
  }
}

/**
 * Ingest guard for a Grips difficulty id/average: valid grade ids are ~10-33,
 * so treat a missing value or a ≤ 1 placeholder (id 1 doesn't exist; 0 is
 * `Number(null)`) as "no grade" → null.
 */
function guardDifficulty(difficulty: number | null | undefined): number | null {
  return difficulty != null && difficulty > 1 ? difficulty : null;
}

/**
 * Whether a per-(canonical, angle) accumulator carries no real information at
 * all: zero ascents and nothing (grade, quality, first-ascent) to display.
 * Grips reports a stat row for every angle a layout supports, including ones
 * nobody has actually climbed — those rows are already guarded to NULL
 * displayDifficulty/qualityAverage (see guardDifficulty / correctGripsQualityAverage),
 * but without this check they'd still produce an all-null board_climb_stats
 * INSERT: a phantom row for a (climb, angle) pair nobody has climbed (issue
 * #3522). A row with a real grade but 0 ascents (freshly set, unclimbed) or
 * real ascents but no grade yet is NOT empty and must still be written — only
 * skip the case where every field is genuinely absent. Pure + exported for
 * unit testing.
 */
export function shouldSkipEmptyCatalogStat(accum: StatAccum): boolean {
  return (
    accum.kilterCount === 0 &&
    accum.displayDifficulty == null &&
    accum.difficultyAverage == null &&
    accum.qualityAverage == null &&
    accum.faUsername == null &&
    accum.faAt == null
  );
}

export function foldCatalogStatOnce(
  accumByKey: Map<string, StatAccum>,
  seenSourceStats: Set<string>,
  stat: KilterCatalogStat,
  canonicalUuid: string,
): boolean {
  const sourceKey = catalogStatSourceKey(stat);
  if (seenSourceStats.has(sourceKey)) {
    return false;
  }
  seenSourceStats.add(sourceKey);
  foldCatalogStat(accumByKey, stat, canonicalUuid);
  return true;
}

// Derived from the schema (not hand-written) so a column added to or widened on
// board_climb_holds / board_climb_aliases is a compile error at this API
// boundary instead of silent drift — matching how NewBoardClimb is imported.
export type NewHoldRow = typeof boardClimbHolds.$inferInsert;
export type NewAliasRow = typeof boardClimbAliases.$inferInsert;

/**
 * Flush one Grips layout's new-canonical batch (climbs + holds + aliases +
 * denormalized columns) as a single atomic unit.
 *
 * Prior to #3538 these four steps ran as separate autocommit statement
 * groups. A process kill between the climbs insert and any later step left
 * `board_climbs` rows committed (is_listed=true, hold_fingerprint set) with
 * no `board_climb_holds` rows and NULL `required_set_ids`/`compatible_size_ids`.
 * Worse, the next cycle's UUID-identity short-circuit in `syncBoardLayoutGroup`
 * matches these stranded rows by uuid and skips all hold/fingerprint
 * re-derivation forever — there is no self-heal path, so the gap is permanent
 * per affected climb. Wrapping the whole flush in one `db.transaction` makes
 * it all-or-nothing: either every row for this batch lands, or none does and
 * the climb is re-attempted (and re-derived from scratch) on the next cycle.
 *
 * Mirrors the pattern already used by aurora-sync's shared-sync.ts (`db.transaction`
 * passing `tx` into every per-table upsert helper, no cast needed).
 *
 * Scope trade-off: the transaction spans a whole Grips layout, not a
 * `processBatches` chunk (`BATCH` caps each statement, not the transaction). In
 * steady state `newClimbInserts` is ~0 so this costs nothing. On a first bulk
 * ingest or a large decoder-backlog recovery it can hold tens of thousands of
 * `board_climbs` rows (and ~10x that in holds) plus the three
 * `populateDenormalizedColumns` UPDATEs open in one transaction: a bigger
 * snapshot, and a failure near the end retries the whole layout next cycle
 * instead of keeping partial progress. That is the deliberate price of the
 * all-or-nothing guarantee — a partially-flushed layout is unrecoverable
 * (see the UUID short-circuit above), a retried one is not.
 */
export async function flushKilterLayoutBatch(
  db: DrizzleDb,
  newClimbInserts: NewBoardClimb[],
  newHoldRows: NewHoldRow[],
  aliasRows: NewAliasRow[],
): Promise<void> {
  if (newClimbInserts.length === 0 && newHoldRows.length === 0 && aliasRows.length === 0) return;

  await db.transaction(async (tx) => {
    if (newClimbInserts.length > 0) {
      await processBatches(newClimbInserts, async (chunk) => {
        await tx
          .insert(boardClimbs)
          .values(chunk)
          .onConflictDoUpdate({
            target: [boardClimbs.uuid],
            // Never overwrite a user-authored climb on a UUID collision — the
            // catalog sync only owns Kilter-synced rows (user_id IS NULL).
            setWhere: isNull(boardClimbs.userId),
            set: {
              holdFingerprint: sql`COALESCE(${boardClimbs.holdFingerprint}, excluded.hold_fingerprint)`,
              frames: sql`COALESCE(${boardClimbs.frames}, excluded.frames)`,
              // Track the latest derived no_match on a re-sync that reaches this
              // branch (the dedup path normally skips existing UUIDs). Overwrite
              // (not COALESCE) so a "No match" prefix removed upstream actually
              // clears the token — matching aurora-sync's excluded.characteristics.
              //
              // ASSUMPTION: Kilter/Tension characteristics currently only carry
              // `no_match`; method tags are MoonBoard-only. A blind overwrite is
              // therefore safe — the incoming value is either ['no_match'] or null,
              // and we want null to clear a stale token. If Kilter ever gains its
              // own characteristic tokens (e.g. board-specific flags), switch this
              // to a merge expression (e.g. array_cat + dedup) so that tokens not
              // managed by this sync path aren't silently dropped.
              characteristics: sql`excluded.characteristics`,
            },
          });
      });
    }
    if (newHoldRows.length > 0) {
      await processBatches(newHoldRows, async (chunk) => {
        await tx.insert(boardClimbHolds).values(chunk).onConflictDoNothing();
      });
    }
    if (aliasRows.length > 0) {
      await processBatches(aliasRows, async (chunk) => {
        await tx
          .insert(boardClimbAliases)
          .values(chunk)
          .onConflictDoUpdate({
            target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
            set: { lastSeenAt: sql`now()`, source: sql`excluded.source` },
          });
      });
    }
    if (newClimbInserts.length > 0) {
      await populateDenormalizedColumns(
        tx,
        KILTER,
        newClimbInserts.map((climb) => climb.uuid),
      );
    }
  });
}

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
  openSkips: Map<string, string>,
  legacyFingerprintCompatibilityRows: ReadonlyArray<LegacyFingerprintCompatibilityRow>,
  log: (message: string) => void,
): Promise<GroupResult> {
  const result: GroupResult = {
    climbsSeen: 0,
    climbsUnmapped: 0,
    canonicalsInserted: 0,
    aliasesUpserted: 0,
    statsUpserted: 0,
    selfAliasesBackfilled: 0,
    canonicalsRelisted: 0,
    newCanonicals: [],
    skips: [],
    resolvedSkipUuids: [],
  };
  // Stamped once per group so every climb in it is aged against the same clock.
  const groupStartedAt = new Date();

  // Existing catalog for this layout: uuid identity + fingerprint → canonical,
  // carrying listing/ownership so the fold path can re-list a synced canonical
  // an incoming listed alias proves is back on the wall (never a user climb).
  const existingRows = await existingCatalogLayoutRowsQuery(db, boardLayoutId);
  const existingByLowerUuid = new Map<string, string>();
  const storedFingerprintToCanonical = indexStoredFingerprintOwners(existingRows);
  // canonicalUuid → {isListed, userId} for DB-resident canonicals only. New
  // canonicals created this run are absent (already listed → never re-listed).
  const existingCanonicalMeta = new Map<string, { isListed: boolean | null; userId: string | null }>();
  for (const row of existingRows) {
    existingByLowerUuid.set(row.uuid.toLowerCase(), row.uuid);
    existingCanonicalMeta.set(row.uuid, { isListed: row.isListed, userId: row.userId });
  }
  const fingerprintToCanonical = enrichFingerprintOwnersWithLegacyCompatibility(
    storedFingerprintToCanonical,
    legacyFingerprintCompatibilityRows,
  );

  // Existing self-aliases (alias_uuid = canonical_uuid) for this layout, so the
  // identity path only writes the ones actually missing (~6k historical gap;
  // steady-state 0) instead of re-upserting a self-alias for every known climb.
  // Plain equality (not lower() = lower()): every self-alias writer — the
  // identity/new-canonical paths here and the 0159 backfill — assigns the SAME
  // string to both columns, so a self-alias can never differ by case only.
  // Prod-verified 2026-07-08: 0 rows where lower(alias)=lower(canonical) but
  // alias<>canonical, across 242k mixed-case kilter alias rows.
  const existingSelfAliasRows = await db
    .select({ aliasUuid: boardClimbAliases.aliasUuid })
    .from(boardClimbAliases)
    .innerJoin(
      boardClimbs,
      and(eq(boardClimbs.uuid, boardClimbAliases.canonicalUuid), eq(boardClimbs.boardType, KILTER)),
    )
    .where(
      and(
        eq(boardClimbAliases.boardType, KILTER),
        eq(boardClimbs.layoutId, boardLayoutId),
        eq(boardClimbAliases.aliasUuid, boardClimbAliases.canonicalUuid),
      ),
    );
  const existingSelfAliasLower = new Set<string>();
  for (const row of existingSelfAliasRows) existingSelfAliasLower.add(row.aliasUuid.toLowerCase());

  // Canonicals to re-list this group (a listed Grips climb folded onto a synced
  // unlisted canonical). Deduped across the group's Grips layouts.
  const canonicalsToRelist = new Set<string>();

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
      const lowerUuid = climb.climbUuid.toLowerCase();

      // 1. UUID identity — the Grips catalog inherited Aurora's climb UUIDs, so
      //    most incoming climbs already exist as their own canonical. Match on
      //    UUID *before* parsing climb_concat: existing climbs keep their
      //    backfilled holds + fingerprint (no need to re-derive), it skips
      //    parsing for the ~80% UUID-matched majority. The fingerprint dedup
      //    map is pre-seeded from the DB load below, so nothing is lost by not
      //    re-fingerprinting existing rows here.
      const existingUuid = existingByLowerUuid.get(lowerUuid);
      if (existingUuid) {
        climbUuidToCanonical.set(lowerUuid, existingUuid);
        const resolvedByIdentity = openSkips.get(lowerUuid);
        if (resolvedByIdentity) result.resolvedSkipUuids.push(resolvedByIdentity);
        // Self-heal the self-alias gap (~6k kilter climbs reached the catalog
        // via a path that never wrote one, leaving them invisible to deletion
        // reconciliation). Only write the missing ones so steady-state runs add
        // zero alias churn. Idempotent — the ON CONFLICT below refreshes seen.
        if (!existingSelfAliasLower.has(lowerUuid)) {
          existingSelfAliasLower.add(lowerUuid);
          aliasRows.push({ boardType: KILTER, aliasUuid: existingUuid, canonicalUuid: existingUuid, source: KILTER });
          result.selfAliasesBackfilled += 1;
        }
        continue;
      }

      // New UUID — decode holds to fingerprint (and, if canonical, to insert).
      // Handles both the single-frame form and the animated s{start}/e{end}
      // form; anything else lands in the skips backlog with its raw payload
      // rather than disappearing (issue #3523).
      const decoded = decodeGripsClimbConcat(climb.climbConcat, holeToPlacement, climb.frameCount);
      if (!decoded.ok) {
        result.climbsUnmapped += 1;
        result.skips.push(
          buildSkipRow(climb, decoded, {
            boardType: KILTER,
            layoutId: boardLayoutId,
            sourceLayoutUuid: gripsLayoutUuid,
          }),
        );
        continue;
      }
      const { frames, holds } = decoded;
      const fingerprintDecision = decideCatalogFingerprint(fingerprintToCanonical, climb.climbUuid, holds);
      const { fingerprint } = fingerprintDecision;
      const resolvedByDecode = openSkips.get(lowerUuid);
      if (resolvedByDecode) result.resolvedSkipUuids.push(resolvedByDecode);

      // 2. Fingerprint dedup — a new UUID whose holds match an existing (or
      //    already-seen-this-run) canonical becomes an alias, not a new row.
      if (fingerprintDecision.canonicalToInsert === null) {
        const canonicalByFingerprint = fingerprintDecision.canonicalUuid;
        climbUuidToCanonical.set(lowerUuid, canonicalByFingerprint);
        aliasRows.push({
          boardType: KILTER,
          aliasUuid: climb.climbUuid,
          canonicalUuid: canonicalByFingerprint,
          source: KILTER,
        });
        // A listed Grips climb folded onto this canonical → if it's a synced
        // canonical we'd previously unlisted, re-list it (it exists again).
        if (shouldRelistFoldedCanonical(existingCanonicalMeta.get(canonicalByFingerprint))) {
          canonicalsToRelist.add(canonicalByFingerprint);
        }
        continue;
      }

      // 3. Genuinely new canonical.
      fingerprintToCanonical.set(fingerprint, fingerprintDecision.canonicalToInsert);
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
        // Derive the structured no_match characteristic from the Aurora "No match"
        // description convention (carried through the Kilter Grips catalog too).
        characteristics: isNoMatchClimb(climb.description) ? [CLIMB_CHARACTERISTICS.NO_MATCH] : null,
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
      for (const hold of fingerprintDecision.holdRowsToInsert) {
        newHoldRows.push({
          boardType: KILTER,
          climbUuid: climb.climbUuid,
          holdId: hold.holdId,
          frameNumber: hold.frameNumber,
          holdState: hold.holdState,
        });
      }
      aliasRows.push({ boardType: KILTER, aliasUuid: climb.climbUuid, canonicalUuid: climb.climbUuid, source: KILTER });
      // Only genuinely-new upstream climbs notify followers — an ingest that
      // recovers a backlog of older climbs must not present them as new.
      if (shouldNotifyForNewCanonical(climb.createdAt, groupStartedAt)) {
        result.newCanonicals.push({
          uuid: climb.climbUuid,
          setterUsername: climb.username,
          layoutId: boardLayoutId,
          name: climb.name,
        });
      }
    }

    // Flush this Grips layout. Order matters: climbs before holds (FK) before
    // aliases (canonical FK). Stats are deferred to the group-level pass.
    // The whole flush runs in one transaction — a crash/kill between steps
    // must never leave a canonical committed without its holds/aliases/denorm
    // columns (see #3538: a stranded climb matches on UUID identity on every
    // later run and never gets its holds re-derived).
    await flushKilterLayoutBatch(db, newClimbInserts, newHoldRows, aliasRows);
    result.canonicalsInserted += newClimbInserts.length;
    result.aliasesUpserted += aliasRows.length;
    log(
      `[kilter-catalog] layout ${gripsLayoutUuid}: ${climbs.length} climbs, +${newClimbInserts.length} canonical, +${aliasRows.length} aliases`,
    );
  }

  // Re-list synced canonicals a listed Grips climb folded back onto. The
  // isNull(userId) + is_listed guards belt-and-suspenders the classifier above,
  // so a user-authored or already-listed row is never touched.
  //
  // Ordering vs deletions: reconcileDeletions runs LAST in syncKilterCatalog
  // (after every layout group), so it is the authority within a cycle. This
  // re-list can only fire when a *live-listed* alias (from the current catalog
  // pull) folds onto the canonical, which necessarily gives that canonical ≥2
  // aliases (its self-alias + the folded one). So even if the same cycle's
  // /delteduuids also names this canonical, the deletion pass classifies it as
  // skippedCanonicalWithAliases (it still backs a live alias) and does NOT
  // re-unlist it — correct, because a live alias proves the wall position exists.
  // A genuinely-dead canonical (no live folded alias) is never reached here, so
  // the fold cannot resurrect a truly-deleted climb.
  if (canonicalsToRelist.size > 0) {
    const relistUuids = [...canonicalsToRelist];
    await processBatches(relistUuids, async (chunk) => {
      await db
        .update(boardClimbs)
        .set({ isListed: true })
        .where(
          and(
            eq(boardClimbs.boardType, KILTER),
            isNull(boardClimbs.userId),
            // IS NOT TRUE, not `= false`: is_listed is nullable and search filters
            // on `is_listed = true`, so a NULL row is just as invisible as a false
            // one. shouldRelistFoldedCanonical classifies NULL as re-listable; a
            // strict `= false` here would silently skip those rows.
            sql`${boardClimbs.isListed} IS NOT TRUE`,
            inArray(boardClimbs.uuid, chunk),
          ),
        );
    });
    result.canonicalsRelisted += relistUuids.length;
    log(`[kilter-catalog] layout group ${boardLayoutId}: re-listed ${relistUuids.length} folded canonical(s)`);
  }

  // Stats for the whole group (after every climb is in climbUuidToCanonical).
  const statsByCanonicalAngle = new Map<string, StatAccum>();
  const seenSourceStats = new Set<string>();
  for (const gripsLayoutUuid of gripsLayoutUuids) {
    const stats = await withToken(state, (token) => fetchLayoutClimbStats(token, gripsLayoutUuid));
    for (const stat of stats) {
      const canonicalUuid = climbUuidToCanonical.get(stat.climbUuid.toLowerCase());
      if (!canonicalUuid) continue; // stat for a filtered/unknown climb
      foldCatalogStatOnce(statsByCanonicalAngle, seenSourceStats, stat, canonicalUuid);
    }
  }

  const statValues = [...statsByCanonicalAngle.values()]
    .filter((accum) => !shouldSkipEmptyCatalogStat(accum))
    .map((accum) => ({
      boardType: KILTER,
      climbUuid: accum.canonicalUuid,
      angle: accum.angle,
      displayDifficulty: accum.displayDifficulty,
      difficultyAverage: accum.difficultyAverage,
      qualityAverage: accum.qualityAverage,
      // The manufacturer average also seeds upstream_quality_average (the blend's
      // upstream term). On a fresh INSERT quality_average == this value because no
      // Boardsesh votes exist yet; on conflict quality_average is re-blended below.
      upstreamQualityAverage: accum.qualityAverage,
      // qualityAverage is Grips' own 1-5 value, stored verbatim in the fold above
      // (correctGripsQualityAverage only drops non-ratings).
      qualityNormalized: true,
      faUsername: accum.faUsername,
      faAt: accum.faAt,
      upstreamAscensionistCount: accum.kilterCount,
      ascensionistCount: accum.kilterCount,
      // Record that a Kilter Grips catalog sync last touched this row.
      upstreamSyncedAt: new Date().toISOString(),
    }));
  if (statValues.length > 0) {
    // The NEW upstream count this upsert resolves to: GREATEST of stored and
    // incoming, so a stale/partial sync can never lower a climb. Defined ONCE and
    // reused for the count SET, the total, AND the blend weight — a Postgres SET
    // reads the OLD value of a bare column, so the blend must weight by this NEW
    // expression. Single source keeps them in lockstep if the count policy changes.
    // Aurora-origin canonicals have no Grips row (excluded.upstream_quality_average
    // is null) → preserve the stored upstream quality; Kilter-origin canonicals
    // clobber with the corrected Grips value.
    const resolvedUpstreamAscensionistCount = sql`GREATEST(COALESCE(${boardClimbStats.upstreamAscensionistCount}, 0), COALESCE(excluded.upstream_ascensionist_count, 0))`;
    const blendedQuality = blendedQualityAverageSql({
      upstreamQualityAverage: sql`COALESCE(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`,
      upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
      boardseshQualitySum: sql`${boardClimbStats.boardseshQualitySum}`,
      boardseshQualityCount: sql`${boardClimbStats.boardseshQualityCount}`,
    });
    await processBatches(statValues, async (chunk) => {
      await db
        .insert(boardClimbStats)
        .values(chunk)
        .onConflictDoUpdate({
          target: [boardClimbStats.boardType, boardClimbStats.climbUuid, boardClimbStats.angle],
          set: {
            // upstream_ is the board's single manufacturer count (Kilter Grips here).
            upstreamAscensionistCount: resolvedUpstreamAscensionistCount,
            // Total = upstream + the independent Boardsesh count.
            ascensionistCount: sql`${resolvedUpstreamAscensionistCount} + COALESCE(${boardClimbStats.boardseshAscensionistCount}, 0)`,
            // Kilter-origin canonicals: clobber with Grips values. Aurora-origin
            // canonicals (no Grips display row): excluded is null → keep existing.
            displayDifficulty: sql`COALESCE(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
            difficultyAverage: sql`COALESCE(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
            upstreamQualityAverage: sql`COALESCE(excluded.upstream_quality_average, ${boardClimbStats.upstreamQualityAverage})`,
            qualityAverage: blendedQuality,
            // Grips quality is natively 1-5, so a written row is always normalized.
            qualityNormalized: sql`true`,
            // fa_* COALESCE deliberately kept as-is (#3536): the
            // sanitizeFirstAscent guard in foldCatalogStat only stops NEW
            // garbage from landing (a nulled incoming value falls through to
            // the stored one), so an already-poisoned stored fa_at survives
            // here until the deferred prod cleanup heals it.
            faUsername: sql`COALESCE(excluded.fa_username, ${boardClimbStats.faUsername})`,
            faAt: sql`COALESCE(excluded.fa_at, ${boardClimbStats.faAt})`,
            upstreamSyncedAt: sql`excluded.upstream_synced_at`,
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
    selfAliasesBackfilled: 0,
    canonicalsRelisted: 0,
    skipsRecorded: 0,
    skipsResolved: 0,
    skipsWriteFailed: false,
    locations: null,
    deletions: {
      reported: 0,
      aliasDeletes: 0,
      softDeletes: 0,
      protectedUserAuthored: 0,
      skippedForeignSource: 0,
      skippedCanonicalWithAliases: 0,
      alreadyUnlisted: 0,
      directUuidSoftDeletes: 0,
      unknown: 0,
      applied: false,
      appliedThisRun: 0,
      remaining: 0,
      refused: false,
    },
  };
  const allNewCanonicals: NewClimbInfo[] = [];
  const allSkips: ClimbIngestSkip[] = [];
  const allResolvedSkipUuids: string[] = [];

  // The climbs already sitting unresolved in the backlog, so a run that finally
  // ingests one can stamp it resolved without scanning every climb it saw.
  const openSkips = await loadOpenSkips(args.db, KILTER);
  const legacyFingerprintCompatibilityRowsByLayout = await loadLegacyFingerprintCompatibilityRows(args.db);

  for (const [boardLayoutId, gripsLayoutUuids] of byBoardLayout) {
    const groupResult = await syncBoardLayoutGroup(
      args.db,
      state,
      boardLayoutId,
      gripsLayoutUuids,
      openSkips,
      legacyFingerprintCompatibilityRowsByLayout.get(boardLayoutId) ?? [],
      log,
    );
    summary.gripsLayoutsProcessed += gripsLayoutUuids.length;
    summary.climbsSeen += groupResult.climbsSeen;
    summary.climbsUnmapped += groupResult.climbsUnmapped;
    summary.canonicalsInserted += groupResult.canonicalsInserted;
    summary.aliasesUpserted += groupResult.aliasesUpserted;
    summary.statsUpserted += groupResult.statsUpserted;
    summary.selfAliasesBackfilled += groupResult.selfAliasesBackfilled;
    summary.canonicalsRelisted += groupResult.canonicalsRelisted;
    allNewCanonicals.push(...groupResult.newCanonicals);
    allSkips.push(...groupResult.skips);
    allResolvedSkipUuids.push(...groupResult.resolvedSkipUuids);
  }

  // Persist the backlog. A skipped climb used to leave nothing behind but a
  // counter, so it could be missing from Boardsesh forever with no record of
  // it; now every skip keeps its verbatim upstream payload for decoding later.
  // A failure here must not fail the catalog run — the climbs are already in.
  try {
    if (allSkips.length > 0) {
      await persistSkips(args.db, allSkips);
      summary.skipsRecorded = allSkips.length;
      const byReason = summarizeSkipReasons(allSkips)
        .map((entry) => `${entry.count} ${entry.reason}`)
        .join(', ');
      const sample = allSkips.slice(0, UNMAPPED_SAMPLE_LIMIT).map(describeSkip).join(', ');
      log(`[kilter-catalog] ${allSkips.length} climb(s) unmapped (${byReason}); sample: ${sample}`);
    }
    if (allResolvedSkipUuids.length > 0) {
      await markSkipsResolved(args.db, KILTER, allResolvedSkipUuids);
      summary.skipsResolved = allResolvedSkipUuids.length;
      log(`[kilter-catalog] recovered ${allResolvedSkipUuids.length} previously-unmapped climb(s)`);
    }
  } catch (error) {
    summary.skipsWriteFailed = true;
    log(
      `[kilter-catalog] SKIP BACKLOG WRITE FAILED — ${allSkips.length} unmapped climb(s) went unrecorded: ${error instanceof Error ? error.message : String(error)}`,
    );
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

  try {
    summary.locations = await syncKilterLocations({ db: args.db, reference, resolver, log });
  } catch (error) {
    log(`[kilter-locations] failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (allNewCanonicals.length > 0 && args.suppressNotifications) {
    log(
      `[kilter-catalog] suppressed setter notifications for ${allNewCanonicals.length} new canonical(s) (bulk ingest)`,
    );
  } else if (allNewCanonicals.length > 0) {
    try {
      await createSetterSyncNotifications(args.db, allNewCanonicals, log);
    } catch (error) {
      log(`[kilter-catalog] setter notifications failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Deletion reconciliation runs last (report-only unless applyDeletions).
  try {
    const deletedUuids = await withToken(state, (token) => fetchDeletedClimbUuids(token));
    summary.deletions = await reconcileDeletions(args.db, deletedUuids, args.applyDeletions ?? false, log, {
      batchLimit: args.deleteBatchLimit,
    });
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
