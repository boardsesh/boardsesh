import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import {
  boardseshTicks,
  playlists,
  playlistClimbs,
  playlistOwnership,
  boardClimbRatings,
  boardClimbAliases,
} from '@boardsesh/db/schema';
import { resolveCanonicalClimbUuid } from '@boardsesh/db/queries';

import { KILTER_BOARD_TYPE } from '../api/types';
import { KilterApiError } from '../api/errors';
import { verifyKeycloakToken } from '../api/keycloak';
import { streamKilterPowerSync, type PowerSyncOp } from '../api/powersync-client';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Per-user pull (design Flow B): drain Kilter's PowerSync stream for this
 * user's buckets and translate ops into boardsesh rows.
 *
 * Kilter publishes per-user state across two PowerSync streams:
 *   - `user_buckets[<sub>]`: users, walls, logs, climb_ratings,
 *     gym_users, user_analytics
 *   - `circuit_buckets[<circuit_uuid>]`: circuits, circuit_climbs
 *
 * Subscribing to both `user_buckets` and `circuit_buckets` is mandatory —
 * the circuit owner's user_buckets references circuits by UUID but the
 * circuit metadata and its climb list live in the circuit-scoped bucket.
 *
 * Notably absent from Kilter's PowerSync: a `climbs` table. Climb metadata
 * for the kilter board comes from a different surface entirely; we don't
 * try to materialise it here — the ticks/ratings/circuits we write
 * reference `climb_uuid` and downstream callers go through
 * resolveCanonicalClimbUuid to handle dedup.
 *
 * Transaction shape: each of the three apply phases (logs, ratings,
 * circuits) runs in its own `db.transaction(...)`. Per-phase atomicity is
 * sufficient — every write is idempotent (ON CONFLICT), so cross-phase
 * crash recovery is a re-run, not a partial-state cleanup. Keeping the
 * transactions narrow keeps lock-held time bounded as the buffers grow.
 *
 * Stream-and-flush: per-type buffers flush eagerly once they reach
 * STREAM_FLUSH_THRESHOLD rows so we don't hold the entire snapshot in JS
 * memory for a heavy account. Circuits intentionally do NOT flush mid-
 * stream because their child circuit_climbs arrive in a separate bucket
 * and must be applied together with their parent.
 */

/**
 * Tolerance for the natural-key match in applyLogs: a Boardsesh-originated
 * tick within this many seconds of an incoming Kilter log (same user,
 * board, climb, angle) is treated as the same physical climb attempt —
 * Kilter records the timestamp client-side and the local clock can drift
 * by tens of seconds vs. Boardsesh's server-side stamp. Design §4.3.
 */
const NATURAL_KEY_TIME_TOLERANCE_SECONDS = 60;

/**
 * Maximum rows held in a per-type buffer before we flush mid-stream.
 * Picked to bound peak memory while still amortising the per-phase fixed
 * cost (alias pre-prime, jsonb_to_recordset round trip) across enough
 * rows to matter. Circuits are excluded from mid-stream flushing because
 * their child circuit_climbs ride a separate bucket.
 */
const STREAM_FLUSH_THRESHOLD = 500;

export type SyncKilterUserDataArgs = {
  db: DrizzleDb;
  userId: string;
  accessToken: string;
  /**
   * Optional structured-log callback. Used for soft-warning paths like a
   * divergent kilter_id on the natural-key match — these aren't errors
   * (we deliberately don't throw and skip the row) but they're worth
   * surfacing to the daemon's log.
   */
  log?: (msg: string) => void;
};

/**
 * Verify the Keycloak access token's signature against the realm JWKS
 * and return its `sub`. We need the verified sub to defensively scope
 * incoming PowerSync rows to the authenticated user — using an
 * unverified sub here would let a forged token with an attacker-chosen
 * sub silently bypass the circuit_buckets user_uuid filter.
 *
 * Threat model — same as callback/route.ts: `KILTER_IDP_HOST` is env-
 * driven, so a misconfigured or hostile env var could point us at
 * attacker infra, at which point "we received it over TLS" proves
 * nothing about who minted the token. The JWKS check ties the token
 * back to the legitimate realm's signing key regardless of where the
 * env vars sent us.
 *
 * The JWKS instance is cached at module scope inside `verifyKeycloakToken`
 * — jose's createRemoteJWKSet handles refresh internally — so we don't
 * re-fetch on every sync cycle.
 *
 * Failure handling: we DO NOT swallow verification errors. A silent
 * "no sub" return would drop the per-user `user_uuid` filter for an
 * entire sync cycle — a transient JWKS outage would skip the scope
 * filter on every retry until the JWKS came back. Instead we throw
 * with a `KilterApiError('powersync', …)` so the daemon's retry
 * classifier treats it as transient (network → retry next cycle) but
 * never proceeds with an unscoped pull.
 */
