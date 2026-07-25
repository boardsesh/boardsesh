import { randomUUID } from 'crypto';
import { and, eq, exists, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import {
  boardseshTicks,
  playlists,
  playlistClimbs,
  playlistOwnership,
  boardClimbRatings,
  boardClimbAliases,
} from '@boardsesh/db/schema';
import {
  resolveCanonicalClimbUuid,
  recomputeClimbStatsBulk,
  inferUserUtcOffsetSeconds,
  adoptionMatchScoreSeconds,
  MAX_USER_UTC_OFFSET_SECONDS,
  foreignPlaylistOwnerGuard,
  myPlaylistOwnerEdge,
  selectUpstreamPlaylistOwners,
  type ClimbStatsKey,
  type TickTimeSample,
} from '@boardsesh/db/queries';

import {
  resolveUpstreamPlaylistWrite,
  canWriteUpstreamPlaylist,
  upstreamPlaylistSkipLogLine,
  type UpstreamPlaylistWriteDecision,
} from '@boardsesh/sync-runtime';

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
 * How far to widen the natural-key fetch window. Pre-PR4 Aurora/JSON originals
 * store the user's LOCAL wall time relabelled as UTC, so they sit a whole UTC
 * offset (up to ±14h) away from the honest-UTC Kilter created_at. Fetch that
 * whole span so the shifted original is a candidate; the JS match still pins
 * acceptance to ±60s of the inferred offset.
 */
const NATURAL_KEY_FETCH_WINDOW_SECONDS = MAX_USER_UTC_OFFSET_SECONDS + NATURAL_KEY_TIME_TOLERANCE_SECONDS;

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

export type SyncKilterUserDataResult = {
  /** @see ApplyCircuitsResult.skippedForeignCircuits */
  skippedForeignCircuits: number;
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
    // The Kilter access token's `aud` is the resource it's scoped to —
    // `["kilter", "account"]`. Enforcing `expectedAudience: 'kilter'`
    // alongside the realm `iss` + signature + `exp` check rejects a
    // token minted for a different resource/client on the same realm
    // (e.g. an `account`-only token) that would otherwise pass iss+sig.
    const { sub } = await verifyKeycloakToken(accessToken, { expectedAudience: 'kilter' });
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
}: SyncKilterUserDataArgs): Promise<SyncKilterUserDataResult> {
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

  return db.transaction((tx) => applyCircuits(tx, userId, buffer.circuits, filteredCircuitClimbs, aliasCache, log));
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

/** An existing tick found by kilter_id — the columns the edit guard compares. */
type ExistingKilterTick = {
  uuid: string;
  kilterId: string | null;
  ownerUserId: string;
  climbUuid: string;
  angle: number;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  climbedAt: string;
  kilterType: 'attempts' | 'logs' | null;
  updatedAt: string;
  kilterSyncedAt: string | null;
};

/** True when the row carries a local edit newer than the last successful sync. */
function isLocallyEditedSinceKilterSync(stored: ExistingKilterTick): boolean {
  if (stored.kilterSyncedAt === null) return false; // never synced from Kilter → Kilter is authoritative
  return Date.parse(stored.updatedAt) > Date.parse(stored.kilterSyncedAt);
}

/** True when an incoming Kilter payload actually differs from the stored row. */
function kilterPayloadDiffers(incoming: LogTickFields, stored: ExistingKilterTick): boolean {
  return (
    incoming.climbUuid !== stored.climbUuid ||
    incoming.angle !== stored.angle ||
    incoming.status !== stored.status ||
    incoming.attemptCount !== stored.attemptCount ||
    incoming.kilterType !== stored.kilterType ||
    Date.parse(incoming.climbedAt) !== Date.parse(stored.climbedAt)
  );
}

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

  // Distinct (climb, angle) keys touched this flush — inserts, updates,
  // adoptions, and soft-detached removes can all change what
  // board_climb_stats should show, so recompute every one at the end.
  const touchedKeys = new Map<string, ClimbStatsKey>();
  const addTouchedKey = (climbUuid: string, angle: number) => {
    touchedKeys.set(`${climbUuid} ${angle}`, { boardType: KILTER_BOARD_TYPE, climbUuid, angle });
  };

  const removeIds: string[] = [];
  const puts: PowerSyncOp[] = [];
  for (const op of ops) {
    if (op.op === 'REMOVE') {
      // PowerSync REMOVE ops carry no `data`, only `object_id`. For the
      // `logs` object_type that object_id IS the row's primary key,
      // `log_uuid` — the same value PUT ops carry as `op.data.log_uuid` and
      // that we write into `kilter_id`. So matching the soft-detach below on
      // `kilter_id IN (object_ids)` is correct. This equivalence
      // (object_id === data.log_uuid) is the one PowerSync-protocol
      // assumption the dedup + insert paths also rely on; if it ever broke,
      // REMOVE matching and the dedup key would silently drift.
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
    const removed = await tx
      .update(boardseshTicks)
      .set({
        kilterId: null,
        kilterType: null,
        kilterSyncedAt: null,
        kilterSyncError: null,
        // Mark the row upstream-deleted. Clearing kilter_id alone would make it
        // look never-pushed — push-back would re-push it (echo loop) and the
        // recompute would keep counting it. The marker (excluded from both) is
        // reset if a later PUT re-links the same log (adoption path below).
        kilterDetachedAt: new Date().toISOString(),
        // boardsesh_ticks.updated_at is `timestamp({ mode: 'string' })`
        // in the schema, so the writer must hand drizzle an ISO string,
        // not a Date.
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(boardseshTicks.userId, userId), inArray(boardseshTicks.kilterId, removeIds)))
      .returning({ climbUuid: boardseshTicks.climbUuid, angle: boardseshTicks.angle });
    for (const row of removed) addTouchedKey(row.climbUuid, row.angle);
  }

  if (puts.length === 0) {
    await recomputeClimbStatsBulk(tx, [...touchedKeys.values()]);
    return;
  }

  // PowerSync's oplog can carry MORE THAN ONE op for the same row
  // (object_id = log_uuid) within a single snapshot — an edited or
  // re-logged climb surfaces as several PUTs with ascending op_id. The
  // reference PowerSync client collapses these into a local table keyed by
  // id; our hand-rolled stream (api/powersync-client.ts) forwards every op
  // verbatim, so we dedupe here. Keyed by log_uuid, last-op-wins (later
  // op_id = freshest state, and logs ride a single bucket so buffer order
  // is op_id order), mirroring the conflict-key dedupe in
  // applyClimbRatings. Without this, two PUTs for the same log_uuid both
  // reach the INSERT below carrying the same kilter_id and violate the
  // GLOBAL boardsesh_ticks_kilter_id_unique index, aborting the flush.
  const dedupedPutsByLogUuid = new Map<string, PowerSyncOp>();
  for (const op of puts) {
    dedupedPutsByLogUuid.set((op.data as RawLog).log_uuid, op);
  }
  const dedupedPuts = Array.from(dedupedPutsByLogUuid.values());

  const now = new Date().toISOString();
  const normalised: NormalisedLog[] = [];
  for (const op of dedupedPuts) {
    const raw = op.data as RawLog;
    const canonical = await resolveCanonicalClimbUuid(tx, KILTER_BOARD_TYPE, raw.climb_uuid, aliasCache);
    normalised.push({ raw, canonical, fields: buildLogTickFields(raw, canonical, now) });
  }

  // (a) One GLOBAL SELECT (deliberately NOT user-scoped) to find ticks
  // already present by kilter_id. boardsesh_ticks_kilter_id_unique is a
  // GLOBAL unique index, so a given kilter_id lives on at most one row
  // table-wide. Efficiency depends on that index being on `kilter_id`
  // ALONE (not a composite): the IN-list probe is index-served and returns
  // ≤1 row per kilter_id, so dropping the user_id filter doesn't turn this
  // into a scan. Partition the hits by owner:
  //   - same user  → kilterIdMap, the idempotent re-sync UPDATE path.
  //   - other user → foreignKilterIds. The same Kilter account is linked
  //     to two Boardsesh accounts (duplicate-account / "linked but empty"
  //     shape). Inserting those incoming logs would collide on the global
  //     unique index and abort the whole flush; we must also NOT silently
  //     drop or reassign them onto the other user. We skip-and-log in the
  //     categorise step below so the situation is visible, not a crash.
  const incomingKilterIds = normalised.map((n) => n.raw.log_uuid);
  // Explicit empty-guard: drizzle's inArray([]) emits invalid `IN ()` SQL
  // that throws at the DB. incomingKilterIds is non-empty here (puts.length
  // === 0 returned above, and normalised mirrors dedupedPuts 1:1), so this is
  // belt-and-suspenders that keeps the invariant local and robust to a future
  // refactor that could thin `normalised` between here and the early return.
  if (incomingKilterIds.length === 0) return;
  // Select the compared columns + sync-tracking timestamps so the categorise
  // step can apply the edit-clobber guard (skip a locally-edited row) and skip
  // no-op re-syncs (payload unchanged) — see §work-item 7.
  const byKilterIdRows = await tx
    .select({
      uuid: boardseshTicks.uuid,
      kilterId: boardseshTicks.kilterId,
      ownerUserId: boardseshTicks.userId,
      climbUuid: boardseshTicks.climbUuid,
      angle: boardseshTicks.angle,
      status: boardseshTicks.status,
      attemptCount: boardseshTicks.attemptCount,
      climbedAt: boardseshTicks.climbedAt,
      kilterType: boardseshTicks.kilterType,
      updatedAt: boardseshTicks.updatedAt,
      kilterSyncedAt: boardseshTicks.kilterSyncedAt,
    })
    .from(boardseshTicks)
    .where(inArray(boardseshTicks.kilterId, incomingKilterIds));
  const kilterIdMap = new Map<string, ExistingKilterTick>();
  const foreignKilterIds = new Set<string>();
  for (const row of byKilterIdRows) {
    if (!row.kilterId) continue;
    if (row.ownerUserId === userId) {
      kilterIdMap.set(row.kilterId, row);
    } else {
      foreignKilterIds.add(row.kilterId);
    }
  }

  // (b) For rows not found in (a), one SELECT against the natural-key
  // set. We over-fetch by (user, board, climb_uuid IN …, angle IN …,
  // climbed_at BETWEEN …) and match (climb_uuid, angle, |Δt| ≤ N) in
  // JS — Postgres can't easily express the multi-column tuple match
  // alongside the time-range predicate without disabling index use, and
  // the post-filter is cheap.
  // Exclude foreignKilterIds too: a log_uuid already owned by another user
  // must not adopt one of THIS user's ticks either — the UPDATE would stamp
  // a globally-taken kilter_id and collide. Those fall through to the
  // skip-and-log branch in the categorise step.
  const naturalKeyCandidates = normalised.filter(
    (n) => !kilterIdMap.has(n.raw.log_uuid) && !foreignKilterIds.has(n.raw.log_uuid),
  );
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
        status: boardseshTicks.status,
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
          //
          // ⚠️ The window is widened by the MAX PLAUSIBLE UTC OFFSET (±14h),
          // not just ±tolerance: a pre-PR4 Aurora/JSON original stored the
          // user's LOCAL wall time relabelled as UTC, so it sits a whole
          // offset away from the Kilter created_at. Without the wide fetch the
          // shifted original is never returned and the adoption inserts a
          // duplicate — the 3,208-duplicate bug. The JS match below still
          // pins acceptance to ±60s of the inferred offset.
          // make_interval keeps the window parameterised — sql.raw on a numeric
          // constant is safe today but becomes injection-prone the moment the
          // constant becomes runtime-configurable.
          sql`${boardseshTicks.climbedAt}::timestamptz BETWEEN (${minTs}::timestamptz - make_interval(secs => ${NATURAL_KEY_FETCH_WINDOW_SECONDS})) AND (${maxTs}::timestamptz + make_interval(secs => ${NATURAL_KEY_FETCH_WINDOW_SECONDS}))`,
        ),
      );

    // Infer the user's UTC offset from the ticks that line up (same canonical
    // climb + angle) so a whole-offset gap between the honest-UTC Kilter
    // created_at and a pre-fix, shifted existing climbed_at still adopts. Post-
    // PR4 both sides are honest UTC → offset rounds to 0 → the ±60s fast path.
    const existingSamples: TickTimeSample[] = candidateRows.map((r) => ({
      climbUuid: r.climbUuid,
      angle: r.angle,
      climbedAtMs: Date.parse(r.climbedAt),
    }));
    const incomingSamples: TickTimeSample[] = parseable.map((n) => ({
      climbUuid: n.canonical,
      angle: n.raw.angle,
      climbedAtMs: Date.parse(n.raw.created_at),
    }));
    const inferredOffsetSeconds = inferUserUtcOffsetSeconds(existingSamples, incomingSamples);

    // Match in JS by (climb_uuid, angle) and a timestamp gap within ±60s of
    // either 0 (fast path) or the inferred offset. The over-fetch is bounded by
    // the batch's combined climb/angle/time envelope.
    //
    // Each existing tick can adopt AT MOST ONE incoming log. Two logs
    // for the same canonical climb+angle within tolerance (a re-logged
    // attempt, or a server-side merge artefact) would otherwise both
    // match the same row — both become adoptions with the same target
    // uuid, the bulk UPDATE…FROM applies only one (arbitrary winner),
    // and the loser is lost forever (next cycle it hits divergent-skip).
    // `claimed` reserves a matched uuid so a second log skips it and
    // falls through to the INSERT path, getting its own tick.
    const claimed = new Set<string>();
    for (const candidate of naturalKeyCandidates) {
      const target = Date.parse(candidate.raw.created_at);
      // Pick the CLOSEST eligible existing row, not the first one in arbitrary
      // DB order. adoptionMatchScoreSeconds ranks an honest same-instant
      // (fast-path) candidate ahead of any offset-distant one, so a
      // shifted-history user with two distinct same-(climb, angle) ascents links
      // this log to the true same-instant row instead of merging the
      // offset-distant DISTINCT ascent that also happens to fall within the
      // ±60s-of-offset window.
      let match: { uuid: string; kilterId: string | null } | null = null;
      let bestScore = Infinity;
      for (const r of candidateRows) {
        if (claimed.has(r.uuid)) continue;
        if (r.climbUuid !== candidate.canonical) continue;
        if (r.angle !== candidate.raw.angle) continue;
        // Status-aware adoption: the natural key (climb_uuid, angle, ±Δt)
        // ignores status, so without this guard an incoming `attempt`
        // logged within tolerance of an existing completion would adopt
        // and DOWNGRADE it (send/flash → attempt) via the bulk UPDATE.
        // Refuse that one direction: leave the completion unclaimed so the
        // attempt inserts as its own tick. Upgrades (incoming send/flash
        // onto an existing attempt) and same-status re-syncs still adopt.
        if (candidate.fields.status === 'attempt' && (r.status === 'send' || r.status === 'flash')) continue;
        const score = adoptionMatchScoreSeconds(Date.parse(r.climbedAt), target, inferredOffsetSeconds);
        if (score === null || score >= bestScore) continue;
        bestScore = score;
        match = { uuid: r.uuid, kilterId: r.kilterId };
      }
      if (match) {
        claimed.add(match.uuid);
        naturalKeyMatchesByKey.set(candidate.raw.log_uuid, match);
      }
    }
  }

  // (c) Categorise: update-by-kilter-id, adopt-on-natural-key, skip-
  // divergent, insert.
  const updatesByKilterId: Array<{ uuid: string; fields: LogTickFields }> = [];
  const adoptions: Array<{ uuid: string; kilterId: string; fields: LogTickFields }> = [];
  const inserts: NormalisedLog[] = [];

  for (const n of normalised) {
    const existing = kilterIdMap.get(n.raw.log_uuid);
    if (existing) {
      // Re-sync by kilter_id: this row IS the same Kilter log (matched on
      // its surrogate key), so Kilter is authoritative and its edits flow
      // through verbatim — INCLUDING a status change (e.g. the user un-topped
      // a climb on Kilter, send → attempt). The status-downgrade guard at
      // the natural-key match above is deliberately NOT applied here: that
      // guard protects a *heuristic* (climb+angle+time) match from merging a
      // distinct physical attempt onto a completion; it must not block a
      // genuine edit to an already-linked row. Don't "fix" this by adding the
      // guard here — see the re-sync test asserting an attempt updates a send.
      //
      // Edit-clobber guard (§work-item 7): don't overwrite a row the user
      // edited locally since the last sync (updated_at > kilter_synced_at) —
      // the local edit is pending push-back and Kilter's stale snapshot must
      // not stomp it. And skip a no-op re-sync (payload identical) so we don't
      // churn updated_at / re-ship the row to offline clients for nothing.
      if (isLocallyEditedSinceKilterSync(existing)) continue;
      if (!kilterPayloadDiffers(n.fields, existing)) continue;
      updatesByKilterId.push({ uuid: existing.uuid, fields: n.fields });
      continue;
    }
    if (foreignKilterIds.has(n.raw.log_uuid)) {
      // This Kilter log already belongs to a DIFFERENT Boardsesh user —
      // the same Kilter account is linked to two Boardsesh accounts.
      // Inserting it would violate the global kilter_id unique index;
      // adopting it would stamp a globally-taken kilter_id. Skip and log
      // so the duplicate-account link is visible instead of crashing the
      // flush or silently producing a "linked but empty" logbook.
      log(
        `[kilter-sync] kilter_id ${n.raw.log_uuid} already linked to a different Boardsesh user — skipping for user ${userId} (duplicate Kilter account link)`,
      );
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
    // A Kilter-side edit can MOVE a log to a different climb/angle. The new
    // key is collected below from `normalised`, but the row's PRIOR key also
    // changes count — capture it before the UPDATE so both get recomputed.
    const priorKeyResult = await tx.execute(sql`
      SELECT DISTINCT t.climb_uuid, t.angle
        FROM boardsesh_ticks t
        JOIN jsonb_to_recordset(${payload}::jsonb) AS u(uuid text) ON t.uuid = u.uuid
    `);
    const priorKeys = (Array.isArray(priorKeyResult) ? priorKeyResult : []) as Array<{
      climb_uuid: string;
      angle: number;
    }>;
    for (const row of priorKeys) addTouchedKey(row.climb_uuid, Number(row.angle));
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
        -- Re-linking a log clears the upstream-deleted marker: a REMOVE-then-PUT
        -- snapshot redelivery detaches (sets kilter_detached_at) then re-adopts,
        -- and the adopted row is live again. A plain kilter_id re-sync (already
        -- linked, never detached) leaves it NULL — a harmless no-op.
        kilter_detached_at = NULL,
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
        // Freshly pulled from the user's Kilter logbook — already inside
        // upstream_ascensionist_count. (Adoptions/updates keep the existing
        // row's origin, so a native tick that adopts a kilter_id stays
        // native and keeps counting.)
        origin: 'kilter_pull' as const,
        quality: null,
        difficulty: null,
        isBenchmark: false,
        comment: '',
        kilterId: n.raw.log_uuid,
      })),
    );
  }

  // Recompute board_climb_stats for every (climb, angle) this flush touched —
  // new pulls, status changes on updates/adoptions, and removed rows.
  for (const n of normalised) addTouchedKey(n.canonical, n.raw.angle);
  await recomputeClimbStatsBulk(tx, [...touchedKeys.values()]);
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
/**
 * Kilter's per-user climb rating is a 1-5 star value; it also sends 0 to mean
 * "cleared / no opinion". board_climb_ratings has a CHECK (rating IS NULL OR
 * 1..5), so a raw 0 (or any out-of-range value) aborts the whole ratings batch
 * insert and permanently fails that user's sync. Map anything outside 1-5 to
 * NULL ("unrated") so the row is accepted. Exported for unit testing.
 */
