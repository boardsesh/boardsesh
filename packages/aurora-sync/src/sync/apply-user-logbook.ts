import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { boardseshTicks, logbookSyncSkips, type LogbookSyncSkipReason } from '@boardsesh/db/schema';
import {
  recomputeClimbStatsBulk,
  inferUserUtcOffsetSeconds,
  adoptionMatchScoreSeconds,
  isWholeUtcOffsetShift,
  MAX_USER_UTC_OFFSET_SECONDS,
  NATURAL_KEY_TOLERANCE_SECONDS,
  acquireUserTickMutationLock,
  type ClimbStatsKey,
  type TickTimeSample,
} from '@boardsesh/db/queries';
import { convertQuality } from '@boardsesh/shared-schema';
import type { AuroraBoardName } from '@boardsesh/shared-schema/types';

import { normalizeTimestamp } from './normalize-timestamp';

/**
 * Shared apply logic for the Aurora live pull (ascents + bids), used by BOTH
 * the daemon path (packages/aurora-sync/src/sync/user-sync.ts) and the web
 * cron path (packages/web/app/lib/data-sync/aurora/user-sync.ts) so the
 * timezone-correctness, cross-source claim, soft-delete and edit-clobber
 * behaviour lives in one place.
 *
 * The three behaviours PR4 adds over the previous naive `INSERT … ON CONFLICT
 * (aurora_id)` upsert:
 *
 *  1. Timezone-correct timestamps (§work-item 1). Aurora's naive
 *     "YYYY-MM-DD HH:MM:SS" is UTC; the old `new Date(...).toISOString()`
 *     parsed it as server-local time and shifted every pulled tick by the
 *     deployment's UTC offset. `normalizeTimestamp` pins it to UTC — and makes
 *     the pulled climbed_at IDENTICAL to what the JSON import wrote for the same
 *     ascent, which is what the claim below keys on.
 *
 *  2. Cross-source claim (§work-item 3). On an aurora_id miss, before inserting
 *     a twin, natural-key-match the incoming ascent against the user's existing
 *     json_import / native rows (widened window + per-user offset inference for
 *     pre-fix, timezone-shifted history) and CLAIM the row — stamp
 *     aurora_id/aurora_type/aurora_synced_at, keep origin (origin records FIRST
 *     creation). No twin inserted.
 *
 *  3. Soft-delete honouring (§work-item 5, ascents only). Aurora sets
 *     is_listed=false to tombstone a deleted logbook entry. We stop upserting it
 *     as a live tick: a pull-owned row (origin aurora_pull/kilter_pull) is
 *     deleted; a CLAIMED native/json_import row just has its aurora markers
 *     cleared and the tick is kept (the user still owns it in Boardsesh).
 *
 *  4. Edit-clobber guard (§work-item 7). A by-aurora-id re-sync only overwrites
 *     a row that hasn't been locally edited since the last sync
 *     (updated_at ≤ aurora_synced_at) AND whose payload actually changed — no
 *     pointless writes/trigger churn, no clobbering a local edit.
 *
 * Operates on the caller's transaction handle — does not open its own.
 */

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// Any drizzle DB/transaction handle satisfies the query surface we use; the
// web (Neon HTTP) client and the daemon (postgres-js) client both qualify.
type AuroraApiRow = Record<string, unknown>;

const WRITE_CHUNK_SIZE = 100;

type NormalizedLogbookRow = {
  auroraId: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  createdAt: string;
  auroraType: 'ascents' | 'bids';
};

/** Compared columns that decide whether a by-aurora-id re-sync is a real change. */
type ComparedRow = {
  uuid: string;
  auroraId: string | null;
  ownerUserId: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean | null;
  status: string;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  isBenchmark: boolean | null;
  comment: string | null;
  climbedAt: string;
  updatedAt: string;
  auroraSyncedAt: string | null;
  origin: string;
};

/** Aurora encodes is_listed across a few wire shapes; only tombstone on explicit false. */
function isAuroraListedFalse(value: unknown): boolean {
  return value === false || value === 0 || value === '0' || value === 'false';
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// --- Pre-write validation (#3871) -------------------------------------------
//
// Everything below exists to stop a value that survives JS coercion from being
// refused by Postgres inside a BATCHED statement. The row-by-row fallback in
// applyLogbookChunk is the backstop for what this doesn't anticipate, but it is
// NOT a substitute: `angle` also flows into recomputeClimbStatsBulk's own
// `jsonb_to_recordset(...) AS k(..., angle integer)` + INSERT INTO
// board_climb_stats, which runs AFTER the chunk loop and outside any write
// fallback. Validation is the only thing standing between a NaN angle and that
// second abort site. Deleting it does not just "lose a nicer error message".

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

function isInt4(value: number): boolean {
  return Number.isInteger(value) && value >= INT4_MIN && value <= INT4_MAX;
}

/** int4 or null. NaN, Infinity, 21.5 and out-of-range all become null. */
function int4OrNull(value: unknown): number | null {
  const parsed = toNumberOrNull(value);
  return parsed !== null && isInt4(parsed) ? parsed : null;
}

/**
 * Code points Postgres cannot store in `text`: a NUL byte, and an unpaired
 * UTF-16 surrogate. Both abort the WHOLE batched statement — `::jsonb` rejects
 * the escapes JSON.stringify emits for them ("unsupported Unicode escape
 * sequence" / "invalid input syntax for type json"), and the text bind path
 * rejects the raw bytes — which is exactly the deterministic chunk-killer this
 * guard exists to stop.
 *
 * Matching the NUL control character is the entire purpose of the pattern, not
 * an accident, hence the disable below.
 */
// oxlint-disable-next-line no-control-regex
const UNSTORABLE_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripUnstorableText(value: string): string {
  // String.replace resets a global regex's lastIndex itself, so this stays
  // stateless despite the /g flag.
  return value.replace(UNSTORABLE_TEXT, '');
}

/** A row Postgres could never accept, carrying the reason code for triage. */
class LogbookRowRejected extends Error {
  readonly reason: LogbookSyncSkipReason;

  constructor(reason: LogbookSyncSkipReason, message: string) {
    super(message);
    this.name = 'LogbookRowRejected';
    this.reason = reason;
  }
}

/**
 * An identity column (`aurora_id`, `climb_uuid`) must be present and storable.
 * Unlike a comment these can't be scrubbed: they're what the row is keyed,
 * deduped and re-synced by, so a corrupted one makes the row unusable.
 */
function requireStorableId(value: unknown, field: string): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '' || text === 'undefined' || text === 'null' || stripUnstorableText(text) !== text) {
    throw new LogbookRowRejected(
      'invalid_identity',
      `${field} is missing or not storable (got ${JSON.stringify(value)})`,
    );
  }
  return text;
}

