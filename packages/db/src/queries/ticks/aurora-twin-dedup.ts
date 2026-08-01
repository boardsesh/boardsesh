import { and, eq, isNotNull, notExists, or, sql, type Column, type SQL } from 'drizzle-orm';
import { QueryBuilder, alias } from 'drizzle-orm/pg-core';
import { boardseshTicks } from '../../schema';

/**
 * Read-time collapse of Aurora's own duplicate ascents (#3535).
 *
 * Aurora sometimes stores ONE ascent two-to-four times, each copy carrying its
 * own real upstream uuid. The live pull is keyed on `aurora_id`, so every copy
 * is a legitimate miss and lands as its own `boardsesh_ticks` row: the climber
 * sees the same send 2-4× in their logbook and their totals count it 2-4×.
 * Prod measured 11 groups / 25 rows fleet-wide (tension 7/16, kilter 4/9).
 *
 * Why this is a READ-side rule and not a write-side one:
 *
 *  - Every copy carries a real, still-live `aurora_id`. Deleting a copy cannot
 *    preserve that id (`boardsesh_ticks_aurora_id_unique` allows one row per
 *    id), so the next incremental pull sees an `aurora_id` miss and re-inserts
 *    it — forever. The 0165/0166 dedup migrations only avoid that because they
 *    MOVE the surrogate id onto the survivor first, which is impossible when
 *    both sides already hold a real one.
 *  - Suppressing at read time writes nothing, so the pull stays exactly as
 *    idempotent as it is today, and no row that Aurora still lists can be lost.
 *  - It heals every affected climber the moment it ships — no re-sync needed,
 *    and no backfill touching live rows for a 25-row problem.
 *
 * The rule, deliberately narrow:
 *
 *  - Both rows must be REAL Aurora-pull rows: `origin = 'aurora_pull'` with a
 *    non-NULL `aurora_id` that is not one of the JSON importer's synthetic
 *    `json-import-%` surrogates. A native / imported / Kilter-pulled row is
 *    never hidden by this rule.
 *  - Same natural key at the EXACT instant: user, board, climb, angle and a
 *    literally equal `climbed_at`. No tolerance window — Aurora stores at least
 *    second precision and two genuine sends of the same climb at the same angle
 *    in the same second are physically impossible, while two in the same day
 *    are routine (lapping, projecting, warming up). The cross-source claim's
 *    `NATURAL_KEY_TOLERANCE_SECONDS` / offset inference exist to reconcile a
 *    timezone-shifted foreign original and must NOT be reused here: both rows
 *    came from one source through one normaliser, so there is no offset.
 *  - Identical payload on every column `payloadDiffersFromStored`
 *    (packages/aurora-sync/src/sync/apply-user-logbook.ts) compares — mirror,
 *    status, attempt count, quality, difficulty, benchmark, comment. Aurora
 *    stored the same ascent verbatim, so requiring this costs nothing on the
 *    real rows and rules out collapsing a genuine re-log that differs only in,
 *    say, its comment. The one exception, a deliberate widening: once the
 *    survivor carries a local edit (`updated_at > aurora_synced_at`, the pull's
 *    own `isLocallyEdited` test), equality on the user-editable columns is
 *    dropped. Rating or commenting on the visible tick would otherwise un-hide
 *    its twins, and the pull skips locally-edited rows, so nothing would ever
 *    restore parity. `status` and `aurora_type` stay OUTSIDE that exception: an
 *    attempt and a send, or a `bids` row and an `ascents` row, are two
 *    different upstream facts, and an edited send must never swallow a real
 *    logged attempt.
 *  - Never when BOTH rows carry a real `kilter_id`: that would hide a second
 *    real Kilter ascent link, the same guard 0166 spells as
 *    `tw.kilter_id IS NULL OR o.kilter_id IS NULL`.
 *
 * The survivor is the row with the lexicographically SMALLEST `aurora_id`.
 * `created_at` is not usable as a tiebreak: co-arriving duplicates are written
 * by one chunked INSERT and share a single `now()`, so the winner would fall
 * out of payload order, and a full re-pull rewrites `created_at` wholesale.
 * `aurora_id` is a stable upstream property, distinct by unique index, and
 * identical on every device and every re-sync.
 *
 * Tombstones come out right for free: if Aurora deletes the survivor, the pull
 * deletes that row, the next-smallest `aurora_id` in the group stops matching a
 * smaller sibling, and the climber still sees exactly one tick.
 */

type TicksTable = typeof boardseshTicks;

/** Surrogate ids minted by the JSON importer — not real upstream Aurora ids. */
const SYNTHETIC_AURORA_ID_PATTERN = 'json-import-%';

