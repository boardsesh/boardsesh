import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  boardClimbs,
  boardClimbHolds,
  boardClimbAliases,
  boardLayoutAliases,
  boardPlacements,
  type NewBoardClimb,
} from '@boardsesh/db/schema';
import { populateDenormalizedColumns, mergeCatalogCharacteristicsSql } from '@boardsesh/db/queries';
import { isNoMatchClimb, CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';

import type { KilterTokenProvider } from '../api/token-provider';
import {
  fetchLayoutClimbs,
  fetchLayoutClimbStats,
  fetchDeletedClimbUuids,
  type KilterCatalogClimb,
  type KilterCatalogStat,
} from '../api/kilter-rest';
import { KilterApiError } from '../api/errors';
import { pullKilterReference, type KilterReferencePull } from './reference-pull';
import { correctGripsQualityAverage } from './quality-scale';
import { buildLayoutResolver } from './layout-resolver';
import { sanitizeFirstAscent } from '@boardsesh/sync-runtime';
import { decodeGripsClimbConcat, findUniqueDecodableLayout, type GripsDecodeResult } from './catalog-parse';
import {
  buildSkipRow,
  describeSkip,
  loadOpenSkips,
  markSkipsResolved,
  persistSkips,
  summarizeSkipReasons,
  type ClimbIngestSkip,
} from './catalog-backlog';
import { fingerprintFromHolds } from './fingerprint';
import { upsertKilterStats, type KilterStatsUpsertRow } from './stats-upsert';
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
  /** Stat rows sent to board_climb_stats. */
  statsUpserted: number;
  /**
   * Of statsUpserted, the rows actually inserted or changed. Unchanged rows are
   * skipped, apart from a daily restamp of rows Boardsesh ascents count on
   * (see stats-upsert.ts), so a pass writes thousands of rows, not ~420k.
   */
  statsWritten: number;
  selfAliasesBackfilled: number;
  canonicalsRelisted: number;
  /**
   * Re-lists the deletion list blocked: Kilter still listed the climb on
   * /climbs/all but also reports it on /delteduuids. Expected to track the
   * cycle's own deletions; a number that stays high means the two endpoints
   * disagree persistently and is worth a look.
   */
  relistsBlockedByDeletionHistory: number;
  /**
   * Climbs Kilter tagged with the wrong layout, ingested onto the layout their
   * holds actually place on instead of sitting in the skip backlog.
   */
  climbsRerouted: number;
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

export type GroupResult = {
  climbsSeen: number;
  climbsUnmapped: number;
  canonicalsInserted: number;
  aliasesUpserted: number;
  statsUpserted: number;
  statsWritten: number;
  /** Self-aliases inserted this run for existing canonicals that lacked one. */
  selfAliasesBackfilled: number;
  /** Unlisted synced canonicals re-listed because Kilter still lists the climb. */
  canonicalsRelisted: number;
  /** Identity-path re-lists the deletion list blocked (see decideIdentityRelist). */
  relistsBlockedByDeletionHistory: number;
  /** Climbs ingested onto a different layout than Kilter tagged them with. */
  climbsRerouted: number;
  newCanonicals: NewClimbInfo[];
  /** Every climb this group couldn't ingest, for board_climb_ingest_skips. */
  skips: ClimbIngestSkip[];
  /** Climbs that were in the backlog and ingested successfully this run. */
  resolvedSkipUuids: string[];
};

export function createGroupResult(): GroupResult {
  return {
    climbsSeen: 0,
    climbsUnmapped: 0,
    canonicalsInserted: 0,
    aliasesUpserted: 0,
    statsUpserted: 0,
    statsWritten: 0,
    selfAliasesBackfilled: 0,
    canonicalsRelisted: 0,
    relistsBlockedByDeletionHistory: 0,
    climbsRerouted: 0,
    newCanonicals: [],
    skips: [],
    resolvedSkipUuids: [],
  };
}

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

export type IdentityRelistDecision = 'relist' | 'not_needed' | 'blocked_deleted_upstream' | 'blocked_no_deletion_list';

/**
 * Lowercased set of the uuids Kilter reports on `/climbs/delteduuids`, or null
 * when the fetch failed or came back empty. Null means "we don't know what
 * Kilter deleted": it disables the identity re-list AND deletion reconciliation
 * for the run rather than letting either act on a list we don't have. Pure +
 * exported for unit testing.
 */
export function buildDeletedLowerUuidSet(deletedUuids: string[] | null | undefined): Set<string> | null {
  if (!deletedUuids || deletedUuids.length === 0) return null;
  return new Set(deletedUuids.map((uuid) => uuid.toLowerCase()));
}

/**
 * Decide whether a climb matched on UUID identity should be re-listed.
 *
 * Kilter listing a climb on `/climbs/all` is normally proof it exists on the
 * wall, so an unlisted synced canonical behind that uuid is a stale unlisting —
 * on prod, ~24 climbs carrying the 2026-07-07 migration baseline as their
 * `updated_at`, invisible in search ever since.
 *
 * The guard is what makes that safe: Kilter also keeps serving climbs from
 * `/climbs/all` that it has just put on `/delteduuids` (124 of them on
 * 2026-09-15, unlisted by the same run's deletion pass). Re-listing those would
 * flip them back on every cycle and churn offline sync's `sync_seq` forever, so
 * they are blocked and counted instead. With no deletion list at all
 * (`deletedLowerUuids === null`) nothing is re-listed — a missing list must not
 * read as "nothing was deleted". Pure + exported for unit testing.
 */
export function decideIdentityRelist(
  canonicalMeta: ExistingClimbMeta | undefined,
  lowerUuid: string,
  deletedLowerUuids: ReadonlySet<string> | null,
): IdentityRelistDecision {
  // A draft is deliberately invisible; the catalog sync doesn't publish it.
  if (canonicalMeta?.isDraft === true) return 'not_needed';
  // Reuses the fold path's classifier: undefined (created this run), a
  // user-authored row, and an already-listed row all need nothing.
  if (!shouldRelistFoldedCanonical(canonicalMeta)) return 'not_needed';
  if (deletedLowerUuids === null) return 'blocked_no_deletion_list';
  if (deletedLowerUuids.has(lowerUuid.toLowerCase())) return 'blocked_deleted_upstream';
  return 'relist';
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
 * One alias chunk as unnest() arrays, so every chunk shares one statement text
 * (and one pg_stat_statements entry) whatever its size. Drizzle's
 * insert().select(sql) inserts into EVERY board_climb_aliases column in table
 * order, so this SELECT lists them all: board_type, alias_uuid, canonical_uuid,
 * source, first_seen_at, last_seen_at.
 */
function aliasUpsertSelect(rows: NewAliasRow[]): SQL {
  return sql`SELECT incoming.board_type, incoming.alias_uuid, incoming.canonical_uuid, incoming.source, now(), now()
    FROM unnest(
      ${sql.param(rows.map((row) => row.boardType))}::text[],
      ${sql.param(rows.map((row) => row.aliasUuid))}::text[],
      ${sql.param(rows.map((row) => row.canonicalUuid))}::text[],
      ${sql.param(rows.map((row) => row.source))}::text[]
    ) AS incoming(board_type, alias_uuid, canonical_uuid, source)`;
}

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
              // Aurora owns no_match; preserve rules authored in Boardsesh.
              characteristics: mergeCatalogCharacteristicsSql(
                boardClimbs.characteristics,
                sql`excluded.characteristics`,
                [CLIMB_CHARACTERISTICS.NO_MATCH],
              ),
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
          .select(aliasUpsertSelect(chunk))
          .onConflictDoUpdate({
            target: [boardClimbAliases.boardType, boardClimbAliases.aliasUuid],
            set: { lastSeenAt: sql`now()`, source: sql`excluded.source` },
            // The fold path stages every known pure alias again on every run.
            // Rewriting one only moved last_seen_at, so skip it unless the
            // source changes (a non-kilter alias is re-claimed as kilter, which
            // is what lets deletion reconciliation remove it) or last_seen_at
            // is a day old. last_seen_at therefore means "confirmed within the
            // last day", not "confirmed this run".
            setWhere: sql`${boardClimbAliases.source} IS DISTINCT FROM excluded.source
              OR ${boardClimbAliases.lastSeenAt} < now() - interval '24 hours'`,
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

/** Listing, ownership and draft state of a climb already in board_climbs. */
export type ExistingClimbMeta = { isListed: boolean | null; userId: string | null; isDraft: boolean | null };

/** One board_climbs row as the layout index loads it. */
export type LayoutCatalogClimbRow = ExistingClimbMeta & { uuid: string; fingerprint: string | null };

/**
 * One board layout's existing catalog, loaded once so dedup runs in memory.
 * Staging mutates the uuid map, the fingerprint map and the self-alias set as it
 * adds canonicals. The meta map only ever holds DB-resident rows, so a canonical
 * created earlier in the same run is absent from it (already listed).
 */
export type LayoutCatalogIndex = {
  layoutId: number;
  /** lower(uuid) → uuid as stored. */
  existingByLowerUuid: Map<string, string>;
  /** hold_fingerprint → canonical uuid. The first row seen for a fingerprint wins. */
  fingerprintToCanonical: Map<string, string>;
  /** canonical uuid (as stored) → listing/ownership/draft state. */
  existingCanonicalMeta: Map<string, ExistingClimbMeta>;
  /**
   * lower(uuid) of every canonical that already has its self-alias. Shared by
   * every layout in a run (see loadKilterSelfAliasLower) and grown as staging
   * adds self-aliases, so a later layout or the reroute pass never re-stages one.
   */
  existingSelfAliasLower: Set<string>;
  /** hole_id → placement_id on this layout. */
  holeToPlacement: Map<number, number>;
};

/**
 * Build a layout index from already-loaded rows. Pure + exported so staging can
 * be unit-tested against hand-built catalogs.
 */
export function buildLayoutCatalogIndex(input: {
  layoutId: number;
  climbRows: LayoutCatalogClimbRow[];
  existingSelfAliasLower: Set<string>;
  holeToPlacement: Map<number, number>;
}): LayoutCatalogIndex {
  const existingByLowerUuid = new Map<string, string>();
  const fingerprintToCanonical = new Map<string, string>();
  const existingCanonicalMeta = new Map<string, ExistingClimbMeta>();
  for (const row of input.climbRows) {
    existingByLowerUuid.set(row.uuid.toLowerCase(), row.uuid);
    existingCanonicalMeta.set(row.uuid, { isListed: row.isListed, userId: row.userId, isDraft: row.isDraft });
    if (row.fingerprint && !fingerprintToCanonical.has(row.fingerprint)) {
      fingerprintToCanonical.set(row.fingerprint, row.uuid);
    }
  }
  return {
    layoutId: input.layoutId,
    existingByLowerUuid,
    fingerprintToCanonical,
    existingCanonicalMeta,
    existingSelfAliasLower: input.existingSelfAliasLower,
    holeToPlacement: input.holeToPlacement,
  };
}

/** lower(alias_uuid) of each self-alias row. Exported for unit tests. */
export function buildSelfAliasLowerSet(aliasUuids: Iterable<string>): Set<string> {
  const lowered = new Set<string>();
  for (const aliasUuid of aliasUuids) lowered.add(aliasUuid.toLowerCase());
  return lowered;
}

/**
 * Every Kilter self-alias (alias_uuid = canonical_uuid), loaded ONCE per run and
 * shared by every layout group and the reroute pass. It replaces a per-layout
 * join of the aliases onto board_climbs that probed board_climbs_pkey once per
 * self-alias on every layout (~1.69M buffers per call on the replica, 6.8 s max
 * and 2.44M blocks read a day on prod). A self-alias key is its canonical uuid,
 * which is unique across layouts, so one run-wide set answers "does this
 * canonical have its self-alias" exactly as the per-layout join did.
 *
 * Plain equality (not lower() = lower()): every self-alias writer assigns the
 * SAME string to both columns, so a self-alias never differs by case only.
 *
 * The planner hints matter: 98% of Kilter aliases are self-aliases, but
 * `alias_uuid = canonical_uuid` is estimated at a few thousand rows, and prod
 * picked an index scan on board_climb_aliases_canonical_idx for this exact query
 * (9.4 s against 2.0 s for the seq scan of the 171 MB heap). SET LOCAL needs
 * the transaction.
 */
export async function loadKilterSelfAliasLower(db: DrizzleDb): Promise<Set<string>> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_indexscan = off`);
    await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    return tx
      .select({ aliasUuid: boardClimbAliases.aliasUuid })
      .from(boardClimbAliases)
      .where(
        and(eq(boardClimbAliases.boardType, KILTER), eq(boardClimbAliases.aliasUuid, boardClimbAliases.canonicalUuid)),
      );
  });
  return buildSelfAliasLowerSet(rows.map((row) => row.aliasUuid));
}

/**
 * Load one board layout's existing catalog: uuid identity + fingerprint →
 * canonical, carrying listing/ownership so the fold path can re-list a synced
 * canonical an incoming listed alias proves is back on the wall (never a user
 * climb).
 */
async function loadLayoutCatalogIndex(
  db: DrizzleDb,
  layoutId: number,
  holeToPlacement: Map<number, number>,
  existingSelfAliasLower: Set<string>,
): Promise<LayoutCatalogIndex> {
  const climbRows = await db
    .select({
      uuid: boardClimbs.uuid,
      fingerprint: boardClimbs.holdFingerprint,
      isListed: boardClimbs.isListed,
      userId: boardClimbs.userId,
      isDraft: boardClimbs.isDraft,
    })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, KILTER), eq(boardClimbs.layoutId, layoutId)));

  return buildLayoutCatalogIndex({ layoutId, climbRows, existingSelfAliasLower, holeToPlacement });
}

/** The rows one Grips layout stages before `flushKilterLayoutBatch` writes them. */
export type CatalogStagingBatch = {
  newClimbInserts: NewBoardClimb[];
  newHoldRows: NewHoldRow[];
  aliasRows: NewAliasRow[];
};

export function createStagingBatch(): CatalogStagingBatch {
  return { newClimbInserts: [], newHoldRows: [], aliasRows: [] };
}

export type StageCatalogClimbContext = {
  index: LayoutCatalogIndex;
  /** Grips product_layout_uuid the climb was read from, for skip rows. */
  sourceLayoutUuid: string;
  /** lower(uuid) → uuid as stored, for backlog rows still open. */
  openSkips: Map<string, string>;
  batch: CatalogStagingBatch;
  /** lower(source uuid) → canonical uuid, for routing stats. */
  climbUuidToCanonical: Map<string, string>;
  /** Synced canonicals to re-list once the batch is flushed. */
  canonicalsToRelist: Set<string>;
  /** Lowercased /delteduuids set, or null when this run has no list (blocks re-listing). */
  deletedLowerUuids: ReadonlySet<string> | null;
  /**
   * Lookup for climbs Kilter tagged with the wrong layout, or null to disable
   * rerouting. The reroute pass itself stages with it off, so a climb can never
   * hop from layout to layout.
   */
  reroute: RerouteContext | null;
  result: GroupResult;
  /** Clock the new-canonical notification age check runs against. */
  now: Date;
};

/** A climb whose holes place on exactly one OTHER layout, held for the final reroute pass. */
export type RerouteCandidate = {
  climb: KilterCatalogClimb;
  sourceLayoutId: number;
  sourceLayoutUuid: string;
  targetLayoutId: number;
  /** Fingerprint of the decode against the TARGET layout's placements. */
  fingerprint: string;
  /** How the decode failed on the source layout, for the fallback skip row. */
  sourceFailure: Extract<GripsDecodeResult, { ok: false }>;
  /** Stat rows the source group saw for this climb, replayed onto the target. */
  stats: KilterCatalogStat[];
};

export type RerouteContext = {
  /** layoutId → hole_id → placement_id, for every layout this run's listed set resolves to. */
  holeToPlacementByLayout: ReadonlyMap<number, Map<number, number>>;
  /** lower(uuid) → candidate, deduped across the Grips layouts of a group. */
  candidates: Map<string, RerouteCandidate>;
};

export type StageCatalogClimbOutcome = 'identity' | 'skipped' | 'folded' | 'inserted' | 'reroute_candidate';

/**
 * Stage one listed Grips climb against a layout's catalog: UUID identity, then
 * decode + fingerprint dedup, then a new canonical. Synchronous and DB-free —
 * the caller flushes `context.batch` afterwards. The caller also owns the
 * listed/draft/deleted gate and the `climbsSeen` count. Exported for unit tests.
 */
export function stageCatalogClimb(
  climb: KilterCatalogClimb,
  context: StageCatalogClimbContext,
): StageCatalogClimbOutcome {
  const { index, batch, result, openSkips, climbUuidToCanonical, canonicalsToRelist } = context;
  const lowerUuid = climb.climbUuid.toLowerCase();

  // 1. UUID identity — the Grips catalog inherited Aurora's climb UUIDs, so
  //    most incoming climbs already exist as their own canonical. Match on
  //    UUID *before* parsing climb_concat: existing climbs keep their
  //    backfilled holds + fingerprint (no need to re-derive), it skips
  //    parsing for the ~80% UUID-matched majority. The fingerprint dedup
  //    map is pre-seeded from the DB load, so nothing is lost by not
  //    re-fingerprinting existing rows here.
  const existingUuid = index.existingByLowerUuid.get(lowerUuid);
  if (existingUuid) {
    climbUuidToCanonical.set(lowerUuid, existingUuid);
    const resolvedByIdentity = openSkips.get(lowerUuid);
    if (resolvedByIdentity) result.resolvedSkipUuids.push(resolvedByIdentity);
    // Self-heal the self-alias gap (~6k kilter climbs reached the catalog
    // via a path that never wrote one, leaving them invisible to deletion
    // reconciliation). Only write the missing ones so steady-state runs add
    // zero alias churn. Idempotent — the flush's ON CONFLICT covers a race.
    if (!index.existingSelfAliasLower.has(lowerUuid)) {
      index.existingSelfAliasLower.add(lowerUuid);
      batch.aliasRows.push({ boardType: KILTER, aliasUuid: existingUuid, canonicalUuid: existingUuid, source: KILTER });
      result.selfAliasesBackfilled += 1;
    }
    // Kilter still lists this climb, so an unlisted synced canonical behind the
    // uuid is a stale unlisting worth undoing — unless Kilter also reports the
    // uuid deleted. See decideIdentityRelist for why that guard is load-bearing.
    const relistDecision = decideIdentityRelist(
      index.existingCanonicalMeta.get(existingUuid),
      lowerUuid,
      context.deletedLowerUuids,
    );
    if (relistDecision === 'relist') {
      canonicalsToRelist.add(existingUuid);
    } else if (relistDecision === 'blocked_deleted_upstream') {
      result.relistsBlockedByDeletionHistory += 1;
    }
    return 'identity';
  }

  // New UUID — decode holds to fingerprint (and, if canonical, to insert).
  // Handles both the single-frame form and the animated s{start}/e{end}
  // form; anything else lands in the skips backlog with its raw payload
  // rather than disappearing (issue #3523).
  const decoded = decodeGripsClimbConcat(climb.climbConcat, index.holeToPlacement, climb.frameCount);
  if (!decoded.ok) {
    // Kilter sometimes tags a climb with the wrong product layout, so every
    // hole misses here while placing cleanly on another layout. Hold those
    // aside for the reroute pass rather than writing a skip row they'd never
    // escape (see findUniqueDecodableLayout / ingestRerouteCandidates).
    const alternateLayout =
      context.reroute && decoded.reason === 'unplaceable_hole'
        ? findUniqueDecodableLayout(
            climb.climbConcat,
            climb.frameCount,
            index.layoutId,
            context.reroute.holeToPlacementByLayout,
          )
        : null;
    if (context.reroute && alternateLayout) {
      // Keyed by uuid: several Grips layouts collapse onto one board layout, so
      // the same climb can reach this branch more than once per run.
      if (!context.reroute.candidates.has(lowerUuid)) {
        context.reroute.candidates.set(lowerUuid, {
          climb,
          sourceLayoutId: index.layoutId,
          sourceLayoutUuid: context.sourceLayoutUuid,
          targetLayoutId: alternateLayout.layoutId,
          fingerprint: fingerprintFromHolds(alternateLayout.decoded.holds),
          sourceFailure: decoded,
          stats: [],
        });
      }
      // Deliberately neither a skip row nor climbsUnmapped: the reroute pass
      // writes the original skip row itself if the climb can't be ingested.
      return 'reroute_candidate';
    }
    result.climbsUnmapped += 1;
    result.skips.push(
      buildSkipRow(climb, decoded, {
        boardType: KILTER,
        layoutId: index.layoutId,
        sourceLayoutUuid: context.sourceLayoutUuid,
      }),
    );
    return 'skipped';
  }
  const { frames, holds } = decoded;
  const fingerprint = fingerprintFromHolds(holds);
  const resolvedByDecode = openSkips.get(lowerUuid);
  if (resolvedByDecode) result.resolvedSkipUuids.push(resolvedByDecode);

  // 2. Fingerprint dedup — a new UUID whose holds match an existing (or
  //    already-seen-this-run) canonical becomes an alias, not a new row.
  const canonicalByFingerprint = index.fingerprintToCanonical.get(fingerprint);
  if (canonicalByFingerprint) {
    climbUuidToCanonical.set(lowerUuid, canonicalByFingerprint);
    batch.aliasRows.push({
      boardType: KILTER,
      aliasUuid: climb.climbUuid,
      canonicalUuid: canonicalByFingerprint,
      source: KILTER,
    });
    const canonicalMeta = index.existingCanonicalMeta.get(canonicalByFingerprint);
    const canonicalLowerUuid = canonicalByFingerprint.toLowerCase();
    // Self-heal the canonical's OWN alias row while we're here. ~6k historical
    // canonicals never got one, and without it the canonical is invisible to
    // deletion reconciliation's alias-graph lookup: the folded alias above
    // wouldn't count for it, the direct-uuid fallback would unlist it again in
    // the same cycle, and the fold would re-list it in the next — a permanent
    // flip-flop costing offline clients a sync_seq bump every cycle. With the
    // self-alias present the canonical has ≥2 aliases and reconciliation files
    // it as skippedCanonicalWithAliases instead. `undefined` meta means the
    // canonical was created earlier this run and already staged its own.
    if (canonicalMeta !== undefined && !index.existingSelfAliasLower.has(canonicalLowerUuid)) {
      index.existingSelfAliasLower.add(canonicalLowerUuid);
      batch.aliasRows.push({
        boardType: KILTER,
        aliasUuid: canonicalByFingerprint,
        canonicalUuid: canonicalByFingerprint,
        source: KILTER,
      });
      result.selfAliasesBackfilled += 1;
    }
    // A listed Grips climb folded onto this canonical → if it's a synced
    // canonical we'd previously unlisted, re-list it (it exists again).
    if (shouldRelistFoldedCanonical(canonicalMeta)) {
      canonicalsToRelist.add(canonicalByFingerprint);
    }
    return 'folded';
  }

  // 3. Genuinely new canonical.
  index.fingerprintToCanonical.set(fingerprint, climb.climbUuid);
  index.existingByLowerUuid.set(lowerUuid, climb.climbUuid);
  climbUuidToCanonical.set(lowerUuid, climb.climbUuid);
  batch.newClimbInserts.push({
    uuid: climb.climbUuid,
    boardType: KILTER,
    layoutId: index.layoutId,
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
  for (const hold of holds) {
    batch.newHoldRows.push({
      boardType: KILTER,
      climbUuid: climb.climbUuid,
      holdId: hold.holdId,
      frameNumber: hold.frameNumber,
      holdState: hold.holdState,
    });
  }
  batch.aliasRows.push({
    boardType: KILTER,
    aliasUuid: climb.climbUuid,
    canonicalUuid: climb.climbUuid,
    source: KILTER,
  });
  index.existingSelfAliasLower.add(lowerUuid);
  // Only genuinely-new upstream climbs notify followers — an ingest that
  // recovers a backlog of older climbs must not present them as new.
  if (shouldNotifyForNewCanonical(climb.createdAt, context.now)) {
    result.newCanonicals.push({
      uuid: climb.climbUuid,
      setterUsername: climb.username,
      layoutId: index.layoutId,
      name: climb.name,
    });
  }
  return 'inserted';
}

/**
 * Re-list synced canonicals that the current catalog pull proves are on the
 * wall. The isNull(userId) + is_listed guards belt-and-suspenders the
 * classifier, so a user-authored or already-listed row is never touched.
 * Returns how many canonicals were requested.
 */
async function relistCanonicals(db: DrizzleDb, canonicalUuids: string[]): Promise<number> {
  await processBatches(canonicalUuids, async (chunk) => {
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
  return canonicalUuids.length;
}

/**
 * Sync every Grips layout that maps to one board_layouts.id. Existing climbs
 * for the layout are loaded once (uuid identity + fingerprint maps) so dedup is
 * fully in-memory; new canonicals + their holds + aliases are flushed per Grips
 * layout, then stats for the whole group are accumulated and upserted.
 */
type SyncBoardLayoutGroupArgs = {
  db: DrizzleDb;
  state: TokenState;
  boardLayoutId: number;
  gripsLayoutUuids: string[];
  openSkips: Map<string, string>;
  /** Lowercased /delteduuids set for this run, or null when there is no list. */
  deletedLowerUuids: ReadonlySet<string> | null;
  /** hole_id → placement_id for this board layout, preloaded by the caller. */
  holeToPlacement: Map<number, number>;
  /** The run-wide self-alias set (loadKilterSelfAliasLower). */
  existingSelfAliasLower: Set<string>;
  /** Collects climbs Kilter tagged with the wrong layout, for the final reroute pass. */
  reroute: RerouteContext;
  log: (message: string) => void;
};

async function syncBoardLayoutGroup(args: SyncBoardLayoutGroupArgs): Promise<GroupResult> {
  const {
    db,
    state,
    boardLayoutId,
    gripsLayoutUuids,
    openSkips,
    deletedLowerUuids,
    holeToPlacement,
    existingSelfAliasLower,
    reroute,
    log,
  } = args;
  const result = createGroupResult();
  // Stamped once per group so every climb in it is aged against the same clock.
  const groupStartedAt = new Date();

  const index = await loadLayoutCatalogIndex(db, boardLayoutId, holeToPlacement, existingSelfAliasLower);

  // Canonicals to re-list this group (a listed Grips climb folded onto a synced
  // unlisted canonical). Deduped across the group's Grips layouts.
  const canonicalsToRelist = new Set<string>();

  // lower(sourceUuid) → canonicalUuid, for routing stats. Spans the whole group.
  const climbUuidToCanonical = new Map<string, string>();
  for (const gripsLayoutUuid of gripsLayoutUuids) {
    const climbs = await withToken(state, (token) => fetchLayoutClimbs(token, gripsLayoutUuid));

    const batch = createStagingBatch();
    const context: StageCatalogClimbContext = {
      index,
      sourceLayoutUuid: gripsLayoutUuid,
      openSkips,
      batch,
      climbUuidToCanonical,
      canonicalsToRelist,
      deletedLowerUuids,
      reroute,
      result,
      now: groupStartedAt,
    };
    for (const climb of climbs) {
      if (!climb.isListed || climb.isDraft || climb.isDeleted) continue;
      result.climbsSeen += 1;
      stageCatalogClimb(climb, context);
    }

    // Flush this Grips layout. Order matters: climbs before holds (FK) before
    // aliases (canonical FK). Stats are deferred to the group-level pass.
    // The whole flush runs in one transaction — a crash/kill between steps
    // must never leave a canonical committed without its holds/aliases/denorm
    // columns (see #3538: a stranded climb matches on UUID identity on every
    // later run and never gets its holds re-derived).
    await flushKilterLayoutBatch(db, batch.newClimbInserts, batch.newHoldRows, batch.aliasRows);
    result.canonicalsInserted += batch.newClimbInserts.length;
    result.aliasesUpserted += batch.aliasRows.length;
    log(
      `[kilter-catalog] layout ${gripsLayoutUuid}: ${climbs.length} climbs, +${batch.newClimbInserts.length} canonical, +${batch.aliasRows.length} aliases`,
    );
  }

  // Re-list synced canonicals the current catalog pull proves are on the wall.
  // Two paths feed this set, and they are protected differently:
  //
  // 1. The FOLD path — a live-listed Grips climb fingerprint-matched this
  //    canonical. Ordering vs deletions: reconcileDeletions runs LAST in
  //    syncKilterCatalog (after every layout group), so it is the authority
  //    within a cycle. The fold leaves the canonical with ≥2 aliases: the
  //    folded one, plus its self-alias, which stageCatalogClimb stages into the
  //    same batch when the canonical is one of the ~6k that never got one. So
  //    even if the same cycle's /delteduuids names it, the deletion pass
  //    classifies it as skippedCanonicalWithAliases (it still backs a live
  //    alias) and does NOT re-unlist it — correct, because a live alias proves
  //    the wall position exists. That staged self-alias is what makes the
  //    invariant true: without it the canonical misses the alias-graph lookup
  //    entirely and the direct-uuid fallback re-unlists it every cycle. A
  //    genuinely-dead canonical (no live folded alias) never reaches the fold,
  //    so it cannot resurrect a truly-deleted climb.
  // 2. The IDENTITY path — Kilter listed the same uuid on /climbs/all. That
  //    argument does NOT hold here: the canonical usually has only its own
  //    self-alias, so the deletion pass would re-unlist it in the same cycle
  //    and the two would fight forever. decideIdentityRelist is what keeps them
  //    apart: a uuid on this run's /delteduuids is blocked (and counted in
  //    relistsBlockedByDeletionHistory) instead of re-listed, and with no
  //    deletion list at all nothing is re-listed through this path.
  if (canonicalsToRelist.size > 0) {
    const relistedCount = await relistCanonicals(db, [...canonicalsToRelist]);
    result.canonicalsRelisted += relistedCount;
    log(`[kilter-catalog] layout group ${boardLayoutId}: re-listed ${relistedCount} canonical(s) Kilter still lists`);
  }

  // Stats for the whole group (after every climb is in climbUuidToCanonical).
  const statsByCanonicalAngle = new Map<string, StatAccum>();
  const seenSourceStats = new Set<string>();
  for (const gripsLayoutUuid of gripsLayoutUuids) {
    const stats = await withToken(state, (token) => fetchLayoutClimbStats(token, gripsLayoutUuid));
    for (const stat of stats) {
      const lowerStatUuid = stat.climbUuid.toLowerCase();
      const canonicalUuid = climbUuidToCanonical.get(lowerStatUuid);
      if (!canonicalUuid) {
        // A climb held for the reroute pass has no canonical yet. Its stats are
        // only served from this (wrongly-tagged) layout, so carry them along or
        // they're lost when the climb lands on the layout it belongs to.
        reroute.candidates.get(lowerStatUuid)?.stats.push(stat);
        continue; // otherwise: a stat for a filtered/unknown climb
      }
      foldCatalogStatOnce(statsByCanonicalAngle, seenSourceStats, stat, canonicalUuid);
    }
  }
  const statsOutcome = await upsertCatalogStats(db, statsByCanonicalAngle);
  result.statsUpserted += statsOutcome.sent;
  result.statsWritten += statsOutcome.written;

  return result;
}

/**
 * Write the per-(canonical, angle) accumulators to board_climb_stats. `sent` is
 * how many rows went to the upsert (empty accumulators are skipped); `written`
 * is how many it actually inserted or changed (see upsertKilterStats).
 */
async function upsertCatalogStats(
  db: DrizzleDb,
  statsByCanonicalAngle: Map<string, StatAccum>,
): Promise<{ sent: number; written: number }> {
  const statRows: KilterStatsUpsertRow[] = [...statsByCanonicalAngle.values()]
    .filter((accum) => !shouldSkipEmptyCatalogStat(accum))
    .map((accum) => ({
      climbUuid: accum.canonicalUuid,
      angle: accum.angle,
      displayDifficulty: accum.displayDifficulty,
      difficultyAverage: accum.difficultyAverage,
      // Grips' own 1-5 value, stored verbatim by the fold above
      // (correctGripsQualityAverage only drops non-ratings).
      qualityAverage: accum.qualityAverage,
      faUsername: accum.faUsername,
      faAt: accum.faAt,
      upstreamAscensionistCount: accum.kilterCount,
    }));
  const written = await upsertKilterStats(db, statRows, { policy: 'raise-only' });
  return { sent: statRows.length, written };
}

/** Everything the per-run summary collects from each group besides counters. */
type CollectedGroupOutputs = {
  newCanonicals: NewClimbInfo[];
  skips: ClimbIngestSkip[];
  resolvedSkipUuids: string[];
};

/** Fold one group's result into the run summary. `gripsLayoutsProcessed` stays with the caller. */
function addGroupResult(summary: KilterCatalogSummary, collected: CollectedGroupOutputs, groupResult: GroupResult) {
  summary.climbsSeen += groupResult.climbsSeen;
  summary.climbsUnmapped += groupResult.climbsUnmapped;
  summary.canonicalsInserted += groupResult.canonicalsInserted;
  summary.aliasesUpserted += groupResult.aliasesUpserted;
  summary.statsUpserted += groupResult.statsUpserted;
  summary.statsWritten += groupResult.statsWritten;
  summary.selfAliasesBackfilled += groupResult.selfAliasesBackfilled;
  summary.canonicalsRelisted += groupResult.canonicalsRelisted;
  summary.relistsBlockedByDeletionHistory += groupResult.relistsBlockedByDeletionHistory;
  summary.climbsRerouted += groupResult.climbsRerouted;
  collected.newCanonicals.push(...groupResult.newCanonicals);
  collected.skips.push(...groupResult.skips);
  collected.resolvedSkipUuids.push(...groupResult.resolvedSkipUuids);
}

/** Fold one group result into another — the reroute pass runs once per target layout. */
function mergeGroupResult(into: GroupResult, from: GroupResult): void {
  into.climbsSeen += from.climbsSeen;
  into.climbsUnmapped += from.climbsUnmapped;
  into.canonicalsInserted += from.canonicalsInserted;
  into.aliasesUpserted += from.aliasesUpserted;
  into.statsUpserted += from.statsUpserted;
  into.statsWritten += from.statsWritten;
  into.selfAliasesBackfilled += from.selfAliasesBackfilled;
  into.canonicalsRelisted += from.canonicalsRelisted;
  into.relistsBlockedByDeletionHistory += from.relistsBlockedByDeletionHistory;
  into.climbsRerouted += from.climbsRerouted;
  into.newCanonicals.push(...from.newCanonicals);
  into.skips.push(...from.skips);
  into.resolvedSkipUuids.push(...from.resolvedSkipUuids);
}

/**
 * Where a rerouted climb's stats may be written: only when the climb is its own
 * canonical on the target layout. If it folded onto an existing canonical there,
 * that canonical's own Grips stat row is authoritative, and replaying the
 * duplicate's grade/quality/FA over it would clobber real data — the same
 * distinction foldCatalogStat makes between an own row and a merged one. Pure +
 * exported for unit testing.
 */
export function canonicalForReroutedStats(climbLowerUuid: string, canonicalUuid: string | undefined): string | null {
  if (!canonicalUuid) return null;
  return canonicalUuid.toLowerCase() === climbLowerUuid ? canonicalUuid : null;
}

/** Record the skip row the source group deliberately didn't write. */
function pushRerouteFallbackSkip(result: GroupResult, candidate: RerouteCandidate): void {
  result.climbsUnmapped += 1;
  result.skips.push(
    buildSkipRow(candidate.climb, candidate.sourceFailure, {
      boardType: KILTER,
      layoutId: candidate.sourceLayoutId,
      sourceLayoutUuid: candidate.sourceLayoutUuid,
    }),
  );
}

type IngestRerouteCandidatesArgs = {
  db: DrizzleDb;
  candidates: RerouteCandidate[];
  openSkips: Map<string, string>;
  deletedLowerUuids: ReadonlySet<string> | null;
  holeToPlacementByLayout: ReadonlyMap<number, Map<number, number>>;
  existingSelfAliasLower: Set<string>;
  log: (message: string) => void;
};

/**
 * Ingest the climbs Kilter tagged with the wrong layout, grouped by the layout
 * their holds actually place on. Eight climbs on prod (2026-09-15) had been
 * stuck in the skip backlog this way, invisible in Boardsesh with no path out.
 *
 * A per-layout failure is contained: those candidates fall back to the skip row
 * the source group would have written, and the rest of the catalog run (backlog
 * write, locations, deletions) still completes.
 */
async function ingestRerouteCandidates(args: IngestRerouteCandidatesArgs): Promise<GroupResult> {
  const result = createGroupResult();
  if (args.candidates.length === 0) return result;

  const byTargetLayout = new Map<number, RerouteCandidate[]>();
  for (const candidate of args.candidates) {
    const group = byTargetLayout.get(candidate.targetLayoutId) ?? [];
    group.push(candidate);
    byTargetLayout.set(candidate.targetLayoutId, group);
  }

  for (const [targetLayoutId, layoutCandidates] of byTargetLayout) {
    const holeToPlacement = args.holeToPlacementByLayout.get(targetLayoutId);
    if (!holeToPlacement) {
      // Unreachable — the candidate's target came from this very map — but a
      // missing map must degrade to the backlog, never to a lost climb.
      for (const candidate of layoutCandidates) pushRerouteFallbackSkip(result, candidate);
      continue;
    }
    try {
      const layoutResult = await ingestRerouteCandidatesForLayout({
        db: args.db,
        targetLayoutId,
        candidates: layoutCandidates,
        holeToPlacement,
        openSkips: args.openSkips,
        deletedLowerUuids: args.deletedLowerUuids,
        existingSelfAliasLower: args.existingSelfAliasLower,
        log: args.log,
      });
      mergeGroupResult(result, layoutResult);
    } catch (error) {
      args.log(
        `[kilter-catalog] reroute onto layout ${targetLayoutId} failed (${error instanceof Error ? error.message : String(error)}); ${layoutCandidates.length} climb(s) stay in the backlog`,
      );
      for (const candidate of layoutCandidates) pushRerouteFallbackSkip(result, candidate);
    }
  }
  return result;
}

async function ingestRerouteCandidatesForLayout(input: {
  db: DrizzleDb;
  targetLayoutId: number;
  candidates: RerouteCandidate[];
  holeToPlacement: Map<number, number>;
  openSkips: Map<string, string>;
  deletedLowerUuids: ReadonlySet<string> | null;
  existingSelfAliasLower: Set<string>;
  log: (message: string) => void;
}): Promise<GroupResult> {
  const { db, targetLayoutId, candidates, holeToPlacement, openSkips, deletedLowerUuids, existingSelfAliasLower, log } =
    input;
  const result = createGroupResult();
  const candidateLowerUuids = candidates.map((candidate) => candidate.climb.climbUuid.toLowerCase());
  const candidateFingerprints = [...new Set(candidates.map((candidate) => candidate.fingerprint))];

  // Two narrow loads rather than the whole target layout: the candidate uuids
  // wherever they live (one already on another layout must not be ingested a
  // second time), plus the target layout's rows carrying a candidate
  // fingerprint, so a reroute folds onto an existing canonical instead of
  // duplicating it.
  const climbColumns = {
    uuid: boardClimbs.uuid,
    layoutId: boardClimbs.layoutId,
    fingerprint: boardClimbs.holdFingerprint,
    isListed: boardClimbs.isListed,
    userId: boardClimbs.userId,
    isDraft: boardClimbs.isDraft,
  };
  const uuidRows = await db
    .select(climbColumns)
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, KILTER), inArray(sql`lower(${boardClimbs.uuid})`, candidateLowerUuids)));
  const fingerprintRows =
    candidateFingerprints.length > 0
      ? await db
          .select(climbColumns)
          .from(boardClimbs)
          .where(
            and(
              eq(boardClimbs.boardType, KILTER),
              eq(boardClimbs.layoutId, targetLayoutId),
              inArray(boardClimbs.holdFingerprint, candidateFingerprints),
            ),
          )
      : [];

  const targetRowsByLowerUuid = new Map<string, LayoutCatalogClimbRow>();
  const otherLayoutByLowerUuid = new Map<string, number | null>();
  for (const row of [...uuidRows, ...fingerprintRows]) {
    const lowerUuid = row.uuid.toLowerCase();
    if (row.layoutId === targetLayoutId) {
      if (!targetRowsByLowerUuid.has(lowerUuid)) targetRowsByLowerUuid.set(lowerUuid, row);
    } else {
      otherLayoutByLowerUuid.set(lowerUuid, row.layoutId);
    }
  }

  const index = buildLayoutCatalogIndex({
    layoutId: targetLayoutId,
    climbRows: [...targetRowsByLowerUuid.values()],
    existingSelfAliasLower,
    holeToPlacement,
  });

  const batch = createStagingBatch();
  const climbUuidToCanonical = new Map<string, string>();
  const canonicalsToRelist = new Set<string>();
  const stagedCandidates: RerouteCandidate[] = [];
  // Only an insert or a fold is a recovery. Kilter never fixes the upstream tag,
  // so on every later cycle these same climbs are held aside again, decode
  // against the target layout and match there on UUID identity — counting those
  // would report the same eight climbs as rerouted forever and leave the
  // post-deploy check unable to tell a recovery from a re-handle. Their stats
  // are still replayed below.
  let recoveredCount = 0;
  const startedAt = new Date();
  for (const candidate of candidates) {
    const lowerUuid = candidate.climb.climbUuid.toLowerCase();
    const otherLayoutId = otherLayoutByLowerUuid.get(lowerUuid);
    if (otherLayoutId !== undefined) {
      // The uuid already lives on a third layout, so ingesting it here would
      // give one climb two rows. Leave the original skip row as the record.
      log(
        `[kilter-catalog] reroute declined: ${candidate.climb.climbUuid} already exists on layout ${otherLayoutId ?? 'unknown'}`,
      );
      pushRerouteFallbackSkip(result, candidate);
      continue;
    }
    const outcome = stageCatalogClimb(candidate.climb, {
      index,
      sourceLayoutUuid: candidate.sourceLayoutUuid,
      openSkips,
      batch,
      climbUuidToCanonical,
      canonicalsToRelist,
      deletedLowerUuids,
      // Rerouting is off inside the reroute pass: this IS the second hop, and a
      // third would let a climb bounce between layouts run after run.
      reroute: null,
      result,
      now: startedAt,
    });
    if (outcome === 'skipped') {
      // Shouldn't happen — the target decoded when the candidate was recorded —
      // so say so rather than letting it vanish into the counters. The skip row
      // is already written, against the target layout this time.
      log(
        `[kilter-catalog] reroute of ${candidate.climb.climbUuid} failed to decode on layout ${targetLayoutId} after all; left in the backlog`,
      );
      continue;
    }
    if (outcome === 'inserted' || outcome === 'folded') recoveredCount += 1;
    stagedCandidates.push(candidate);
  }

  await flushKilterLayoutBatch(db, batch.newClimbInserts, batch.newHoldRows, batch.aliasRows);
  result.canonicalsInserted += batch.newClimbInserts.length;
  result.aliasesUpserted += batch.aliasRows.length;
  result.climbsRerouted += recoveredCount;
  if (canonicalsToRelist.size > 0) {
    result.canonicalsRelisted += await relistCanonicals(db, [...canonicalsToRelist]);
  }

  // The source layout is the only place these climbs' stats are served from, so
  // replay the rows the source group set aside — but only onto a climb that is
  // its own canonical here (see canonicalForReroutedStats).
  const statsByCanonicalAngle = new Map<string, StatAccum>();
  const seenSourceStats = new Set<string>();
  for (const candidate of stagedCandidates) {
    const lowerUuid = candidate.climb.climbUuid.toLowerCase();
    const canonicalUuid = canonicalForReroutedStats(lowerUuid, climbUuidToCanonical.get(lowerUuid));
    if (!canonicalUuid) {
      if (candidate.stats.length > 0) {
        log(
          `[kilter-catalog] rerouted ${candidate.climb.climbUuid} folded onto an existing canonical on layout ${targetLayoutId}; its ${candidate.stats.length} stat row(s) stay with that canonical`,
        );
      }
      continue;
    }
    for (const stat of candidate.stats) {
      foldCatalogStatOnce(statsByCanonicalAngle, seenSourceStats, stat, canonicalUuid);
    }
  }
  const statsOutcome = await upsertCatalogStats(db, statsByCanonicalAngle);
  result.statsUpserted += statsOutcome.sent;
  result.statsWritten += statsOutcome.written;

  if (stagedCandidates.length > 0) {
    const reHandledCount = stagedCandidates.length - recoveredCount;
    log(
      `[kilter-catalog] rerouted ${recoveredCount} mis-tagged climb(s) onto layout ${targetLayoutId}${reHandledCount > 0 ? ` (${reHandledCount} already there from an earlier run)` : ''}`,
    );
  }
  return result;
}

export async function syncKilterCatalog(args: SyncKilterCatalogArgs): Promise<KilterCatalogSummary> {
  const log = args.log ?? (() => {});
  const state: TokenState = { provider: args.tokenProvider, token: await args.tokenProvider() };

  const reference = args.reference ?? (await pullKilterReference({ accessToken: state.token, log }));
  const resolver = await buildLayoutResolver(args.db);

  const allListedLayouts = reference.productLayouts.filter((layout) => layout.isListed);
  let listed = allListedLayouts;
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

  // hole_id → placement_id for every board layout the FULL listed set resolves
  // to, not just the layouts --layouts kept: the reroute resolver has to be able
  // to see the layout a mis-tagged climb really belongs to, and on a partial run
  // that layout is often outside the filter. Resolving the wider set also
  // persists those layout aliases and reports them as unmapped, which is why
  // `layoutsUnmapped` above stays counted over the filtered set only.
  const holeToPlacementByLayout = new Map<number, Map<number, number>>();
  const holeToPlacementFor = async (layoutId: number): Promise<Map<number, number>> => {
    const cached = holeToPlacementByLayout.get(layoutId);
    if (cached) return cached;
    const loaded = await loadHoleToPlacement(args.db, layoutId);
    holeToPlacementByLayout.set(layoutId, loaded);
    return loaded;
  };
  for (const layout of allListedLayouts) {
    const layoutId = resolver.resolve(layout.productLayoutUuid, layout.productName);
    if (layoutId !== null) await holeToPlacementFor(layoutId);
  }
  const rerouteCandidates = new Map<string, RerouteCandidate>();

  const summary: KilterCatalogSummary = {
    gripsLayoutsProcessed: 0,
    layoutsUnmapped,
    climbsSeen: 0,
    climbsUnmapped: 0,
    canonicalsInserted: 0,
    aliasesUpserted: 0,
    statsUpserted: 0,
    statsWritten: 0,
    selfAliasesBackfilled: 0,
    canonicalsRelisted: 0,
    relistsBlockedByDeletionHistory: 0,
    climbsRerouted: 0,
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
  const collected: CollectedGroupOutputs = { newCanonicals: [], skips: [], resolvedSkipUuids: [] };
  const allNewCanonicals = collected.newCanonicals;
  const allSkips = collected.skips;
  const allResolvedSkipUuids = collected.resolvedSkipUuids;

  // The climbs already sitting unresolved in the backlog, so a run that finally
  // ingests one can stamp it resolved without scanning every climb it saw.
  const openSkips = await loadOpenSkips(args.db, KILTER);

  // Kilter's deletion list, fetched ONCE for the whole run and shared by both
  // consumers: the identity re-list (which must never resurrect a climb Kilter
  // has just deleted, even though /climbs/all still returns it) and
  // reconcileDeletions at the end. A failed or empty fetch leaves it null, which
  // disables both — an absent list is not evidence that nothing was deleted.
  let deletedUuids: string[] | null = null;
  let deletedListError: string | null = null;
  try {
    deletedUuids = await withToken(state, (token) => fetchDeletedClimbUuids(token));
  } catch (error) {
    deletedListError = error instanceof Error ? error.message : String(error);
  }
  const deletedLowerUuids = buildDeletedLowerUuidSet(deletedUuids);
  if (deletedLowerUuids === null) {
    log(
      `[kilter-catalog] no deletion list this run (${deletedListError ?? 'endpoint returned none'}) — identity re-list and deletion reconciliation are both skipped`,
    );
  }

  // Loaded once for the whole run; see loadKilterSelfAliasLower.
  const existingSelfAliasLower = byBoardLayout.size > 0 ? await loadKilterSelfAliasLower(args.db) : new Set<string>();

  for (const [boardLayoutId, gripsLayoutUuids] of byBoardLayout) {
    const groupResult = await syncBoardLayoutGroup({
      db: args.db,
      state,
      boardLayoutId,
      gripsLayoutUuids,
      openSkips,
      deletedLowerUuids,
      holeToPlacement: await holeToPlacementFor(boardLayoutId),
      existingSelfAliasLower,
      reroute: { holeToPlacementByLayout, candidates: rerouteCandidates },
      log,
    });
    summary.gripsLayoutsProcessed += gripsLayoutUuids.length;
    addGroupResult(summary, collected, groupResult);
  }

  // Reroute pass: climbs Kilter tagged with the wrong layout, ingested onto the
  // layout their holds actually place on. It runs after every group, so a climb
  // seen under several Grips layouts is rerouted once, and before the backlog
  // write below, so a successful reroute never leaves a skip row behind.
  const rerouteResult = await ingestRerouteCandidates({
    db: args.db,
    candidates: [...rerouteCandidates.values()],
    openSkips,
    deletedLowerUuids,
    holeToPlacementByLayout,
    existingSelfAliasLower,
    log,
  });
  addGroupResult(summary, collected, rerouteResult);

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

  // Deletion reconciliation runs last (report-only unless applyDeletions), over
  // the list fetched once at the top of the run. With no list it doesn't run at
  // all — the empty summary.deletions report stands.
  if (deletedUuids !== null && deletedLowerUuids !== null) {
    try {
      summary.deletions = await reconcileDeletions(args.db, deletedUuids, args.applyDeletions ?? false, log, {
        batchLimit: args.deleteBatchLimit,
      });
    } catch (error) {
      log(`[kilter-catalog] deletion reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