/**
 * `angle` is `integer NOT NULL` and there is no honest default — a tick at a
 * guessed angle is wrong data — so an unusable angle is the one thing that
 * costs the whole row. That drop is only acceptable because the row is
 * quarantined in logbook_sync_skips with its payload intact and can be
 * replayed; see the table's doc comment.
 */
function requireAngle(value: unknown): number {
  const angle = int4OrNull(value);
  if (angle === null) {
    throw new LogbookRowRejected('invalid_angle', `angle is not a storable integer (got ${JSON.stringify(value)})`);
  }
  return angle;
}

/**
 * `quality` carries a DB CHECK (boardsesh_ticks_quality_range: NULL or 1-5).
 * convertQuality honours that today, but a future change to the star scale
 * would re-poison the column silently — and losing a rating is much cheaper
 * than losing the send, so out-of-range becomes NULL rather than a drop.
 */
function qualityWithinCheck(value: number | null): number | null {
  if (value === null) return null;
  return isInt4(value) && value >= 1 && value <= 5 ? value : null;
}

function normalizeAscent(item: AuroraApiRow): NormalizedLogbookRow {
  return {
    auroraId: requireStorableId(item.uuid, 'uuid'),
    climbUuid: requireStorableId(item.climb_uuid, 'climb_uuid'),
    angle: requireAngle(item.angle),
    isMirror: toBool(item.is_mirror),
    status: Number(item.attempt_id) === 1 ? 'flash' : 'send',
    // `attempt_count` is `integer NOT NULL DEFAULT 1`; fall back to that
    // default rather than dropping a real send over a garbage bid_count.
    attemptCount: int4OrNull(item.bid_count || 1) ?? 1,
    quality: qualityWithinCheck(
      convertQuality(item.quality != null && item.quality !== '' ? Number(item.quality) : null),
    ),
    // toNumberOrNull only guarantees finite — a fractional difficulty (21.5)
    // is still "invalid input syntax for type integer" at the SQL layer.
    difficulty: int4OrNull(item.difficulty),
    isBenchmark: toBool(item.is_benchmark),
    comment: stripUnstorableText(item.comment ? String(item.comment) : ''),
    climbedAt: normalizeTimestamp(String(item.climbed_at)),
    createdAt: item.created_at
      ? normalizeTimestamp(String(item.created_at))
      : normalizeTimestamp(String(item.climbed_at)),
    auroraType: 'ascents',
  };
}

function normalizeBid(item: AuroraApiRow): NormalizedLogbookRow {
  return {
    auroraId: requireStorableId(item.uuid, 'uuid'),
    climbUuid: requireStorableId(item.climb_uuid, 'climb_uuid'),
    angle: requireAngle(item.angle),
    isMirror: toBool(item.is_mirror),
    status: 'attempt',
    attemptCount: int4OrNull(item.bid_count || 1) ?? 1,
    quality: null,
    difficulty: null,
    isBenchmark: false,
    comment: stripUnstorableText(item.comment ? String(item.comment) : ''),
    climbedAt: normalizeTimestamp(String(item.climbed_at)),
    createdAt: item.created_at
      ? normalizeTimestamp(String(item.created_at))
      : normalizeTimestamp(String(item.climbed_at)),
    auroraType: 'bids',
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- Skip quarantine (#3871) ------------------------------------------------

/** One upstream row this sync refused, on its way to logbook_sync_skips. */
type LogbookSkipRecord = {
  auroraId: string;
  auroraType: 'ascents' | 'bids';
  reason: LogbookSyncSkipReason;
  detail: string;
  payload: unknown;
};

/** Params bound per DELETE when clearing resolved skips; well under PG's 65535. */
const SKIP_RECONCILE_CHUNK_SIZE = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Scrub a value into something `jsonb` will accept.
 *
 * The payload we quarantine is very often the row carrying the exact bytes
 * Postgres refused, so serializing it naively would make the RECORD of the
 * failure fail the same way — and that write lives in the caller's cross-table
 * transaction, so it would recreate the very wedge this table reports.
 */
function storableJson(value: unknown): unknown {
  // `undefined` -> null, not passthrough: JSON.stringify DROPS an
  // undefined-valued key entirely, and "Aurora sent no angle" would then be
  // indistinguishable from "the quarantine never captured the angle". The
  // absent field is usually the whole reason the row was refused, so it has to
  // survive into the record.
  if (value === undefined) return null;
  if (typeof value === 'string') return stripUnstorableText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(storableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        stripUnstorableText(key),
        storableJson(entry),
      ]),
    );
  }
  return value;
}