async function decodeAccessTokenSub(accessToken: string): Promise<string> {
  try {
    const { sub } = await verifyKeycloakToken(accessToken);
    return sub;
  } catch (err) {
    throw new KilterApiError(
      'powersync',
      `Access token JWKS verification failed; refusing to run an unscoped sync: ${(err as Error).message ?? err}`,
    );
  }
}

type RawLog = {
  id: string;
  log_uuid: string;
  climb_uuid: string;
  user_uuid: string;
  gym_uuid: string | null;
  wall_uuid: string | null;
  product_layout_uuid: string | null;
  angle: number;
  flashed: 0 | 1;
  topped: 0 | 1;
  attempts: number;
  created_at: string;
};

type RawClimbRating = {
  id: string;
  climb_rating_uuid: string;
  user_uuid: string;
  gym_uuid: string | null;
  wall_uuid: string | null;
  product_layout_uuid: string | null;
  climb_uuid: string;
  angle: number;
  rating: number | null;
  difficulty_grade_id: number | null;
  comment: string | null;
  created_at: string;
};

type RawCircuit = {
  id: string;
  circuit_uuid: string;
  name: string;
  description: string | null;
  color: string | null;
  is_public: 0 | 1;
  user_uuid: string;
  product_layout_uuid: string | null;
};

type RawCircuitClimb = {
  id: string;
  circuit_uuid: string;
  climb_uuid: string;
  angle: number | null;
  position?: number;
  created_at?: string;
};

