import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import {
  boardseshTicks,
  playlists,
  playlistOwnership,
  playlistClimbs,
  boardClimbRatings,
  boardClimbAliases,
} from '@boardsesh/db/schema';

import { KILTER_BOARD_TYPE } from '../api/types';
import type {
  LogPushItem,
  LogPushResult,
  RatingPushItem,
  RatingPushResult,
  CircuitPushItem,
  CircuitPushResult,
} from '../api/kilter-rest';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Push-back flow (Flow B.2 in design §4.2): send Boardsesh-recorded rows
 * that don't yet have a kilter_id over to Kilter and store the returned
 * UUIDs.
 *
 * Selection is on `kilter_id IS NULL`, INDEPENDENT of aurora_id — a tick
 * that started life as an Aurora row but belongs to a Kilter-linked
 * account still needs to land on the user's Kilter logbook.
 *
 * Each batch is independently committed. A partial push commits whatever
 * came back successfully so a transient REST failure mid-batch doesn't
 * cost us the rows that did go through. The PUT-back of kilter_id is
 * idempotent — re-running will skip rows that already have one.
 *
 * The full flow is gated behind KILTER_SYNC_PUSH_ENABLED=true: the POST
 * payload shapes for the three Kilter endpoints haven't been
 * wire-verified against a real account yet, and a wrong body would
 * silently create malformed rows upstream. Until traffic-capture
 * confirms the shapes the selection / alias / back-fill scaffolding
 * stays in place but never runs.
 */

export type PushBackArgs = {
  db: DrizzleDb;
  userId: string;
  accessToken: string;
  log?: (message: string) => void;
};

export async function pushKilterUserData({ db, userId, accessToken, log }: PushBackArgs): Promise<void> {
  if (process.env.KILTER_SYNC_PUSH_ENABLED !== 'true') {
    log?.(
      '[kilter-sync] push-back disabled — set KILTER_SYNC_PUSH_ENABLED=true to enable (wire shapes not yet verified)',
    );
    return;
  }

  await pushPendingTicks(db, userId, accessToken);
  await pushPendingRatings(db, userId, accessToken);
  await pushPendingCircuits(db, userId, accessToken);
}

/**
 * Pre-load every Kilter-origin alias for a batch of canonical UUIDs in a
 * single query. Returns a Map from canonical_uuid → kilter-origin
 * alias_uuid. Canonicals with no kilter-origin alias are absent from the
 * map; callers fall back to sending the canonical itself, which is fine
 * when the canonical was itself ingested from Kilter (it'll already be a
 * Kilter UUID).
 *
 * Replaces a per-row SELECT inside the push loop — at thousands of
 * pending ticks the N+1 cost was dominating push time. One round trip
 * regardless of batch size.
 */
async function buildKilterPushUuidMap(db: DrizzleDb, canonicalUuids: string[]): Promise<Map<string, string>> {
  if (canonicalUuids.length === 0) return new Map();
  const unique = Array.from(new Set(canonicalUuids));
  const rows = await db
    .select({
      aliasUuid: boardClimbAliases.aliasUuid,
      canonicalUuid: boardClimbAliases.canonicalUuid,
    })
    .from(boardClimbAliases)
    .where(
      and(
        eq(boardClimbAliases.boardType, KILTER_BOARD_TYPE),
        inArray(boardClimbAliases.canonicalUuid, unique),
        eq(boardClimbAliases.source, 'kilter'),
      ),
    );
  const map = new Map<string, string>();
  for (const r of rows) {
    // Multiple kilter-origin aliases per canonical can exist when the
    // dedup pipeline collapsed several duplicate UUIDs onto one row;
    // keep the first one — they're all valid Kilter UUIDs and the
    // ordering is stable across calls (insertion order on the table).
    if (!map.has(r.canonicalUuid)) map.set(r.canonicalUuid, r.aliasUuid);
  }
  return map;
}

function resolveKilterPushUuid(map: Map<string, string>, canonicalUuid: string): string {
  return map.get(canonicalUuid) ?? canonicalUuid;
}

/**
 * Placeholder thrown if the env gate is flipped on without a real REST
 * implementation behind these calls. The gate in pushKilterUserData
 * prevents these from running in normal operation; this exists so a
 * future enabler sees a loud, single source of truth pointing at the
 * thing that's still missing.
 */
function pushNotWired(endpoint: string): never {
  throw new Error(
    `[kilter-sync] KILTER_SYNC_PUSH_ENABLED=true but no REST implementation is wired for ${endpoint}. ` +
      'Wire it in packages/kilter-sync/src/api/kilter-rest.ts after capturing the upstream payload shape.',
  );
}