export function sanitizeKilterRating(rating: number | null | undefined): number | null {
  if (rating == null) return null;
  const value = Number(rating);
  if (!Number.isFinite(value) || value < 1 || value > 5) return null;
  return value;
}

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
    // Ratings HARD-delete on REMOVE, unlike logs which SOFT-detach (see
    // the long REMOVE comment in applyLogs). The asymmetry is safe here
    // for two reasons:
    //   1. The DELETE is scoped to kilter_id IN (removeIds), so it only
    //      removes kilter-origin rows. Boardsesh-origin ratings have a
    //      NULL kilter_id and never match this predicate — they survive.
    //   2. On PowerSync snapshot re-delivery (REMOVE-before-PUT), the
    //      upsert below re-inserts the kilter-origin row via its
    //      natural-key conflict target, so the round-trip is lossless.
    // Unlike a tick, a rating carries no promoted Boardsesh-side state
    // (no attempt→send promotion, party-session links, computed fields)
    // that a delete-then-reinsert would destroy — the row is fully
    // reconstructable from the next PUT, so soft-detach buys nothing.
    await tx
      .delete(boardClimbRatings)
      .where(and(eq(boardClimbRatings.userId, userId), inArray(boardClimbRatings.kilterId, removeIds)));
  }

  if (puts.length === 0) return;

  // Dedupe by the conflict key (board_type, climb_uuid, angle, user_id)
  // BEFORE the upsert. Distinct source UUIDs can alias to one canonical
  // climb_uuid (resolveCanonicalClimbUuid), so two PUTs at the same
  // angle+user can collapse to the same conflict key. Postgres rejects
  // an ON CONFLICT DO UPDATE that touches the same target row twice in
  // one statement ("command cannot affect row a second time"), which
  // would abort the whole ratings flush. Last write wins — PowerSync
  // delivers a full snapshot per cycle, so within one batch the final
  // PUT carries the freshest state.
  const valuesByConflictKey = new Map<string, typeof boardClimbRatings.$inferInsert>();
  for (const op of puts) {
    const raw = op.data as RawClimbRating;
    const canonical = await resolveCanonicalClimbUuid(tx, KILTER_BOARD_TYPE, raw.climb_uuid, aliasCache);
    valuesByConflictKey.set(`${KILTER_BOARD_TYPE}:${canonical}:${raw.angle}:${userId}`, {
      boardType: KILTER_BOARD_TYPE,
      climbUuid: canonical,
      angle: raw.angle,
      userId,
      // Kilter sends 0 for "cleared"; the DB CHECK only allows NULL or 1-5, so
      // a raw 0 would abort the whole batch. sanitizeKilterRating maps it (and
      // any other out-of-range value) to NULL.
      rating: sanitizeKilterRating(raw.rating),
      difficultyGradeId: raw.difficulty_grade_id,
      comment: raw.comment ?? '',
      // Kilter's per-rating payload doesn't carry a `weight`; the field
      // lives on the aggregated /api/logs response, not the rating row
      // itself. Leave null for kilter-origin rows.
      weight: null,
      kilterId: raw.climb_rating_uuid,
    });
  }
  const values = Array.from(valuesByConflictKey.values());

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