export async function syncKilterUserData({
  db,
  userId,
  accessToken,
  log = (msg) => console.warn(msg),
}: SyncKilterUserDataArgs): Promise<void> {
  // Buffer ops by object_type so we can apply them in dependency order.
  // PowerSync delivers ops as a snapshot; each PUT carries the full row,
  // so we don't need to preserve the wire ordering — only the FK
  // ordering. logs / climb_ratings can flush mid-stream once a buffer
  // grows past STREAM_FLUSH_THRESHOLD; circuits / circuit_climbs cannot
  // because the parent circuit and its children arrive in separate
  // buckets and must be applied together.
  const buffer: {
    logs: PowerSyncOp[];
    climb_ratings: PowerSyncOp[];
    circuits: PowerSyncOp[];
    circuit_climbs: PowerSyncOp[];
  } = { logs: [], climb_ratings: [], circuits: [], circuit_climbs: [] };

  // Alias cache shared across every phase so we only resolve each climb
  // UUID once per sync. Pre-primed below before each phase runs.
  const aliasCache = new Map<string, string>();

  // Defensive scoping: the `circuit_buckets` stream is parameterised on
  // the Kilter server by circuit_uuid. Subscribing with empty
  // `parameters: {}` works against the production sync rules today (the
  // server scopes by token; we get only this user's circuits). If those
  // rules ever loosen we'd start ingesting other users' circuits, which
  // would be a privacy bug. Filter ingest by user_uuid below so a
  // server-side change can't leak data — at worst we'd ignore valid
  // data, not write someone else's.
  const sub = await decodeAccessTokenSub(accessToken);

  // Track which circuit UUIDs survived the user_uuid filter so we can
  // drop orphan circuit_climbs whose parent circuit was filtered out.
  // We can't lean on Map happenstance because circuit_climbs are
  // buffered before the parent circuit filter has run for that
  // circuit_uuid (the two buckets interleave).
  const acceptedCircuitUuids = new Set<string>();

  async function flushLogs(): Promise<void> {
    if (buffer.logs.length === 0) return;
    const batch = buffer.logs.splice(0, buffer.logs.length);
    await db.transaction((tx) => applyLogs(tx, userId, batch, aliasCache, log));
  }

  async function flushClimbRatings(): Promise<void> {
    if (buffer.climb_ratings.length === 0) return;
    const batch = buffer.climb_ratings.splice(0, buffer.climb_ratings.length);
    await db.transaction((tx) => applyClimbRatings(tx, userId, batch, aliasCache));
  }

  await streamKilterPowerSync({
    accessToken,
    streams: ['user_buckets', 'circuit_buckets'],
    onOp: async (op) => {
      switch (op.object_type) {
        case 'logs':
          if (op.op === 'PUT' && op.data) {
            const data = op.data as Record<string, unknown>;
            if (typeof data.user_uuid === 'string' && data.user_uuid !== sub) {
              log(`[kilter-sync] dropping log ${op.object_id} — user_uuid mismatch (server-side scope drift)`);
              break;
            }
          }
          buffer.logs.push(op);
          if (buffer.logs.length >= STREAM_FLUSH_THRESHOLD) {
            await primeAliasCacheForOps(db, aliasCache, buffer.logs, extractLogClimbUuid);
            await flushLogs();
          }
          break;
        case 'climb_ratings':
          if (op.op === 'PUT' && op.data) {
            const data = op.data as Record<string, unknown>;
            if (typeof data.user_uuid === 'string' && data.user_uuid !== sub) {
              log(`[kilter-sync] dropping rating ${op.object_id} — user_uuid mismatch (server-side scope drift)`);
              break;
            }
          }
          buffer.climb_ratings.push(op);
          if (buffer.climb_ratings.length >= STREAM_FLUSH_THRESHOLD) {
            await primeAliasCacheForOps(db, aliasCache, buffer.climb_ratings, extractRatingClimbUuid);
            await flushClimbRatings();
          }
          break;
        case 'circuits':
          if (op.op === 'PUT' && op.data) {
            const data = op.data as Record<string, unknown>;
            // Match the typeof guard used by logs + ratings above —
            // uniform shape across all three handlers means a future
            // reader doesn't have to wonder whether the missing
            // `typeof === 'string'` was deliberate.
            if (typeof data.user_uuid === 'string' && data.user_uuid !== sub) {
              log(`[kilter-sync] dropping circuit ${op.object_id} — user_uuid mismatch (server-side scope drift)`);
              break;
            }
            const circuitUuid = typeof data.circuit_uuid === 'string' ? data.circuit_uuid : op.object_id;
            acceptedCircuitUuids.add(circuitUuid);
          }
          buffer.circuits.push(op);
          break;
        case 'circuit_climbs':
          // circuit_climbs have no user_uuid of their own; we filter
          // them post-stream against acceptedCircuitUuids so a circuit
          // that was dropped by the user_uuid scope check also drops
          // its children. Do NOT trust the bucket scoping alone — the
          // two buckets interleave and the parent-filter decision for a
          // given circuit_uuid may not have run yet when its
          // circuit_climbs arrive.
          buffer.circuit_climbs.push(op);
          break;
        // Other per-user object types (walls, users, gym_users,
        // user_analytics) carry useful display state but no mapping
        // into the existing boardsesh schema. Skip them for v1; pick
        // them up if/when a downstream consumer asks.
      }
    },
  });

  // Final flush of any partial buffers left after checkpoint_complete.
  // Pre-prime the alias cache once per phase against everything we're
  // about to apply, then run each phase in its own transaction. The
  // per-phase tx boundary matters more than cross-phase atomicity —
  // every apply is independently idempotent via ON CONFLICT.
  await primeAliasCacheForOps(db, aliasCache, buffer.logs, extractLogClimbUuid);
  await flushLogs();

  await primeAliasCacheForOps(db, aliasCache, buffer.climb_ratings, extractRatingClimbUuid);
  await flushClimbRatings();

  // Drop orphan circuit_climbs whose parent circuit didn't survive the
  // user_uuid filter. Doing it here (not at ingest time) avoids the
  // ordering hazard of the two buckets interleaving. Also drop PUT ops
  // that arrive without a circuit_uuid entirely — passing an undefined
  // FK into applyCircuits would issue a query with `undefined` as the
  // lookup key. Better to drop the malformed row at the seam.
  const filteredCircuitClimbs = buffer.circuit_climbs.filter((op) => {
    if (op.op !== 'PUT' || !op.data) return true;
    const raw = op.data as RawCircuitClimb;
    if (!raw.circuit_uuid) return false;
    return acceptedCircuitUuids.has(raw.circuit_uuid);
  });

  const circuitClimbUuids: string[] = [];
  for (const op of filteredCircuitClimbs) {
    if (op.op === 'PUT' && op.data) {
      const raw = op.data as RawCircuitClimb;
      if (raw.climb_uuid) circuitClimbUuids.push(raw.climb_uuid);
    }
  }
  await primeAliasCache(db, aliasCache, circuitClimbUuids);

  await db.transaction((tx) => applyCircuits(tx, userId, buffer.circuits, filteredCircuitClimbs, aliasCache));
}

function extractLogClimbUuid(op: PowerSyncOp): string | undefined {
  if (op.op !== 'PUT' || !op.data) return undefined;
  const raw = op.data as RawLog;
  return raw.climb_uuid;
}

function extractRatingClimbUuid(op: PowerSyncOp): string | undefined {
  if (op.op !== 'PUT' || !op.data) return undefined;
  const raw = op.data as RawClimbRating;
  return raw.climb_uuid;
}

/**
 * Pre-load every alias row that maps to a UUID we're about to look up,
 * in a single round trip, and seed the cache. Replaces the per-row
 * SELECT inside the apply loops — at thousands of incoming ops that
 * dominated phase time. Mirrors the buildKilterPushUuidMap pattern in
 * push-back.ts.
 *
 * UUIDs already in the cache are skipped. Misses (UUIDs with no alias
 * row) are recorded as self-canonical so the lookup helper never re-
 * queries them.
 */