/**
 * Persist this run's skips so a dropped row is quarantined-and-replayable
 * rather than silently discarded. Best-effort by construction: wrapped in its
 * own savepoint so a failure to RECORD the problem can never become a bigger
 * problem than the one it was reporting.
 */
async function recordLogbookSyncSkips(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  userId: string,
  skips: LogbookSkipRecord[],
): Promise<void> {
  if (skips.length === 0) return;

  // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement
  // ("cannot affect row a second time"), and a duplicated upstream uuid whose
  // copies BOTH fail is exactly the shape that produces that. Last wins.
  const byAuroraId = new Map<string, LogbookSkipRecord>();
  for (const skip of skips) byAuroraId.set(`${skip.auroraType} ${skip.auroraId}`, skip);

  const now = new Date().toISOString();
  try {
    await db.transaction(async (sp) => {
      await sp
        .insert(logbookSyncSkips)
        .values(
          [...byAuroraId.values()].map((skip) => ({
            userId,
            boardType: boardName,
            auroraType: skip.auroraType,
            auroraId: skip.auroraId,
            reason: skip.reason,
            detail: stripUnstorableText(skip.detail).slice(0, 2000),
            payload: storableJson(skip.payload),
            firstSeenAt: now,
            lastSeenAt: now,
            seenCount: 1,
          })),
        )
        .onConflictDoUpdate({
          target: [
            logbookSyncSkips.userId,
            logbookSyncSkips.boardType,
            logbookSyncSkips.auroraType,
            logbookSyncSkips.auroraId,
          ],
          set: {
            reason: sql`excluded.reason`,
            detail: sql`excluded.detail`,
            payload: sql`excluded.payload`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // first_seen_at deliberately NOT overwritten: "since when" is the
            // question triage actually asks.
            seenCount: sql`${logbookSyncSkips.seenCount} + 1`,
          },
        });
    });
  } catch (error) {
    // console.ERROR, not warn: this is the double-failure case. The rows were
    // already dropped from the sync, so losing the record too means they are
    // gone with no trace and no way to replay them — strictly worse than the
    // skips this function exists to make visible. Swallowing is still correct
    // (throwing would abort the caller's cross-table transaction and recreate
    // the #3871 wedge), so the log line is the only signal an operator gets.
    console.error(
      `[aurora-sync] FAILED to record ${byAuroraId.size} logbook sync skip(s) for user ${userId} on ${boardName} — those rows are now dropped with no quarantine record: ${errorMessage(error)}`,
    );
  }
}

/**
 * Drop quarantine rows for upstream ids that just synced cleanly, so the table
 * answers "what is broken right now" instead of accumulating into "what ever
 * broke" — the difference between state and a counter, and the reason this is
 * queryable at all (see docs/aurora-sync.md).
 */