export type ApplyCircuitsResult = {
  /**
   * Circuits refused because their playlist belongs to another Boardsesh user
   * (or is already cross-linked). Non-zero means one Kilter account is linked
   * to two Boardsesh accounts; the runner turns it into a user-facing
   * `sync_error` so the second user isn't left staring at an empty, silent
   * playlist list.
   */
  skippedForeignCircuits: number;
};

/** Every circuit uuid this batch references, PUT (payload) or REMOVE (object_id). */
function collectCircuitUuids(circuitOps: PowerSyncOp[]): string[] {
  const uuids = new Set<string>();
  for (const op of circuitOps) {
    if (op.op === 'REMOVE') {
      uuids.add(op.object_id);
      continue;
    }
    const raw = op.data as RawCircuit | undefined;
    if (raw?.circuit_uuid) uuids.add(raw.circuit_uuid);
  }
  return Array.from(uuids);
}

export async function applyCircuits(
  tx: DrizzleDb,
  userId: string,
  circuitOps: PowerSyncOp[],
  circuitClimbOps: PowerSyncOp[],
  aliasCache: Map<string, string>,
  log: (message: string) => void = (msg) => console.warn(msg),
): Promise<ApplyCircuitsResult> {
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

  // One GLOBAL owner lookup for every circuit uuid this batch touches, PUTs
  // and REMOVEs alike. Deliberately NOT user-scoped: `playlists_kilter_id_idx`
  // is a global unique index, so a circuit uuid resolves to at most one
  // playlist row table-wide and the whole point is to find out WHOSE. Without
  // it the `ON CONFLICT (kilter_id) DO UPDATE` below silently lands on another
  // Boardsesh user's playlist when one Kilter account is linked to two
  // Boardsesh accounts, and the ownership insert then hands this user an
  // `owner` edge on it (#3526). Same partition-and-skip shape applyLogs uses
  // for foreignKilterIds.
  const ownersByCircuitUuid = await selectUpstreamPlaylistOwners(
    tx,
    playlists.kilterId,
    collectCircuitUuids(circuitOps),
  );
  // Distinct circuit uuids, not ops: a batch can carry several ops for one
  // circuit, and counting each would inflate the number the runner logs.
  const refusedCircuitUuids = new Set<string>();

  const decisionFor = (circuitUuid: string): UpstreamPlaylistWriteDecision =>
    resolveUpstreamPlaylistWrite(ownersByCircuitUuid.get(circuitUuid) ?? [], userId);

  const refuse = (circuitUuid: string, decision: UpstreamPlaylistWriteDecision): void => {
    refusedCircuitUuids.add(circuitUuid);
    log(
      upstreamPlaylistSkipLogLine({
        syncTag: 'kilter-sync',
        upstreamIdColumn: 'kilter_id',
        upstreamId: circuitUuid,
        syncingUserId: userId,
        decision,
      }),
    );
  };

  for (const op of circuitOps) {
    if (op.op === 'REMOVE') {
      // Sole-ownership gate. The EXISTS below only asks "do I have an
      // ownership row", which passes for BOTH co-owners of an already
      // cross-linked playlist — so either user's circuit delete would destroy
      // the other's playlist (#3526, and the 44 legacy rows on #3541). Require
      // `own`: exactly one owner, and it's us.
      const decision = decisionFor(op.object_id);
      if (decision !== 'own') {
        if (decision !== 'adopt') refuse(op.object_id, decision);
        // `adopt` here means we never had this playlist (nothing to delete) —
        // not a duplicate-account situation, so it isn't counted or logged.
        continue;
      }
      // Only delete the playlist when *this* user solely owns it. REMOVE ops
      // don't carry the data payload, so the buffer-time user_uuid guard can't
      // filter them — a server-side scope drift could otherwise send another
      // user's REMOVE and we'd delete their playlist row (kilter_id is globally
      // unique, so the WHERE alone would match it).
      //
      // Two correlated subqueries, both statement-time re-checks of what the
      // `decision` gate above already read inside this transaction. They are
      // the race guard: a concurrent claim landing between the owner SELECT and
      // this DELETE must not let us destroy a row we don't solely own.
      //   - exists(my owner edge): I still own it.
      //   - foreignPlaylistOwnerGuard: nobody ELSE owns it. Without this half
      //     the DELETE is strictly weaker than the upsert's guard — a
      //     co-owner's freshly inserted edge wouldn't stop us cascading their
      //     playlist_climbs away.
      await tx
        .delete(playlists)
        .where(
          and(
            eq(playlists.kilterId, op.object_id),
            exists(myPlaylistOwnerEdge(userId)),
            foreignPlaylistOwnerGuard(userId),
          ),
        );
      // playlist_climbs + playlist_ownership cascade via FK on
      // playlist_id; nothing else to clean up here.
      //
      // Keep the in-memory owner map in step with what we just did. It was
      // snapshotted before the loop, and one batch can legitimately carry both
      // a PUT and a REMOVE for the same circuit_uuid (buffer.circuits preserves
      // wire order and isn't deduped). Without this, a PUT-then-REMOVE pair
      // would create the playlist and then read the stale 'adopt' decision on
      // the REMOVE, skip the delete, and leave a row upstream has tombstoned —
      // permanently, since PowerSync doesn't replay tombstones.
      ownersByCircuitUuid.delete(op.object_id);
      continue;
    }

    const raw = op.data as RawCircuit | undefined;
    if (!raw) continue;

    // Refuse the whole op — upsert, ownership grant AND the playlist_climbs
    // replace below — when this circuit's playlist belongs to someone else, or
    // is already cross-linked. Skipping only the upsert would still wipe the
    // other user's climbs at the delete-and-reinsert further down.
    const decision = decisionFor(raw.circuit_uuid);
    if (!canWriteUpstreamPlaylist(decision)) {
      refuse(raw.circuit_uuid, decision);
      continue;
    }

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
        // SQL-level twin of the `decision` gate above, evaluated at statement
        // time against the conflicting row. Closes the window the JS check
        // can't: two daemons syncing two Boardsesh users linked to the SAME
        // Kilter account both read "no playlist yet", both INSERT, and the
        // loser's ON CONFLICT adopts the winner's row. Widened by #3539 (no
        // cross-instance mutual exclusion), so it is load-bearing until that
        // lands. When it bites, DO UPDATE matches nothing, `.returning()` comes
        // back empty and the `playlistId === undefined` guard below skips the
        // op — the same outcome as the JS refusal, minus the log line.
        setWhere: foreignPlaylistOwnerGuard(userId),
      })
      .returning({ id: playlists.id });

    const playlistId = upserted[0]?.id;
    if (playlistId === undefined) continue;

    // Ensure ownership row exists. Idempotent: unique on
    // (playlist_id, user_id) keeps repeated syncs safe. Only reached once the
    // decision gate cleared this circuit as unowned or ours — this insert is
    // what handed a second Boardsesh user an `owner` edge in #3526.
    await tx.insert(playlistOwnership).values({ playlistId, userId, role: 'owner' }).onConflictDoNothing();

    // Keep the snapshotted owner map in step: we now own this circuit's
    // playlist. Matters when one batch carries a PUT and a later REMOVE for the
    // same circuit_uuid — the REMOVE's sole-owner gate has to see the edge this
    // PUT just created, or upstream's delete is silently dropped.
    ownersByCircuitUuid.set(raw.circuit_uuid, [userId]);

    // Diff existing vs incoming so we only touch playlist_climbs when
    // the snapshot actually changed. Avoids the wipe-and-reinsert churn
    // that masked unchanged playlists.
    const climbs = climbsByCircuit.get(raw.circuit_uuid) ?? [];
    const incoming = climbs
      .map((c, idx) => ({ raw: c, position: c.position ?? idx }))
      .sort((a, b) => a.position - b.position);

    const existing = await tx
      .select({ climbUuid: playlistClimbs.climbUuid, angle: playlistClimbs.angle, position: playlistClimbs.position })
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
        (e, i) =>
          e.climbUuid === incomingResolved[i].climbUuid &&
          e.angle === incomingResolved[i].angle &&
          e.position === incomingResolved[i].position,
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

  return { skippedForeignCircuits: refusedCircuitUuids.size };
}