async function primeAliasCache(db: DrizzleDb, cache: Map<string, string>, uuids: string[]): Promise<void> {
  if (uuids.length === 0) return;
  const cacheKeyPrefix = `${KILTER_BOARD_TYPE}:`;
  const toFetch = Array.from(new Set(uuids)).filter((uuid) => !cache.has(`${cacheKeyPrefix}${uuid}`));
  if (toFetch.length === 0) return;

  const rows = await db
    .select({
      aliasUuid: boardClimbAliases.aliasUuid,
      canonicalUuid: boardClimbAliases.canonicalUuid,
    })
    .from(boardClimbAliases)
    .where(and(eq(boardClimbAliases.boardType, KILTER_BOARD_TYPE), inArray(boardClimbAliases.aliasUuid, toFetch)));

  const found = new Set<string>();
  for (const row of rows) {
    cache.set(`${cacheKeyPrefix}${row.aliasUuid}`, row.canonicalUuid);
    found.add(row.aliasUuid);
  }
  // Self-canonical entries for misses: resolveCanonicalClimbUuid falls
  // back to the input UUID when no alias row exists, so seed that too
  // to short-circuit the no-row SELECT inside the apply loop.
  for (const uuid of toFetch) {
    if (!found.has(uuid)) cache.set(`${cacheKeyPrefix}${uuid}`, uuid);
  }
}

async function primeAliasCacheForOps(
  db: DrizzleDb,
  cache: Map<string, string>,
  ops: PowerSyncOp[],
  extract: (op: PowerSyncOp) => string | undefined,
): Promise<void> {
  const uuids: string[] = [];
  for (const op of ops) {
    const uuid = extract(op);
    if (uuid) uuids.push(uuid);
  }
  await primeAliasCache(db, cache, uuids);
}

function deriveTickStatus(log: RawLog): 'flash' | 'send' | 'attempt' {
  if (!log.topped) return 'attempt';
  return log.flashed ? 'flash' : 'send';
}

type LogTickFields = {
  climbUuid: string;
  angle: number;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  climbedAt: string;
  kilterType: 'attempts' | 'logs';
  kilterSyncedAt: string;
  kilterSyncError: null;
  updatedAt: string;
};

function buildLogTickFields(raw: RawLog, canonical: string, now: string): LogTickFields {
  const status = deriveTickStatus(raw);
  return {
    climbUuid: canonical,
    angle: raw.angle,
    status,
    attemptCount: raw.attempts ?? 1,
    climbedAt: raw.created_at,
    kilterType: status === 'attempt' ? 'attempts' : 'logs',
    kilterSyncedAt: now,
    kilterSyncError: null,
    updatedAt: now,
  };
}

type NormalisedLog = {
  raw: RawLog;
  canonical: string;
  fields: LogTickFields;
};

/**
 * Apply a batch of `logs` ops in three round trips:
 *   1. Single SELECT to find existing ticks by kilter_id (the
 *      idempotent re-sync case).
 *   2. Single SELECT to find Boardsesh-originated ticks matching the
 *      natural key for rows not found in step 1.
 *   3. Bulk UPDATE for hits (steps 1+2) + bulk INSERT for misses.
 *
 * Replaces the previous 1-3 SELECTs + 1 INSERT/UPDATE per row, which
 * was O(N) round trips inside one transaction and dominated phase time
 * at thousands of pending logs.
 *
 * Per-row REMOVE ops fall through to a single bulk DELETE.
 */