async function pushPendingTicks(db: DrizzleDb, userId: string, _accessToken: string): Promise<void> {
  const pending = await db
    .select()
    .from(boardseshTicks)
    .where(
      and(
        eq(boardseshTicks.userId, userId),
        eq(boardseshTicks.boardType, KILTER_BOARD_TYPE),
        isNull(boardseshTicks.kilterId),
      ),
    )
    .orderBy(boardseshTicks.climbedAt);

  if (pending.length === 0) return;

  // Single round trip to the alias table for every canonical we're about
  // to push — replaces the previous SELECT-per-tick N+1.
  const pushUuidMap = await buildKilterPushUuidMap(
    db,
    pending.map((t) => t.climbUuid),
  );

  // Index ticks by their UUID so we can resolve the kilter_type for each
  // result (logs vs attempts) in JS — no need to recompute the CASE in SQL.
  const ticksByUuid = new Map(pending.map((tick) => [tick.uuid, tick]));

  const items: LogPushItem[] = pending.map((tick) => ({
    clientReference: tick.uuid,
    climbUuid: resolveKilterPushUuid(pushUuidMap, tick.climbUuid),
    angle: tick.angle,
    topped: tick.status === 'flash' || tick.status === 'send',
    attemptCount: tick.attemptCount,
    quality: tick.quality ?? undefined,
    difficulty: tick.difficulty ?? undefined,
    isMirror: tick.isMirror ?? false,
    comment: tick.comment ?? undefined,
    climbedAt: tick.climbedAt,
  }));

  // Reaching here means the env gate is on but the wire implementation
  // hasn't been added yet — bail loudly so the daemon error log points
  // at the real gap. The annotated `results: LogPushResult[]` shape
  // below documents the structure the real implementation should
  // return; everything past `pushNotWired` is unreachable today and
  // exists as scaffolding for the eventual wire-up.
  if (items.length > 0) pushNotWired('POST /api/logs/bulk');
  const results: LogPushResult[] = [];

  if (results.length === 0) return;

  // Build the back-fill payload in JS: resolve logs/attempts per row from
  // the source tick's status, so the SQL side just consumes a typed
  // recordset without recomputing the CASE.
  const backfillRows = results
    .map((result) => {
      const tick = ticksByUuid.get(result.clientReference);
      if (!tick) return null;
      const kilterType: 'logs' | 'attempts' = tick.status === 'flash' || tick.status === 'send' ? 'logs' : 'attempts';
      return {
        client_reference: result.clientReference,
        log_uuid: result.logUuid,
        kilter_type: kilterType,
      };
    })
    .filter(
      (row): row is { client_reference: string; log_uuid: string; kilter_type: 'logs' | 'attempts' } => row !== null,
    );

  if (backfillRows.length === 0) return;

  // Wrap the back-fill in a transaction so a mid-loop abort can't leave
  // half the rows marked as synced — partial back-fill would re-push the
  // unmarked rows next cycle and create duplicates on Kilter. A single
  // bulk UPDATE against jsonb_to_recordset is one round trip vs. N.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE boardsesh_ticks
      SET
        kilter_id = j.log_uuid,
        kilter_type = j.kilter_type::kilter_table_type,
        kilter_synced_at = NOW(),
        kilter_sync_error = NULL,
        updated_at = NOW()
      FROM jsonb_to_recordset(${JSON.stringify(backfillRows)}::jsonb)
        AS j(client_reference text, log_uuid text, kilter_type text)
      WHERE boardsesh_ticks.uuid = j.client_reference
    `);
  });
}

async function pushPendingRatings(db: DrizzleDb, userId: string, _accessToken: string): Promise<void> {
  const pending = await db
    .select()
    .from(boardClimbRatings)
    .where(
      and(
        eq(boardClimbRatings.userId, userId),
        eq(boardClimbRatings.boardType, KILTER_BOARD_TYPE),
        isNull(boardClimbRatings.kilterId),
      ),
    );

  if (pending.length === 0) return;

  // Single round trip for all alias lookups (was per-rating SELECT).
  const pushUuidMap = await buildKilterPushUuidMap(
    db,
    pending.map((r) => r.climbUuid),
  );

  // Kilter's API doesn't expose a bulk variant — POST one at a time, but
  // fan them out under a small concurrency limit. 500 ratings × ~150ms RTT
  // sequential was ~75s wall; at 8-wide that's ~10s. settleAll captures
  // partial failures so a single 5xx in the middle doesn't lose the
  // successful pushes either side of it.
  const items: RatingPushItem[] = pending.map((rating) => ({
    clientReference: rating.id.toString(),
    climbUuid: resolveKilterPushUuid(pushUuidMap, rating.climbUuid),
    angle: rating.angle,
    rating: rating.rating ?? undefined,
    difficultyGradeId: rating.difficultyGradeId ?? undefined,
    comment: rating.comment ?? undefined,
  }));

  // Same stub shape as pushPendingTicks above: bail loudly when push
  // is gated on without a wire implementation, then the typed scaffold
  // documents what the real `await Promise.allSettled(...)` should
  // populate.
  if (items.length > 0) pushNotWired('POST /api/climb-rating/');
  const settled: Array<PromiseSettledResult<RatingPushResult>> = [];

  // Stringify the bigint id so JSON.stringify doesn't throw
  // `TypeError: Do not know how to serialize a BigInt` at the
  // back-fill step below. The SQL cast `id bigint` inside
  // jsonb_to_recordset converts the numeric string back to a bigint.
  // Same pattern as pushPendingCircuits below.
  const successful: Array<{ id: string; climb_rating_uuid: string }> = [];
  let firstError: unknown = null;
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      successful.push({
        id: pending[i].id.toString(),
        climb_rating_uuid: outcome.value.climbRatingUuid,
      });
    } else if (firstError === null) {
      firstError = outcome.reason;
    }
  }

  // Back-fill every successful push in a single transaction. Without this,
  // a daemon abort between updates would leave kilter_id unset on rows we
  // already pushed → next cycle re-POSTs them → duplicates on Kilter.
  if (successful.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE board_climb_ratings
        SET
          kilter_id = j.climb_rating_uuid,
          updated_at = NOW()
        FROM jsonb_to_recordset(${JSON.stringify(successful)}::jsonb)
          AS j(id bigint, climb_rating_uuid text)
        WHERE board_climb_ratings.id = j.id
      `);
    });
  }

  // Surface the first failure so the daemon notices, but only after we've
  // persisted the rows that did succeed.
  if (firstError !== null) {
    throw firstError;
  }
}