async function reconcileLogbookSyncSkips(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  userId: string,
  auroraType: 'ascents' | 'bids',
  handledIds: string[],
  skips: LogbookSkipRecord[],
): Promise<void> {
  const stillSkipped = new Set(skips.filter((skip) => skip.auroraType === auroraType).map((skip) => skip.auroraId));
  const resolved = [...new Set(handledIds.filter((id) => !stillSkipped.has(id)))];
  if (resolved.length === 0) return;

  try {
    // One savepoint around every chunk: same "reporting must not wedge the
    // sync" rule as recordLogbookSyncSkips, at one subtransaction per payload.
    await db.transaction(async (sp) => {
      for (const ids of chunk(resolved, SKIP_RECONCILE_CHUNK_SIZE)) {
        await sp
          .delete(logbookSyncSkips)
          .where(
            and(
              eq(logbookSyncSkips.userId, userId),
              eq(logbookSyncSkips.boardType, boardName),
              eq(logbookSyncSkips.auroraType, auroraType),
              inArray(logbookSyncSkips.auroraId, ids),
            ),
          );
      }
    });
  } catch (error) {
    console.warn(
      `[aurora-sync] could not clear resolved logbook sync skips for user ${userId} on ${boardName}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Turn a normalize/validate throw into a quarantine record. A LogbookRowRejected
 * carries its own triage code; anything else is the parse-time class PR #3872
 * (issue #3520) skips-and-logs, recorded here so those skips stop being
 * console-only too.
 */
function skipFromNormalizeError(
  item: AuroraApiRow,
  error: unknown,
  auroraType: 'ascents' | 'bids',
  userId: string,
  boardName: AuroraBoardName,
): LogbookSkipRecord {
  const reason: LogbookSyncSkipReason = error instanceof LogbookRowRejected ? error.reason : 'normalize_failed';
  console.warn(
    `[aurora-sync] skipping malformed ${auroraType === 'ascents' ? 'ascent' : 'bid'} row (uuid=${String(item.uuid)}, user=${userId}, board=${boardName}, reason=${reason}): ${errorMessage(error)}`,
  );
  return {
    // String() and not requireStorableId: the id may be the very thing that's
    // broken, and a quarantine row with a scrubbed id still beats no record.
    auroraId: stripUnstorableText(String(item.uuid ?? '')).slice(0, 255),
    auroraType,
    reason,
    detail: errorMessage(error),
    payload: item,
  };
}

/**
 * Last-write-wins dedupe on aurora_id.
 *
 * Two rows sharing an aurora_id are both "misses" (neither is stored yet), so
 * both would be INSERTed and boardsesh_ticks_aurora_id_unique would abort the
 * chunk — deterministically, every cycle, forever. Deduping at PAYLOAD level
 * rather than per chunk matters: a chunk boundary between the two copies would
 * hide the collision from a per-chunk guard and let it reach the index.
 *
 * Not a quarantine case: same id means same upstream row, so keeping the last
 * copy loses nothing (it is what the DB would have converged on anyway).
 */
function dedupeByAuroraId(rows: NormalizedLogbookRow[]): NormalizedLogbookRow[] {
  const byId = new Map<string, NormalizedLogbookRow>();
  for (const row of rows) byId.set(row.auroraId, row);
  if (byId.size !== rows.length) {
    console.warn(`[aurora-sync] collapsed ${rows.length - byId.size} duplicate aurora_id row(s) in one payload`);
  }
  return [...byId.values()];
}

/**
 * Honour Aurora ascent tombstones (is_listed=false): a pull-owned row is
 * deleted; a claimed native/json_import row keeps the tick and just drops its
 * aurora markers. Returns the (climb, angle) keys touched.
 */
async function applyAuroraTombstones(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  userId: string,
  auroraIds: string[],
): Promise<ClimbStatsKey[]> {
  const touched: ClimbStatsKey[] = [];
  if (auroraIds.length === 0) return touched;

  for (const ids of chunk(auroraIds, WRITE_CHUNK_SIZE)) {
    const rows = await db
      .select({
        uuid: boardseshTicks.uuid,
        climbUuid: boardseshTicks.climbUuid,
        angle: boardseshTicks.angle,
        origin: boardseshTicks.origin,
      })
      .from(boardseshTicks)
      .where(
        and(
          eq(boardseshTicks.userId, userId),
          eq(boardseshTicks.boardType, boardName),
          inArray(boardseshTicks.auroraId, ids),
        ),
      );

    const toDelete: string[] = [];
    const toClear: string[] = [];
    for (const row of rows) {
      touched.push({ boardType: boardName, climbUuid: row.climbUuid, angle: row.angle });
      // A claimed native/json_import row is owned by Boardsesh (or the JSON
      // export) — keep the tick, just unlink it from the now-deleted Aurora
      // ascent. A pull-owned row is upstream's; the tombstone means delete.
      if (row.origin === 'native' || row.origin === 'json_import') toClear.push(row.uuid);
      else toDelete.push(row.uuid);
    }

    if (toDelete.length > 0) {
      await db.delete(boardseshTicks).where(inArray(boardseshTicks.uuid, toDelete));
    }
    if (toClear.length > 0) {
      await db
        .update(boardseshTicks)
        .set({
          auroraId: null,
          auroraType: null,
          auroraSyncedAt: null,
          auroraSyncError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(inArray(boardseshTicks.uuid, toClear));
    }
  }
  return touched;
}

function payloadDiffersFromStored(incoming: NormalizedLogbookRow, stored: ComparedRow): boolean {
  return (
    incoming.climbUuid !== stored.climbUuid ||
    incoming.angle !== stored.angle ||
    incoming.isMirror !== (stored.isMirror ?? false) ||
    incoming.status !== stored.status ||
    incoming.attemptCount !== stored.attemptCount ||
    incoming.quality !== stored.quality ||
    incoming.difficulty !== stored.difficulty ||
    incoming.isBenchmark !== (stored.isBenchmark ?? false) ||
    incoming.comment !== (stored.comment ?? '') ||
    Date.parse(incoming.climbedAt) !== Date.parse(stored.climbedAt)
  );
}

/**
 * #3909 writer guard: keep a corrected legacy `climbed_at` instead of letting
 * the pull write the shifted upstream value back over it.
 *
 * Aurora's naive "YYYY-MM-DD HH:MM:SS" is believed to carry the CLIMBER's local
 * wall clock for ascents logged in the official Kilter/Tension app (see
 * packages/db/src/queries/tick-offset-inference.ts and #3909's per-user offset
 * measurement). Once a legacy row's climbed_at is corrected to the true UTC
 * instant, the by-aurora-id update path below sees stored − incoming = a whole
 * UTC offset, calls it a payload change, and rewrites the shifted value: the
 * correction self-reverts inside one sync cycle. So on exactly that shape we
 * substitute the STORED climbed_at into the update payload — every other field
 * still applies, only the timestamp is held.
 *
 * TRADE-OFF, stated plainly: an upstream edit that moves an ascent by a
 * plausible whole zone offset (a climber fixing "I logged this an hour out") is
 * byte-identical to the legacy shift and is therefore also suppressed. Sub-hour
 * edits, and any change ≥15 min that is not within 60s of a 15-minute grid
 * point, still propagate — `isWholeUtcOffsetShift` deliberately excludes the
 * ±60s fast path that `climbedAtMatchesForAdoption` would have swallowed.
 */
function preserveCorrectedClimbedAt(incoming: NormalizedLogbookRow, stored: ComparedRow): NormalizedLogbookRow {
  const storedMs = Date.parse(stored.climbedAt);
  const incomingMs = Date.parse(incoming.climbedAt);
  if (!Number.isFinite(storedMs) || !Number.isFinite(incomingMs)) return incoming;
  if (!isWholeUtcOffsetShift(storedMs - incomingMs)) return incoming;
  return { ...incoming, climbedAt: stored.climbedAt };
}

/** True when the row carries a local edit newer than the last successful sync. */
function isLocallyEdited(stored: ComparedRow): boolean {
  if (stored.auroraSyncedAt === null) return false; // never synced from Aurora → pull is authoritative
  return Date.parse(stored.updatedAt) > Date.parse(stored.auroraSyncedAt);
}

async function applyLogbookChunk(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  userId: string,
  incoming: NormalizedLogbookRow[],
  now: string,
  auroraType: 'ascents' | 'bids',
  claimStatuses: Array<'flash' | 'send' | 'attempt'>,
  skips: LogbookSkipRecord[],
): Promise<ClimbStatsKey[]> {
  const touched: ClimbStatsKey[] = [];
  const addKey = (climbUuid: string, angle: number) => touched.push({ boardType: boardName, climbUuid, angle });

  const incomingIds = incoming.map((r) => r.auroraId);

  // (a) Existing rows by aurora_id (the idempotent re-sync case). The SELECT is
  // deliberately global — boardsesh_ticks_aurora_id_unique means each id lives
  // on at most one row table-wide — and the hits are partitioned by owner
  // below. A same-id row owned by a DIFFERENT user (the same Aurora account
  // linked to two Boardsesh accounts) must be skipped entirely: updating it
  // would cross users, and filtering it out of the SELECT instead would turn
  // the row into a "miss" whose INSERT collides with the global unique index
  // and aborts the whole chunk. Same partition-and-skip shape as kilter-sync's
  // applyLogs foreignKilterIds handling.
  const byAuroraIdRows = (await db
    .select({
      uuid: boardseshTicks.uuid,
      auroraId: boardseshTicks.auroraId,
      ownerUserId: boardseshTicks.userId,
      climbUuid: boardseshTicks.climbUuid,
      angle: boardseshTicks.angle,
      isMirror: boardseshTicks.isMirror,
      status: boardseshTicks.status,
      attemptCount: boardseshTicks.attemptCount,
      quality: boardseshTicks.quality,
      difficulty: boardseshTicks.difficulty,
      isBenchmark: boardseshTicks.isBenchmark,
      comment: boardseshTicks.comment,
      climbedAt: boardseshTicks.climbedAt,
      updatedAt: boardseshTicks.updatedAt,
      auroraSyncedAt: boardseshTicks.auroraSyncedAt,
      origin: boardseshTicks.origin,
    })
    .from(boardseshTicks)
    .where(inArray(boardseshTicks.auroraId, incomingIds))) as ComparedRow[];

  const storedByAuroraId = new Map<string, ComparedRow>();
  const foreignAuroraIds = new Set<string>();
  for (const row of byAuroraIdRows) {
    if (!row.auroraId) continue;
    if (row.ownerUserId === userId) {
      storedByAuroraId.set(row.auroraId, row);
    } else {
      foreignAuroraIds.add(row.auroraId);
      console.warn(
        `[aurora-sync] aurora_id ${row.auroraId} already linked to a different Boardsesh user — skipping for user ${userId} (duplicate Aurora account link)`,
      );
    }
  }

  // Foreign-owned ids are excluded from the misses too: they must be neither
  // claimed nor inserted (the insert would collide on the unique index).
  const misses = incoming.filter((r) => !storedByAuroraId.has(r.auroraId) && !foreignAuroraIds.has(r.auroraId));

  // (b) Cross-source claim for the misses.
  const claims = new Map<string, string>(); // aurora_id → existing tick uuid to claim
  const claimedUuids = new Set<string>();
  if (misses.length > 0) {
    // Row-value tuple filter, NOT separate climb_uuid/angle IN-lists: two
    // independent IN-lists fetch the cartesian product (every listed climb at
    // every listed angle), which over-fetches badly for a user who logs many
    // climbs across many angles in one chunk. Bounded: misses ≤
    // WRITE_CHUNK_SIZE (100) → ≤ 200 tuple params per statement.
    const pairByKey = new Map<string, { climbUuid: string; angle: number }>();
    for (const miss of misses) {
      pairByKey.set(`${miss.climbUuid} ${miss.angle}`, { climbUuid: miss.climbUuid, angle: miss.angle });
    }
    const pairTuples = sql.join(
      [...pairByKey.values()].map((pair) => sql`(${pair.climbUuid}, ${pair.angle})`),
      sql`, `,
    );
    const timestamps = misses.map((m) => Date.parse(m.climbedAt)).filter((t) => Number.isFinite(t));
    if (timestamps.length > 0) {
      // Widen the fetch window by the max plausible offset so a pre-fix,
      // timezone-shifted original is inside the range and can be claimed.
      const windowMs = (MAX_USER_UTC_OFFSET_SECONDS + NATURAL_KEY_TOLERANCE_SECONDS) * 1000;
      const minTs = new Date(Math.min(...timestamps) - windowMs).toISOString();
      const maxTs = new Date(Math.max(...timestamps) + windowMs).toISOString();

      const candidateRows = await db
        .select({
          uuid: boardseshTicks.uuid,
          climbUuid: boardseshTicks.climbUuid,
          angle: boardseshTicks.angle,
          climbedAt: boardseshTicks.climbedAt,
          status: boardseshTicks.status,
        })
        .from(boardseshTicks)
        .where(
          and(
            eq(boardseshTicks.userId, userId),
            eq(boardseshTicks.boardType, boardName),
            sql`(${boardseshTicks.climbUuid}, ${boardseshTicks.angle}) IN (${pairTuples})`,
            inArray(boardseshTicks.origin, ['native', 'json_import']),
            inArray(boardseshTicks.status, claimStatuses),
            // Never claim a row that already carries a REAL Aurora link — only
            // an unlinked native tick or a synthetic json-import placeholder is
            // claimable. Overwriting an existing aurora_id would orphan the
            // original upstream link and churn/duplicate the row on later pulls.
            sql`(${boardseshTicks.auroraId} IS NULL OR ${boardseshTicks.auroraId} LIKE 'json-import-%')`,
            sql`${boardseshTicks.climbedAt}::timestamptz BETWEEN ${minTs}::timestamptz AND ${maxTs}::timestamptz`,
          ),
        );

      const existingSamples: TickTimeSample[] = candidateRows.map((r) => ({
        climbUuid: r.climbUuid,
        angle: r.angle,
        climbedAtMs: Date.parse(r.climbedAt),
      }));
      const incomingSamples: TickTimeSample[] = misses.map((m) => ({
        climbUuid: m.climbUuid,
        angle: m.angle,
        climbedAtMs: Date.parse(m.climbedAt),
      }));
      const offset = inferUserUtcOffsetSeconds(existingSamples, incomingSamples);

      for (const miss of misses) {
        const missMs = Date.parse(miss.climbedAt);
        if (!Number.isFinite(missMs)) continue;
        // Closest eligible candidate — fast-path same-instant preferred over an
        // offset-distant one — so a shifted-history user's distinct same-key
        // ascent is never claimed in place of the true same-instant match.
        let matchUuid: string | null = null;
        let bestScore = Infinity;
        for (const r of candidateRows) {
          if (claimedUuids.has(r.uuid)) continue;
          if (r.climbUuid !== miss.climbUuid) continue;
          if (r.angle !== miss.angle) continue;
          const score = adoptionMatchScoreSeconds(Date.parse(r.climbedAt), missMs, offset);
          if (score === null || score >= bestScore) continue;
          bestScore = score;
          matchUuid = r.uuid;
        }
        if (matchUuid) {
          claims.set(miss.auroraId, matchUuid);
          claimedUuids.add(matchUuid);
          addKey(miss.climbUuid, miss.angle);
        }
      }
    }
  }

  // (c) By-aurora-id updates: skip locally-edited rows and no-op re-syncs.
  // preserveCorrectedClimbedAt runs BEFORE payloadDiffersFromStored so a row
  // whose only difference is a #3909 whole-offset shift drops out of the update
  // set entirely instead of being rewritten with the shifted timestamp.
  const updates = incoming
    .map((row) => ({ row, stored: storedByAuroraId.get(row.auroraId) }))
    .filter(
      (u): u is { row: NormalizedLogbookRow; stored: ComparedRow } =>
        u.stored !== undefined && !isLocallyEdited(u.stored),
    )
    .map(({ row, stored }) => ({ row: preserveCorrectedClimbedAt(row, stored), stored }))
    .filter(({ row, stored }) => payloadDiffersFromStored(row, stored));

  // (d) Inserts: misses that weren't claimed.
  const inserts = misses.filter((m) => !claims.has(m.auroraId));

  // Touched keys are collected BEFORE the writes and deliberately left as a
  // superset: a row that the fallback below ends up skipping leaves its
  // (climb, angle) in the list, and recomputing stats for it is idempotent —
  // cheaper than threading write outcomes back through the key list.
  for (const { row, stored } of updates) {
    // A re-sync can move a log to a different climb/angle; recompute both.
    addKey(stored.climbUuid, stored.angle);
    addKey(row.climbUuid, row.angle);
  }
  for (const row of inserts) addKey(row.climbUuid, row.angle);

  const claimEntries = [...claims.entries()];

  const writeClaims = async (target: DrizzleDb, entries: Array<[string, string]>): Promise<void> => {
    if (entries.length === 0) return;
    const claimPayload = JSON.stringify(entries.map(([auroraId, uuid]) => ({ uuid, aurora_id: auroraId })));
    await target.execute(sql`
      UPDATE boardsesh_ticks AS t SET
        aurora_id = u.aurora_id,
        aurora_type = ${auroraType}::aurora_table_type,
        aurora_synced_at = ${now}::timestamp,
        aurora_sync_error = NULL
      -- No updated_at: a claim only stamps sync-tracking columns (all
      -- whitelisted by trg_boardsesh_ticks_set_updated_at), so the tick's
      -- content is unchanged and it must not re-ship to offline clients. This
      -- also keeps updated_at < aurora_synced_at so the edit-clobber guard
      -- correctly reads the row as NOT locally edited.
      FROM jsonb_to_recordset(${claimPayload}::jsonb) AS u(uuid text, aurora_id text)
      -- user_id is redundant (claim candidates were selected with eq(userId))
      -- but keeps the never-cross-users invariant enforced at the write itself.
      WHERE t.uuid = u.uuid
        AND t.user_id = ${userId}
        AND (t.aurora_synced_at IS NULL OR t.updated_at <= t.aurora_synced_at)
    `);
  };

  const writeUpdates = async (
    target: DrizzleDb,
    rows: Array<{ row: NormalizedLogbookRow; stored: ComparedRow }>,
  ): Promise<void> => {
    if (rows.length === 0) return;
    const updatePayload = JSON.stringify(
      rows.map(({ row }) => ({
        aurora_id: row.auroraId,
        climb_uuid: row.climbUuid,
        angle: row.angle,
        is_mirror: row.isMirror,
        status: row.status,
        attempt_count: row.attemptCount,
        quality: row.quality,
        difficulty: row.difficulty,
        is_benchmark: row.isBenchmark,
        comment: row.comment,
        climbed_at: row.climbedAt,
        aurora_synced_at: now,
        updated_at: now,
      })),
    );
    await target.execute(sql`
      UPDATE boardsesh_ticks AS t SET
        climb_uuid = u.climb_uuid,
        angle = u.angle,
        is_mirror = u.is_mirror,
        status = u.status::tick_status,
        attempt_count = u.attempt_count,
        quality = u.quality,
        difficulty = u.difficulty,
        is_benchmark = u.is_benchmark,
        comment = u.comment,
        climbed_at = u.climbed_at::timestamp,
        aurora_synced_at = u.aurora_synced_at::timestamp,
        aurora_sync_error = NULL,
        updated_at = u.updated_at::timestamp
      FROM jsonb_to_recordset(${updatePayload}::jsonb) AS u(
        aurora_id text,
        climb_uuid text,
        angle integer,
        is_mirror boolean,
        status text,
        attempt_count integer,
        quality integer,
        difficulty integer,
        is_benchmark boolean,
        comment text,
        climbed_at text,
        aurora_synced_at text,
        updated_at text
      )
      -- user_id is redundant with the owner partition above (updates only carry
      -- same-user rows) but keeps the never-cross-users invariant enforced at
      -- the write itself.
      WHERE t.aurora_id = u.aurora_id
        AND t.user_id = ${userId}
        -- Re-check at write time. A rolling-deploy node that does not yet take
        -- the shared advisory lock can edit after the SELECT above; comparing
        -- timestamp columns here also preserves Postgres microseconds that JS
        -- Date.parse cannot represent.
        AND (t.aurora_synced_at IS NULL OR t.updated_at <= t.aurora_synced_at)
    `);
  };

  const writeInserts = async (target: DrizzleDb, rows: NormalizedLogbookRow[]): Promise<void> => {
    if (rows.length === 0) return;
    await target.insert(boardseshTicks).values(
      rows.map((row) => ({
        uuid: randomUUID(),
        userId,
        boardType: boardName,
        climbUuid: row.climbUuid,
        angle: row.angle,
        isMirror: row.isMirror,
        // Freshly pulled from the user's Aurora logbook — already inside
        // upstream_ascensionist_count, so origin excludes it from the
        // Boardsesh double-count guard.
        origin: 'aurora_pull' as const,
        status: row.status,
        attemptCount: row.attemptCount,
        quality: row.quality,
        difficulty: row.difficulty,
        isBenchmark: row.isBenchmark,
        comment: row.comment,
        climbedAt: row.climbedAt,
        createdAt: row.createdAt,
        updatedAt: now,
        auroraType: row.auroraType,
        auroraId: row.auroraId,
        auroraSyncedAt: now,
      })),
    );
  };

  // --- Writes ---
  //
  // ONE savepoint around the chunk's three batched writes (#3871). Without it,
  // a single row Postgres refuses aborts the caller's transaction — and that
  // transaction spans EVERY synced table plus the sync checkpoint, so one bad
  // ascent rolls back bids, tags and circuits and stops the watermark
  // advancing. The next cycle re-fetches the same row and re-crashes: the
  // user's logbook stops updating permanently, with nothing surfaced.
  //
  // Rolling back to the savepoint leaves the outer transaction healthy, so the
  // chunk can be replayed row by row and lose only the offending row. This is
  // PR #3872's skip-and-log philosophy (issue #3520) one layer down, at
  // DB-execution time instead of parse time.
  //
  // Cost bound. postgres.js issues `savepoint sN` and, on error, `rollback to
  // sN` — but on SUCCESS it issues nothing at all (see its `scope()`: the
  // commit/release branch is guarded by `if (!name)`, which is false for a
  // named savepoint). So each savepoint stays open until the outer COMMIT and
  // costs one subtransaction.
  //
  // syncUserData opens a fresh transaction per Aurora PAGE, so the happy-path
  // count is (page size / WRITE_CHUNK_SIZE) — ~10 for a 1000-row page,
  // comfortably under the 64-subxid backend cache threshold past which other
  // backends fall back to pg_subtrans lookups.
  //
  // The replay path costs more: a chunk that falls back adds up to
  // `claims + updates + inserts` further savepoints (≤ WRITE_CHUNK_SIZE, i.e.
  // ~100), so ONE fully-bad chunk in a 1000-row page takes the page to ~110 and
  // over the threshold. That is a rare, self-limiting degradation — the poison
  // rows get quarantined and skipped on the next cycle rather than replayed
  // forever — but it is the number to reason about when tuning either constant.
  // Raising the page size raises both: keep a page under ~6400 rows.
  try {
    await db.transaction(async (savepoint) => {
      const sp = savepoint as unknown as DrizzleDb;
      await writeClaims(sp, claimEntries);
      await writeUpdates(sp, updates);
      await writeInserts(sp, inserts);
    });
  } catch (batchError) {
    console.warn(
      `[aurora-sync] batched ${auroraType} write failed for user ${userId} on ${boardName} (${incoming.length} row(s)); retrying row by row: ${errorMessage(batchError)}`,
    );

    // The savepoint rolled back ALL THREE writes above, so the replay redoes
    // all three — not just whichever one threw.
    const replay = async <T>(
      rows: T[],
      write: (target: DrizzleDb, subset: T[]) => Promise<void>,
      identify: (row: T) => { auroraId: string; payload: unknown },
    ): Promise<void> => {
      for (const row of rows) {
        try {
          await db.transaction(async (savepoint) => {
            await write(savepoint as unknown as DrizzleDb, [row]);
          });
        } catch (rowError) {
          const { auroraId, payload } = identify(row);
          console.warn(
            `[aurora-sync] skipping ${auroraType} row Postgres refused (aurora_id=${auroraId}, user=${userId}, board=${boardName}): ${errorMessage(rowError)}`,
          );
          skips.push({ auroraId, auroraType, reason: 'db_write_rejected', detail: errorMessage(rowError), payload });
        }
      }
    };

    // Quarantine the FULL normalized row, not just the {uuid, aurora_id} link
    // the claim statement happens to bind: the link alone can't be replayed
    // into a tick, and triage needs to see what the row actually was.
    const incomingByAuroraId = new Map(incoming.map((row) => [row.auroraId, row]));
    await replay(claimEntries, writeClaims, ([auroraId, uuid]) => ({
      auroraId,
      payload: { claimedTickUuid: uuid, row: incomingByAuroraId.get(auroraId) ?? null },
    }));
    await replay(updates, writeUpdates, ({ row }) => ({ auroraId: row.auroraId, payload: row }));
    await replay(inserts, writeInserts, (row) => ({ auroraId: row.auroraId, payload: row }));
  }

  return touched;
}

/**
 * Apply a full ascents payload: honour tombstones, then claim/update/insert the
 * live rows in write-sized chunks, then recompute every touched (climb, angle).
 */
export async function applyAuroraAscents(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  userId: string,
  data: AuroraApiRow[],
): Promise<void> {
  if (data.length === 0) return;
  const now = new Date().toISOString();
  const touchedKeys: ClimbStatsKey[] = [];

  const skips: LogbookSkipRecord[] = [];

  const tombstoneIds: string[] = [];
  const live: NormalizedLogbookRow[] = [];
  for (const item of data) {
    if (isAuroraListedFalse(item.is_listed)) {
      tombstoneIds.push(String(item.uuid));
    } else {
      // A single row with an unparseable timestamp (missing/garbage
      // climbed_at, or a created_at so malformed the climbed_at fallback
      // above doesn't save it), or one carrying a value Postgres could never
      // store, must not abort the whole payload: this runs inside
      // syncUserData's one cross-table transaction, so an uncaught throw here
      // rolls back every OTHER table that already synced this attempt AND
      // blocks the checkpoint from advancing — the next attempt just re-fetches
      // and re-crashes on the same poison row forever (#3520). Skip-and-record
      // the one row; every other row in the payload still lands.
      try {
        live.push(normalizeAscent(item));
      } catch (error) {
        skips.push(skipFromNormalizeError(item, error, 'ascents', userId, boardName));
      }
    }
  }

  // Shared with updateTick/deleteTick and Kilter log apply. The caller owns
  // the transaction; take this before the first target/tombstone SELECT.
  await acquireUserTickMutationLock(db, userId);

  touchedKeys.push(...(await applyAuroraTombstones(db, boardName, userId, tombstoneIds)));

  const unique = dedupeByAuroraId(live);
  for (const batch of chunk(unique, WRITE_CHUNK_SIZE)) {
    touchedKeys.push(
      ...(await applyLogbookChunk(db, boardName, userId, batch, now, 'ascents', ['flash', 'send'], skips)),
    );
  }

  await recordLogbookSyncSkips(db, boardName, userId, skips);
  // Tombstoned ids count as handled: a quarantined row deleted upstream is no
  // longer a problem anyone can fix, so its record should go too.
  await reconcileLogbookSyncSkips(
    db,
    boardName,
    userId,
    'ascents',
    [...tombstoneIds, ...unique.map((row) => row.auroraId)],
    skips,
  );

  await recomputeClimbStatsBulk(db, touchedKeys);
}

/** Apply a full bids payload: claim/update/insert attempts (no tombstones). */
export async function applyAuroraBids(
  db: DrizzleDb,
  boardName: AuroraBoardName,
  userId: string,
  data: AuroraApiRow[],
): Promise<void> {
  if (data.length === 0) return;
  const now = new Date().toISOString();
  const touchedKeys: ClimbStatsKey[] = [];

  const skips: LogbookSkipRecord[] = [];

  // Same skip-and-record rationale as applyAuroraAscents above: one malformed
  // bid must not throw out of the eager normalize pass and abort every other
  // table in the caller's transaction (#3520).
  const live: NormalizedLogbookRow[] = [];
  for (const item of data) {
    try {
      live.push(normalizeBid(item));
    } catch (error) {
      skips.push(skipFromNormalizeError(item, error, 'bids', userId, boardName));
    }
  }

  await acquireUserTickMutationLock(db, userId);

  const unique = dedupeByAuroraId(live);
  for (const batch of chunk(unique, WRITE_CHUNK_SIZE)) {
    touchedKeys.push(...(await applyLogbookChunk(db, boardName, userId, batch, now, 'bids', ['attempt'], skips)));
  }

  await recordLogbookSyncSkips(db, boardName, userId, skips);
  // No tombstone ids to add here (unlike ascents): Aurora does not tombstone
  // bids, so this function has no is_listed=false path. If one is ever added,
  // feed its ids in here too — otherwise a quarantined bid that upstream later
  // deletes would sit in logbook_sync_skips forever, since a deleted row never
  // comes back to resolve itself.
  await reconcileLogbookSyncSkips(
    db,
    boardName,
    userId,
    'bids',
    unique.map((row) => row.auroraId),
    skips,
  );

  await recomputeClimbStatsBulk(db, touchedKeys);
}