export async function applyLogs(
  tx: DrizzleDb,
  userId: string,
  ops: PowerSyncOp[],
  aliasCache: Map<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  if (ops.length === 0) return;

  const removeIds: string[] = [];
  const puts: PowerSyncOp[] = [];
  for (const op of ops) {
    if (op.op === 'REMOVE') {
      removeIds.push(op.object_id);
    } else if (op.op === 'PUT' && op.data) {
      puts.push(op);
    }
  }

  if (removeIds.length > 0) {
    // Kilter signals deletion by sending REMOVE for the log_uuid. We
    // SOFT-detach the matching boardsesh_ticks rows: clear the Kilter
    // surrogate keys but keep the row itself.
    //
    // Why not hard-delete: PowerSync re-delivers full snapshots on
    // reconnect or schema migration, and during that re-delivery it
    // sends REMOVE before PUT for every row. A hard DELETE here would
    // wipe Boardsesh-side state (status promoted attempt→send,
    // notes, party-session links, computed fields) even though the row
    // is about to be re-inserted milliseconds later. The natural-key
    // adoption path below will re-claim the row and stamp a fresh
    // kilter_id back onto it on the subsequent PUT. Net effect for a
    // *real* Kilter-side delete: kilter_id NULL'd; the row stays
    // detached but visible in Boardsesh, which is the safer default
    // until we have a separate "user explicitly deleted on Kilter"
    // signal we can trust.
    await tx
      .update(boardseshTicks)
      .set({
        kilterId: null,
        kilterType: null,
        kilterSyncedAt: null,
        kilterSyncError: null,
        // boardsesh_ticks.updated_at is `timestamp({ mode: 'string' })`
        // in the schema, so the writer must hand drizzle an ISO string,
        // not a Date.
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(boardseshTicks.userId, userId), inArray(boardseshTicks.kilterId, removeIds)));
  }

  if (puts.length === 0) return;

  const now = new Date().toISOString();
  const normalised: NormalisedLog[] = [];
  for (const op of puts) {
    const raw = op.data as RawLog;
    const canonical = await resolveCanonicalClimbUuid(tx, KILTER_BOARD_TYPE, raw.climb_uuid, aliasCache);
    normalised.push({ raw, canonical, fields: buildLogTickFields(raw, canonical, now) });
  }

  // (a) Single SELECT to find ticks already present by kilter_id.
  const incomingKilterIds = normalised.map((n) => n.raw.log_uuid);
  const byKilterIdRows = await tx
    .select({ uuid: boardseshTicks.uuid, kilterId: boardseshTicks.kilterId })
    .from(boardseshTicks)
    .where(and(eq(boardseshTicks.userId, userId), inArray(boardseshTicks.kilterId, incomingKilterIds)));
  const kilterIdMap = new Map<string, string>();
  for (const row of byKilterIdRows) {
    if (row.kilterId) kilterIdMap.set(row.kilterId, row.uuid);
  }

  // (b) For rows not found in (a), one SELECT against the natural-key
  // set. We over-fetch by (user, board, climb_uuid IN …, angle IN …,
  // climbed_at BETWEEN …) and match (climb_uuid, angle, |Δt| ≤ N) in
  // JS — Postgres can't easily express the multi-column tuple match
  // alongside the time-range predicate without disabling index use, and
  // the post-filter is cheap.
  const naturalKeyCandidates = normalised.filter((n) => !kilterIdMap.has(n.raw.log_uuid));
  const naturalKeyMatchesByKey = new Map<string, { uuid: string; kilterId: string | null }>();
  // Filter out candidates with an unparseable created_at BEFORE we
  // feed timestamps into Math.min/max. A single NaN would propagate
  // through and `new Date(NaN).toISOString()` throws RangeError —
  // which would crash the whole bulk-upsert flush for one bad row.
  // The dropped rows take the insert path naturally (no natural-key
  // match → fresh insert), keeping the writer fail-open.
  const parseable = naturalKeyCandidates.filter((n) => Number.isFinite(Date.parse(n.raw.created_at)));
  if (parseable.length > 0) {
    const climbUuidSet = Array.from(new Set(parseable.map((n) => n.canonical)));
    const angleSet = Array.from(new Set(parseable.map((n) => n.raw.angle)));
    const timestamps = parseable.map((n) => Date.parse(n.raw.created_at));
    // Raw min/max from the batch — the SQL clause below adds the ±tolerance
    // window once. Pre-expanding here AND in SQL would silently double the
    // BETWEEN range (the JS post-filter below would still restrict to the
    // documented ±tolerance, but the SELECT would over-fetch and the
    // intent would mislead the next reader).
    const minTs = new Date(Math.min(...timestamps)).toISOString();
    const maxTs = new Date(Math.max(...timestamps)).toISOString();

    const candidateRows = await tx
      .select({
        uuid: boardseshTicks.uuid,
        kilterId: boardseshTicks.kilterId,
        climbUuid: boardseshTicks.climbUuid,
        angle: boardseshTicks.angle,
        climbedAt: boardseshTicks.climbedAt,
      })
      .from(boardseshTicks)
      .where(
        and(
          eq(boardseshTicks.userId, userId),
          eq(boardseshTicks.boardType, KILTER_BOARD_TYPE),
          inArray(boardseshTicks.climbUuid, climbUuidSet),
          inArray(boardseshTicks.angle, angleSet),
          // Sargable range cast. Use ::timestamptz on BOTH sides so
          // Postgres compares with offset semantics — created_at from
          // Kilter is an ISO string with offset, climbed_at is a TEXT
          // mode timestamp column; ::timestamptz normalises both to a
          // single UTC instant for the BETWEEN.
          // make_interval keeps the tolerance parameterised — sql.raw on
          // a numeric constant is safe today but becomes injection-prone
          // the moment the constant becomes runtime-configurable.
          sql`${boardseshTicks.climbedAt}::timestamptz BETWEEN (${minTs}::timestamptz - make_interval(secs => ${NATURAL_KEY_TIME_TOLERANCE_SECONDS})) AND (${maxTs}::timestamptz + make_interval(secs => ${NATURAL_KEY_TIME_TOLERANCE_SECONDS}))`,
        ),
      );

    // Match in JS by (climb_uuid, angle, |Δt| ≤ tolerance). The over-
    // fetch is bounded by the batch's combined climb/angle/time
    // envelope; in practice this returns at most a few extra rows.
    for (const candidate of naturalKeyCandidates) {
      const target = Date.parse(candidate.raw.created_at);
      const toleranceMs = NATURAL_KEY_TIME_TOLERANCE_SECONDS * 1000;
      const match = candidateRows.find((r) => {
        if (r.climbUuid !== candidate.canonical) return false;
        if (r.angle !== candidate.raw.angle) return false;
        const dt = Math.abs(Date.parse(r.climbedAt) - target);
        return dt <= toleranceMs;
      });
      if (match) {
        naturalKeyMatchesByKey.set(candidate.raw.log_uuid, { uuid: match.uuid, kilterId: match.kilterId });
      }
    }
  }

  // (c) Categorise: update-by-kilter-id, adopt-on-natural-key, skip-
  // divergent, insert.
  const updatesByKilterId: Array<{ uuid: string; fields: LogTickFields }> = [];
  const adoptions: Array<{ uuid: string; kilterId: string; fields: LogTickFields }> = [];
  const inserts: NormalisedLog[] = [];

  for (const n of normalised) {
    const existingUuid = kilterIdMap.get(n.raw.log_uuid);
    if (existingUuid) {
      updatesByKilterId.push({ uuid: existingUuid, fields: n.fields });
      continue;
    }
    const natural = naturalKeyMatchesByKey.get(n.raw.log_uuid);
    if (natural) {
      if (natural.kilterId === null) {
        adoptions.push({ uuid: natural.uuid, kilterId: n.raw.log_uuid, fields: n.fields });
      } else {
        // Divergent: a different kilter_id already on the natural-key
        // match. Per design §4.3 we log and skip rather than silently
        // overwrite — almost always a server-side merge we didn't see.
        log(
          `[kilter-sync] divergent kilter_id on tick ${natural.uuid}: existing=${natural.kilterId} incoming=${n.raw.log_uuid} — skipping`,
        );
      }
      continue;
    }
    inserts.push(n);
  }

  // (d) Bulk UPDATE…FROM jsonb_to_recordset for hits and one bulk
  // INSERT for misses. Two round trips instead of N.
  //
  // Drizzle's `db.update(...).set(...).where(...)` only generates a
  // single-table UPDATE — it can't emit `UPDATE … FROM <subquery>` with
  // a per-row payload. The set-oriented `UPDATE … FROM
  // jsonb_to_recordset(...)` form is the right tool for "update N rows
  // to N different values in one statement"; expressing it with the
  // Drizzle query builder would force a loop of single-row UPDATEs and
  // re-introduce the N-round-trip problem we just removed. Per
  // CLAUDE.md, raw `sql` is allowed when the query can't be expressed
  // with the query builder; this is that case.
  const updateRows: Array<{ uuid: string; kilter_id: string | null; fields: LogTickFields }> = [
    ...updatesByKilterId.map((u) => ({ uuid: u.uuid, kilter_id: null, fields: u.fields })),
    ...adoptions.map((a) => ({ uuid: a.uuid, kilter_id: a.kilterId, fields: a.fields })),
  ];

  if (updateRows.length > 0) {
    const payload = JSON.stringify(
      updateRows.map((u) => ({
        uuid: u.uuid,
        kilter_id: u.kilter_id,
        climb_uuid: u.fields.climbUuid,
        angle: u.fields.angle,
        status: u.fields.status,
        attempt_count: u.fields.attemptCount,
        climbed_at: u.fields.climbedAt,
        kilter_type: u.fields.kilterType,
        kilter_synced_at: u.fields.kilterSyncedAt,
        updated_at: u.fields.updatedAt,
      })),
    );
    await tx.execute(sql`
      UPDATE boardsesh_ticks AS t SET
        climb_uuid = u.climb_uuid,
        angle = u.angle,
        status = u.status::tick_status,
        attempt_count = u.attempt_count,
        climbed_at = u.climbed_at::timestamp,
        kilter_type = u.kilter_type::kilter_table_type,
        kilter_synced_at = u.kilter_synced_at::timestamp,
        kilter_sync_error = NULL,
        updated_at = u.updated_at::timestamp,
        kilter_id = COALESCE(u.kilter_id, t.kilter_id)
      FROM jsonb_to_recordset(${payload}::jsonb) AS u(
        uuid text,
        kilter_id text,
        climb_uuid text,
        angle integer,
        status text,
        attempt_count integer,
        climbed_at text,
        kilter_type text,
        kilter_synced_at text,
        updated_at text
      )
      WHERE t.uuid = u.uuid
    `);
  }

  if (inserts.length > 0) {
    await tx.insert(boardseshTicks).values(
      inserts.map((n) => ({
        ...n.fields,
        uuid: randomUUID(),
        userId,
        boardType: KILTER_BOARD_TYPE,
        isMirror: false,
        quality: null,
        difficulty: null,
        isBenchmark: false,
        comment: '',
        kilterId: n.raw.log_uuid,
      })),
    );
  }
}