async function pushPendingCircuits(db: DrizzleDb, userId: string, _accessToken: string): Promise<void> {
  // Owner-scope: only push playlists this user owns, never push playlists
  // they're just a viewer/editor on. The role check happens at the
  // ownership join.
  const owned = await db
    .select({ playlist: playlists, ownership: playlistOwnership })
    .from(playlists)
    .innerJoin(playlistOwnership, eq(playlistOwnership.playlistId, playlists.id))
    .where(
      and(
        eq(playlistOwnership.userId, userId),
        eq(playlistOwnership.role, 'owner'),
        eq(playlists.boardType, KILTER_BOARD_TYPE),
        isNull(playlists.kilterId),
      ),
    );

  if (owned.length === 0) return;

  // Pre-fetch all playlist_climbs for every owned playlist in one query,
  // then group in memory — replaces a per-playlist SELECT inside the loop.
  const playlistIds = owned.map((r) => r.playlist.id);
  const allClimbs = await db
    .select({
      playlistId: playlistClimbs.playlistId,
      climbUuid: playlistClimbs.climbUuid,
      angle: playlistClimbs.angle,
      position: playlistClimbs.position,
    })
    .from(playlistClimbs)
    .where(inArray(playlistClimbs.playlistId, playlistIds))
    .orderBy(playlistClimbs.playlistId, playlistClimbs.position);

  const climbsByPlaylist = new Map<bigint, typeof allClimbs>();
  for (const c of allClimbs) {
    let list = climbsByPlaylist.get(c.playlistId);
    if (!list) {
      list = [];
      climbsByPlaylist.set(c.playlistId, list);
    }
    list.push(c);
  }

  // Single alias batch for every climb across every playlist.
  const pushUuidMap = await buildKilterPushUuidMap(
    db,
    allClimbs.map((c) => c.climbUuid),
  );

  const items: CircuitPushItem[] = owned.map((row) => {
    const climbsInOrder = climbsByPlaylist.get(row.playlist.id) ?? [];
    return {
      clientReference: row.playlist.id.toString(),
      name: row.playlist.name,
      description: row.playlist.description ?? undefined,
      color: row.playlist.color ?? undefined,
      icon: row.playlist.icon ?? undefined,
      climbs: climbsInOrder.map((c) => ({
        climbUuid: resolveKilterPushUuid(pushUuidMap, c.climbUuid),
        angle: c.angle,
        position: c.position,
      })),
    };
  });

  // Same stub shape as pushPendingTicks above: bail loudly when push
  // is gated on without a wire implementation, then the typed scaffold
  // documents what the real `await Promise.allSettled(...)` should
  // populate.
  if (items.length > 0) pushNotWired('POST /api/circuits');
  const settled: Array<PromiseSettledResult<CircuitPushResult>> = [];

  const successful: Array<{ id: string; circuit_uuid: string }> = [];
  let firstError: unknown = null;
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      successful.push({
        // Stringify the bigint so JSON.stringify doesn't choke; the SQL
        // cast back to bigint on the column happens inside jsonb_to_recordset.
        id: owned[i].playlist.id.toString(),
        circuit_uuid: outcome.value.circuitUuid,
      });
    } else if (firstError === null) {
      firstError = outcome.reason;
    }
  }

  // Atomic back-fill — same data-integrity argument as ticks/ratings: a
  // partial back-fill would re-create the same circuit on Kilter next cycle.
  if (successful.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE playlists
        SET
          kilter_id = j.circuit_uuid,
          kilter_type = 'circuits',
          kilter_synced_at = NOW(),
          updated_at = NOW()
        FROM jsonb_to_recordset(${JSON.stringify(successful)}::jsonb)
          AS j(id bigint, circuit_uuid text)
        WHERE playlists.id = j.id
      `);
    });
  }

  if (firstError !== null) {
    throw firstError;
  }
}