/**
 * SQL twin of `isLocallyEdited` (apply-user-logbook.ts): the row carries an edit
 * made here that is newer than its last successful Aurora sync. A NULL
 * `aurora_synced_at` means the pull is authoritative, so it is not a local edit.
 */
function isLocallyEdited(ticks: { updatedAt: Column; auroraSyncedAt: Column }): SQL {
  return sql`(${ticks.auroraSyncedAt} IS NOT NULL AND ${ticks.updatedAt} > ${ticks.auroraSyncedAt})`;
}

/**
 * True for a row that is genuinely owned by the Aurora live pull. Takes the two
 * columns structurally so it accepts both the base table and the self-join
 * alias (drizzle bakes the table name into a column's type).
 */
export function isRealAuroraPullRow(ticks: { origin: Column; auroraId: Column }): SQL {
  return and(
    eq(ticks.origin, 'aurora_pull'),
    isNotNull(ticks.auroraId),
    sql`${ticks.auroraId} NOT LIKE ${SYNTHETIC_AURORA_ID_PATTERN}`,
  )!;
}

type AuroraTwinComparableRow = {
  origin: Column;
  auroraId: Column;
  userId: Column;
  boardType: Column;
  climbUuid: Column;
  angle: Column;
  climbedAt: Column;
  status: Column;
  auroraType: Column;
  updatedAt: Column;
  auroraSyncedAt: Column;
  isMirror: Column;
  attemptCount: Column;
  quality: Column;
  difficulty: Column;
  isBenchmark: Column;
  comment: Column;
  kilterId: Column;
};

/**
 * Exact, directional pair predicate shared by read collapse and mutations.
 *
 * `smaller` is a direct witness that hides `larger`; the direction matters
 * because only the smaller row's local-edit timestamp relaxes payload parity.
 * Keep every rule here pairwise. In particular, callers must not build a
 * transitive closure through an intermediate row: A hiding B and B hiding C
 * does not imply that a mutation addressed to A may change C.
 */
export function isDirectAuroraTwin(smaller: AuroraTwinComparableRow, larger: AuroraTwinComparableRow): SQL {
  return and(
    isRealAuroraPullRow(smaller),
    isRealAuroraPullRow(larger),
    eq(smaller.userId, larger.userId),
    eq(smaller.boardType, larger.boardType),
    eq(smaller.climbUuid, larger.climbUuid),
    eq(smaller.angle, larger.angle),
    // Exact timestamp-without-time-zone comparison stays inside Postgres.
    // Converting either side to a JS Date would truncate stored microseconds.
    eq(smaller.climbedAt, larger.climbedAt),
    // These identify different upstream facts and are never edit-relaxed.
    eq(smaller.status, larger.status),
    sql`${smaller.auroraType} IS NOT DISTINCT FROM ${larger.auroraType}`,
    or(
      isLocallyEdited(smaller),
      and(
        sql`COALESCE(${smaller.isMirror}, false) = COALESCE(${larger.isMirror}, false)`,
        sql`${smaller.attemptCount} IS NOT DISTINCT FROM ${larger.attemptCount}`,
        sql`${smaller.quality} IS NOT DISTINCT FROM ${larger.quality}`,
        sql`${smaller.difficulty} IS NOT DISTINCT FROM ${larger.difficulty}`,
        sql`COALESCE(${smaller.isBenchmark}, false) = COALESCE(${larger.isBenchmark}, false)`,
        sql`COALESCE(${smaller.comment}, '') = COALESCE(${larger.comment}, '')`,
      ),
    ),
    sql`${smaller.auroraId} < ${larger.auroraId}`,
    // Never bridge two distinct real Kilter links.
    sql`(${smaller.kilterId} IS NULL OR ${larger.kilterId} IS NULL)`,
  )!;
}

/**
 * WHERE condition that keeps exactly one row per Aurora-side duplicate group.
 *
 * Composes as a plain condition, so a list query and its count query pick it up
 * from the same shared conditions array and can never disagree about how many
 * ascents there are. Index-backed: the correlated lookup probes
 * `boardsesh_ticks_user_climb_lookup_idx` (user_id, board_type, angle,
 * climb_uuid) with equality on all four columns.
 *
 * @param ticks the ticks table (or an alias of it) the query selects from.
 */
export function notAuroraTwinDuplicate(ticks: TicksTable = boardseshTicks): SQL {
  const twin = alias(boardseshTicks, 'aurora_twin');

  const smallerTwinExists = new QueryBuilder()
    .select({ one: sql`1` })
    .from(twin)
    .where(
      // The outer row must itself be a real Aurora-pull row. Keeping that test
      // inside the direct pair predicate preserves the plain NOT EXISTS shape,
      // which Postgres plans as a hash anti-join instead of a per-row SubPlan.
      isDirectAuroraTwin(twin, ticks),
    );

  return notExists(smallerTwinExists);
}