/**
 * Apply a batch of `climb_ratings` ops as a single bulk upsert keyed on
 * the natural-key index (board_type, climb_uuid, angle, user_id). One
 * INSERT … ON CONFLICT DO UPDATE replaces the previous per-row loop.
 *
 * Conflict target is the natural-key unique index, NOT kilter_id. With
 * partial-on-NOT-NULL surrogate indexes a kilter_id upsert wouldn't
 * catch Boardsesh-originated rows that don't yet have a kilter_id; the
 * natural key always exists and always matches.
 *
 * On conflict, `comment` is preserved via COALESCE(EXCLUDED.comment,
 * board_climb_ratings.comment) — Kilter sending `comment: null` must
 * not clobber a non-empty Boardsesh-originated comment.
 */
export async function applyClimbRatings(
  tx: DrizzleDb,
  userId: string,
  ops: PowerSyncOp[],
  aliasCache: Map<string, string>,
): Promise<void> {
  if (ops.length === 0) return;

  const removeIds: string[] = [];
  const puts: PowerSyncOp[] = [];
  for (const op of ops) {
    if (op.op === 'REMOVE') {
      removeIds.push(op.object_id);
    } else if (op.op === 'PUT' && op.data) {
      puts.push(op);
    }
  }

  if (removeIds.length > 0) {
    await tx
      .delete(boardClimbRatings)
      .where(and(eq(boardClimbRatings.userId, userId), inArray(boardClimbRatings.kilterId, removeIds)));
  }

  if (puts.length === 0) return;

  const values = [] as Array<typeof boardClimbRatings.$inferInsert>;
  for (const op of puts) {
    const raw = op.data as RawClimbRating;
    const canonical = await resolveCanonicalClimbUuid(tx, KILTER_BOARD_TYPE, raw.climb_uuid, aliasCache);
    values.push({
      boardType: KILTER_BOARD_TYPE,
      climbUuid: canonical,
      angle: raw.angle,
      userId,
      rating: raw.rating,
      difficultyGradeId: raw.difficulty_grade_id,
      comment: raw.comment ?? '',
      // Kilter's per-rating payload doesn't carry a `weight`; the field
      // lives on the aggregated /api/logs response, not the rating row
      // itself. Leave null for kilter-origin rows.
      weight: null,
      kilterId: raw.climb_rating_uuid,
    });
  }

  if (values.length === 0) return;

  await tx
    .insert(boardClimbRatings)
    .values(values)
    .onConflictDoUpdate({
      target: [
        boardClimbRatings.boardType,
        boardClimbRatings.climbUuid,
        boardClimbRatings.angle,
        boardClimbRatings.userId,
      ],
      set: {
        rating: sql`EXCLUDED.rating`,
        difficultyGradeId: sql`EXCLUDED.difficulty_grade_id`,
        // COALESCE so a null incoming comment doesn't clobber a non-
        // empty Boardsesh-originated comment.
        comment: sql`COALESCE(EXCLUDED.comment, ${boardClimbRatings.comment})`,
        // Adopt the kilter_id onto the existing row if it was a
        // Boardsesh-originated rating before this sync. COALESCE so
        // an incoming row that arrives WITHOUT a kilter_id (shouldn't
        // happen for kilter-origin PUTs in practice, but defensive)
        // never nulls out a kilter_id we already adopted.
        kilterId: sql`COALESCE(EXCLUDED.kilter_id, ${boardClimbRatings.kilterId})`,
        updatedAt: new Date(),
      },
    });
}

export async function applyCircuits(
  tx: DrizzleDb,
  userId: string,
  circuitOps: PowerSyncOp[],
  circuitClimbOps: PowerSyncOp[],
  aliasCache: Map<string, string>,
): Promise<void> {
  // Group circuit_climbs by their parent circuit_uuid so we can diff
  // against the current playlist contents. REMOVE ops on circuit_climbs
  // are ignored — the full-snapshot diff below replaces the
  // playlist contents anyway.
  const climbsByCircuit = new Map<string, RawCircuitClimb[]>();
  for (const op of circuitClimbOps) {
    if (op.op !== 'PUT' || !op.data) continue;
    const raw = op.data as RawCircuitClimb;
    if (!raw.circuit_uuid) continue;
    let list = climbsByCircuit.get(raw.circuit_uuid);
    if (!list) {
      list = [];
      climbsByCircuit.set(raw.circuit_uuid, list);
    }
    list.push(raw);
  }

  for (const op of circuitOps) {
    if (op.op === 'REMOVE') {
      // Only delete the playlist when *this* user owns it. REMOVE ops
      // don't carry the data payload, so the buffer-time user_uuid
      // guard can't filter them — a server-side scope drift could
      // otherwise send another user's REMOVE and we'd delete their
      // playlist row (kilter_id is globally unique, so the WHERE
      // alone would match the other user's playlist). The EXISTS
      // subquery against playlist_ownership locks the delete to rows
      // we have an ownership edge for.
      await tx
        .delete(playlists)
        .where(
          and(
            eq(playlists.kilterId, op.object_id),
            sql`EXISTS (SELECT 1 FROM ${playlistOwnership} WHERE ${playlistOwnership.playlistId} = ${playlists.id} AND ${playlistOwnership.userId} = ${userId})`,
          ),
        );
      // playlist_climbs + playlist_ownership cascade via FK on
      // playlist_id; nothing else to clean up here.
      continue;
    }

    const raw = op.data as RawCircuit | undefined;
    if (!raw) continue;

    const playlistUuid = randomUUID();
    const now = new Date();

    // Upsert playlist row keyed on kilter_id, return the bigserial id so
    // we can attach climbs + ownership.
    const upserted = await tx
      .insert(playlists)
      .values({
        uuid: playlistUuid,
        boardType: KILTER_BOARD_TYPE,
        layoutId: null,
        name: raw.name,
        description: raw.description ?? null,
        isPublic: !!raw.is_public,
        color: raw.color ?? null,
        kilterType: 'circuits',
        kilterId: raw.circuit_uuid,
        kilterSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: playlists.kilterId,
        set: {
          name: raw.name,
          description: raw.description ?? null,
          isPublic: !!raw.is_public,
          color: raw.color ?? null,
          kilterSyncedAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: playlists.id });

    const playlistId = upserted[0]?.id;
    if (playlistId === undefined) continue;

    // Ensure ownership row exists. Idempotent: unique on
    // (playlist_id, user_id) keeps repeated syncs safe.
    await tx.insert(playlistOwnership).values({ playlistId, userId, role: 'owner' }).onConflictDoNothing();

    // Diff existing vs incoming so we only touch playlist_climbs when
    // the snapshot actually changed. Avoids the wipe-and-reinsert churn
    // that masked unchanged playlists.
    const climbs = climbsByCircuit.get(raw.circuit_uuid) ?? [];
    const incoming = climbs
      .map((c, idx) => ({ raw: c, position: c.position ?? idx }))
      .sort((a, b) => a.position - b.position);

    const existing = await tx
      .select({ climbUuid: playlistClimbs.climbUuid, position: playlistClimbs.position })
      .from(playlistClimbs)
      .where(eq(playlistClimbs.playlistId, playlistId))
      .orderBy(playlistClimbs.position);

    // Resolve incoming canonicals up front so the comparison is apples
    // to apples (existing rows already store canonical UUIDs).
    //
    // Sequential, NOT Promise.all: this loop runs inside a Drizzle
    // transaction, which means every query rides the same single
    // connection. PgBouncer in transaction-pooling mode (our prod
    // shape; `prepare: false` is set on the client) cannot multiplex
    // parallel queries on one transaction connection — issuing them in
    // parallel either errors out or produces interleaved results.
    // Cache hits are already O(1) Map lookups; only the misses go to
    // the DB, and they're cheap.
    const incomingResolved: Array<{ climbUuid: string; angle: number | null; position: number }> = [];
    for (const i of incoming) {
      incomingResolved.push({
        climbUuid: await resolveCanonicalClimbUuid(tx, KILTER_BOARD_TYPE, i.raw.climb_uuid, aliasCache),
        angle: i.raw.angle ?? null,
        position: i.position,
      });
    }

    const sameLength = existing.length === incomingResolved.length;
    const allEqual =
      sameLength &&
      existing.every(
        (e, i) => e.climbUuid === incomingResolved[i].climbUuid && e.position === incomingResolved[i].position,
      );

    if (allEqual) continue;

    await tx.delete(playlistClimbs).where(eq(playlistClimbs.playlistId, playlistId));

    if (incomingResolved.length > 0) {
      const rows = incomingResolved.map((r) => ({
        playlistId,
        climbUuid: r.climbUuid,
        angle: r.angle,
        position: r.position,
      }));
      // Insert in chunks of 500 to keep statement size bounded — the same
      // 65535-parameter ceiling aurora-sync respects.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx
          .insert(playlistClimbs)
          .values(rows.slice(i, i + CHUNK))
          .onConflictDoNothing();
      }
    }
  }
}
