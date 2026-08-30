import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  beginImmediateWrite,
  enqueue,
  getLocalUserId,
  runLocalWriteWithRetry,
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS,
  type EnqueueResult,
  type GraphQLFetch,
  type OfflineDatabase,
  type SqlValue,
  type SqlExecutor,
} from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../offline/offline-sync-adapter';
import { reportEnqueueSuppressed } from '../offline/outbox-telemetry';
import { localWriteRetryOptions } from '../offline/local-write-telemetry';
import { takeInjectedWriteFault } from '../offline/dev/write-fault-injection';
import type { SaveTickMutationVariables } from '../lib/graphql/operations';
import type {
  AddClimbToPlaylistInput,
  CreatePlaylistInput,
  GetPlaylistClimbsInput,
  GetTicksQueryResponse,
  Playlist,
  PlaylistClimbsResult,
  ReorderPlaylistClimbInput,
  RemoveClimbFromPlaylistInput,
  UpdatePlaylistInput,
  UpdateTickInput,
  UpdateTickResponse,
} from '@boardsesh/graphql/operations';
import { getClimbLocal } from '../db/queries/get-climb-local';

export type SaveTickInput = SaveTickMutationVariables['input'];
export type LocalWriteDelivery = 'account' | 'local-only';

export type FavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

function scheduleDrain(
  db: OfflineDatabase,
  queryClient: ReturnType<typeof useQueryClient>,
  graphqlFetch: GraphQLFetch,
) {
  void drainMutationQueue(db, queryClient, graphqlFetch).catch((error: unknown) => {
    if (__DEV__) {
      console.warn('[MutationQueue] drain failed after local write:', error);
    }
  });
}

/**
 * Run one local write through the shared retry ladder (issue #4315).
 *
 * Every write in this file is a single `withExclusiveTransactionAsync` task, so
 * losing the single-writer lock rolls back both the data row and the outbox row
 * it would have queued — the whole write vanishes and, for a tick, the send is
 * gone.
 *
 * The task opens IMMEDIATE rather than just arming `busy_timeout` (#4332). These
 * tasks read before they write — `getLocalUserId` for the owner stamp — and a
 * deferred transaction that reads first never reaches SQLite's busy handler when
 * it upgrades to a write, so the timeout was set and then ignored and a contended
 * tick died in about a millisecond. `beginImmediateWrite` takes the write lock up
 * front, which is the only way the wait below is real. Keep using it even in a
 * task that happens to write first today: the next person to add a read above the
 * INSERT would silently bring the bug back.
 *
 * Every statement inside `task` MUST be safe to re-run: a `SQLITE_BUSY` can
 * surface at COMMIT, so a retry can follow an attempt that actually landed.
 */
function runLocalWrite(
  db: OfflineDatabase,
  tableName: string,
  operation: 'create' | 'update' | 'delete',
  task: (txn: SqlExecutor) => Promise<void>,
  budgetMs?: number,
  reportTelemetry = true,
): Promise<void> {
  return runLocalWriteWithRetry(
    async (attempt) => {
      if (__DEV__) {
        const injectedFault = takeInjectedWriteFault('before-task');
        if (injectedFault) throw injectedFault;
      }
      await db.withExclusiveTransactionAsync(async (txn) => {
        // Own connection, busy_timeout defaults to 0, and expo's `BEGIN` is
        // DEFERRED — arm the timeout and take the write lock in one step, or a
        // held lock fails this offline write instantly (BOARDSESH-AB/AX, #4332).
        await beginImmediateWrite(
          txn,
          attempt === 1 ? OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS : OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
        );
        await task(txn);
      });
      if (__DEV__) {
        const injectedFault = takeInjectedWriteFault('after-commit');
        if (injectedFault) throw injectedFault;
      }
    },
    {
      ...(reportTelemetry ? localWriteRetryOptions(tableName, operation) : {}),
      ...(budgetMs === undefined ? {} : { budgetMs }),
    },
  );
}

export async function writeTickLocal(
  db: OfflineDatabase,
  input: SaveTickInput,
  tickUuid: string,
  budgetMs?: number,
  delivery: LocalWriteDelivery = 'account',
): Promise<void> {
  const now = new Date().toISOString();
  const climbedAt = input.climbedAt ?? now;
  const sessionId = input.sessionId ?? null;

  await runLocalWrite(
    db,
    'boardsesh_ticks',
    'create',
    async (txn) => {
      // Stamp the owner so a local reader's `(user_id = ? OR user_id IS NULL)`
      // predicate can tell this tick from a previous account's leftovers. Rows
      // written before this existed stay NULL, which the `IS NULL` arm covers —
      // that arm cannot be dropped until every such row has synced back down.
      const ownerUserId = await getLocalUserId(txn);
      if (delivery === 'local-only' && ownerUserId === null) {
        throw new Error('Local profile owner is not initialized');
      }
      // OR IGNORE so a retried attempt is a no-op against a row the previous
      // attempt already committed: a `SQLITE_BUSY` can surface at COMMIT, which
      // makes "the transaction landed and still threw" a real shape. `uuid` is
      // the PRIMARY KEY, and every other statement here is already idempotent.
      await txn.runAsync(
        `INSERT OR IGNORE INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status,
       attempt_count, quality, difficulty, comment, climbed_at, session_id, is_mirror, is_benchmark,
       created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tickUuid,
          ownerUserId,
          input.boardType,
          input.climbUuid,
          input.angle,
          input.status,
          input.attemptCount,
          input.quality ?? null,
          input.difficulty ?? null,
          input.comment,
          climbedAt,
          sessionId,
          input.isMirror ? 1 : 0,
          input.isBenchmark ? 1 : 0,
          now,
          now,
        ],
      );

      // No suppressed-enqueue check here, and that is a property of the key, not
      // an oversight: every tick gets a fresh uuid, so this INSERT OR IGNORE can
      // never collide with an existing row. A future tick key derived from
      // climb+angle would inherit the favorites blind spot below — re-check then.
      if (delivery === 'account') {
        await enqueue(txn, 'boardsesh_ticks', 'create', input, tickUuid);
      }
    },
    budgetMs,
    delivery === 'account',
  );
}

type LocalTickRow = {
  uuid: string;
  climb_uuid: string;
  angle: number;
  is_mirror: number | null;
  status: GetTicksQueryResponse['ticks'][number]['status'];
  attempt_count: number | null;
  quality: number | null;
  difficulty: number | null;
  is_benchmark: number | null;
  comment: string | null;
  climbed_at: string | null;
  created_at: string | null;
};

function toLocalTick(row: LocalTickRow): GetTicksQueryResponse['ticks'][number] {
  return {
    uuid: row.uuid,
    climbUuid: row.climb_uuid,
    angle: row.angle,
    isMirror: row.is_mirror === 1,
    status: row.status,
    attemptCount: row.attempt_count ?? 1,
    quality: row.quality,
    effectiveQuality: row.quality,
    difficulty: row.difficulty,
    boardseshDifficulty: null,
    boardseshConfidence: null,
    isBenchmark: row.is_benchmark === 1,
    comment: row.comment ?? '',
    climbedAt: row.climbed_at ?? row.created_at ?? new Date(0).toISOString(),
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
  };
}

const LOCAL_TICK_COLUMNS = `uuid, climb_uuid, angle, is_mirror, status, attempt_count, quality,
  difficulty, is_benchmark, comment, climbed_at, created_at`;

export async function getTicksLocal(
  db: OfflineDatabase,
  boardType: string,
  climbUuids: readonly string[],
): Promise<GetTicksQueryResponse['ticks']> {
  if (climbUuids.length === 0) return [];
  const ownerUserId = await getLocalUserId(db);
  const placeholders = climbUuids.map(() => '?').join(', ');
  const rows = await db.getAllAsync<LocalTickRow>(
    `SELECT ${LOCAL_TICK_COLUMNS}
     FROM boardsesh_ticks
     WHERE board_type = ?
       AND climb_uuid IN (${placeholders})
       AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)
     ORDER BY climbed_at DESC, created_at DESC`,
    [boardType, ...climbUuids, ownerUserId, ownerUserId],
  );
  return rows.map(toLocalTick);
}

async function getTickLocalByUuid(
  db: OfflineDatabase,
  tickUuid: string,
): Promise<GetTicksQueryResponse['ticks'][number] | null> {
  const ownerUserId = await getLocalUserId(db);
  const row = await db.getFirstAsync<LocalTickRow>(
    `SELECT ${LOCAL_TICK_COLUMNS}
     FROM boardsesh_ticks
     WHERE uuid = ? AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)`,
    [tickUuid, ownerUserId, ownerUserId],
  );
  return row ? toLocalTick(row) : null;
}

const UPDATE_TICK_COLUMN_BY_FIELD = {
  status: 'status',
  attemptCount: 'attempt_count',
  quality: 'quality',
  difficulty: 'difficulty',
  isBenchmark: 'is_benchmark',
  comment: 'comment',
  climbedAt: 'climbed_at',
  angle: 'angle',
} as const satisfies Record<keyof UpdateTickInput, string>;

export async function updateTickLocal(
  db: OfflineDatabase,
  tickUuid: string,
  input: UpdateTickInput,
  delivery: LocalWriteDelivery,
  idempotencyKey: string,
): Promise<UpdateTickResponse['updateTick'] | null> {
  const assignments: string[] = [];
  const parameters: SqlValue[] = [];
  for (const field of Object.keys(UPDATE_TICK_COLUMN_BY_FIELD) as Array<keyof UpdateTickInput>) {
    if (input[field] === undefined) continue;
    assignments.push(`${UPDATE_TICK_COLUMN_BY_FIELD[field]} = ?`);
    const fieldValue = input[field];
    parameters.push(typeof fieldValue === 'boolean' ? (fieldValue ? 1 : 0) : fieldValue);
  }
  assignments.push('updated_at = ?');
  const updatedAt = new Date().toISOString();
  parameters.push(updatedAt, tickUuid);

  await runLocalWrite(
    db,
    'boardsesh_ticks',
    'update',
    async (txn) => {
      const ownerUserId = await getLocalUserId(txn);
      await txn.runAsync(
        `UPDATE boardsesh_ticks SET ${assignments.join(', ')}
       WHERE uuid = ? AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)`,
        [...parameters, ownerUserId, ownerUserId],
      );
      if (delivery === 'account') {
        await enqueue(txn, 'boardsesh_ticks', 'update', { uuid: tickUuid, ...input }, idempotencyKey);
      }
    },
    undefined,
    delivery === 'account',
  );

  const tick = await getTickLocalByUuid(db, tickUuid);
  if (!tick) return null;
  return {
    uuid: tick.uuid,
    status: tick.status,
    attemptCount: tick.attemptCount,
    quality: tick.quality,
    difficulty: tick.difficulty,
    isBenchmark: tick.isBenchmark,
    comment: tick.comment,
    climbedAt: tick.climbedAt,
    angle: tick.angle,
    updatedAt,
  };
}

export async function deleteTickLocal(
  db: OfflineDatabase,
  tickUuid: string,
  delivery: LocalWriteDelivery,
  idempotencyKey: string,
): Promise<boolean> {
  let deleted = false;
  await runLocalWrite(
    db,
    'boardsesh_ticks',
    'delete',
    async (txn) => {
      const ownerUserId = await getLocalUserId(txn);
      const ownerParameters = [tickUuid, ownerUserId, ownerUserId];
      const existing = await txn.getFirstAsync<{ uuid: string }>(
        'SELECT uuid FROM boardsesh_ticks WHERE uuid = ? AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)',
        ownerParameters,
      );
      deleted = existing !== null;
      await txn.runAsync(
        'DELETE FROM boardsesh_ticks WHERE uuid = ? AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)',
        ownerParameters,
      );
      if (delivery === 'account') {
        await enqueue(txn, 'boardsesh_ticks', 'delete', { uuid: tickUuid }, idempotencyKey);
      }
    },
    undefined,
    delivery === 'account',
  );
  return deleted;
}

/**
 * Last-chance tick write: the outbox row ONLY, no `boardsesh_ticks` row (issue
 * #4315).
 *
 * Called when `writeTickLocal` has already lost the lock. A queued mutation is
 * self-contained — the drainer replays it from the payload alone — so an
 * outbox-only row is enough for the send to reach the server. It is also a
 * strictly smaller target than the full write: one `INSERT OR IGNORE`, no owner
 * read, at a later instant with its own (shorter) `busy_timeout`. It still opens
 * IMMEDIATE — `enqueue` reads the existing row before it decides what to write.
 *
 * No owner stamp is needed: the server derives ownership from the authenticated
 * call. What the user gives up is documented at the call site — no local tick
 * row means no "waiting to sync" badge, and the tick is missing from the local
 * logbook if the app is killed before it drains.
 *
 * The payload and key are byte-identical to what `writeTickLocal` would have
 * queued, so the drain path is unchanged.
 */
export async function enqueueTickOutboxOnly(
  db: OfflineDatabase,
  input: SaveTickInput,
  tickUuid: string,
  budgetMs: number,
): Promise<void> {
  await runLocalWriteWithRetry(
    async () => {
      await db.withExclusiveTransactionAsync(async (txn) => {
        await beginImmediateWrite(txn, OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS);
        await enqueue(txn, 'boardsesh_ticks', 'create', input, tickUuid);
      });
    },
    { ...localWriteRetryOptions('boardsesh_ticks', 'create'), maxAttempts: 2, budgetMs },
  );
}

export function favoriteAddKey(input: FavoriteInput): string {
  return `add:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export function favoriteRemoveKey(input: FavoriteInput): string {
  return `del:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`;
}

export async function getFavoriteClimbUuidsLocal(
  db: OfflineDatabase,
  boardName: string,
  angle: number,
): Promise<string[]> {
  const ownerUserId = await getLocalUserId(db);
  if (ownerUserId === null) throw new Error('Local profile owner is not initialized');
  const rows = await db.getAllAsync<{ climb_uuid: string }>(
    `SELECT climb_uuid FROM user_favorites
     WHERE board_name = ? AND angle = ? AND user_id = ?
     ORDER BY created_at DESC, climb_uuid ASC`,
    [boardName, angle, ownerUserId],
  );
  return rows.map(({ climb_uuid: climbUuid }) => climbUuid);
}

export async function addFavoriteLocal(
  db: OfflineDatabase,
  input: FavoriteInput,
  delivery: LocalWriteDelivery = 'account',
): Promise<void> {
  const now = new Date().toISOString();
  // Captured inside the transaction, reported after it commits: the report
  // reaches Sentry/PostHog, and neither belongs on a held write lock. A holder
  // object rather than a `let` because TypeScript doesn't track assignments made
  // inside a callback.
  const enqueueOutcome = newEnqueueOutcome();

  await runLocalWrite(
    db,
    'user_favorites',
    'create',
    async (txn) => {
      // Same owner stamp as writeTickLocal — user_favorites has a user_id column
      // the dual-write never filled.
      const ownerUserId = await getLocalUserId(txn);
      if (delivery === 'local-only' && ownerUserId === null) {
        throw new Error('Local profile owner is not initialized');
      }
      await txn.runAsync(
        `INSERT OR IGNORE INTO user_favorites (board_name, climb_uuid, angle, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
        [input.boardName, input.climbUuid, input.angle, ownerUserId, now, now],
      );

      if (delivery === 'account') {
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          favoriteRemoveKey(input),
        ]);
        // A retry re-runs this and reassigns the holder — last attempt wins, which
        // is the outcome that matters. Re-running `enqueue` against a row a previous
        // attempt committed reports `pending`, and reportEnqueueSuppressed only
        // fires on `dead_letter`, so a retry can never fake a suppressed-enqueue.
        enqueueOutcome.result = await enqueue(txn, 'user_favorites', 'create', input, favoriteAddKey(input));
      }
    },
    undefined,
    delivery === 'account',
  );

  // The cancel DELETE above matches only `status = 'pending'`, so a
  // dead-lettered add keeps owning this UNIQUE key forever and every later add
  // for the same climb/angle is dropped right here — local row written, nothing
  // queued, nothing to drain. Reviving that row is a behaviour change with its
  // own issue; this makes the swallow countable.
  if (delivery === 'account') reportSuppressedEnqueue('user_favorites', 'create', enqueueOutcome);
}

type EnqueueOutcome = { result: EnqueueResult | null };

function newEnqueueOutcome(): EnqueueOutcome {
  return { result: null };
}

function reportSuppressedEnqueue(tableName: string, operation: 'create' | 'delete', outcome: EnqueueOutcome): void {
  const { result } = outcome;
  if (result === null || result.inserted) return;
  reportEnqueueSuppressed(tableName, operation, result.existingStatus);
}

export async function removeFavoriteLocal(
  db: OfflineDatabase,
  input: FavoriteInput,
  delivery: LocalWriteDelivery = 'account',
): Promise<void> {
  const enqueueOutcome = newEnqueueOutcome();

  await runLocalWrite(
    db,
    'user_favorites',
    'delete',
    async (txn) => {
      const ownerUserId = await getLocalUserId(txn);
      if (delivery === 'local-only' && ownerUserId === null) {
        throw new Error('Local profile owner is not initialized');
      }
      const ownerPredicate = delivery === 'account' ? '(user_id IS NULL OR user_id = ?)' : 'user_id = ?';
      await txn.runAsync(
        `DELETE FROM user_favorites
       WHERE board_name = ? AND climb_uuid = ? AND angle = ? AND ${ownerPredicate}`,
        [input.boardName, input.climbUuid, input.angle, ownerUserId],
      );

      // Cancel a not-yet-drained add so an offline add->remove nets to no server
      // call — but ALWAYS enqueue the remove: the drainer doesn't mark rows
      // in-flight, so a cancel can "succeed" on a row whose mutation was already
      // sent (TOCTOU between peekPending and markCompleted). The server's
      // removeFavorite is an idempotent no-op when nothing exists, so the extra
      // remove is harmless in the truly-canceled case and corrective in the race.
      if (delivery === 'account') {
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          favoriteAddKey(input),
        ]);
        enqueueOutcome.result = await enqueue(txn, 'user_favorites', 'delete', input, favoriteRemoveKey(input));
      }
    },
    undefined,
    delivery === 'account',
  );

  if (delivery === 'account') reportSuppressedEnqueue('user_favorites', 'delete', enqueueOutcome);
}

async function requireLocalProfileOwner(db: SqlExecutor): Promise<string> {
  const ownerUserId = await getLocalUserId(db);
  if (ownerUserId === null) throw new Error('Local profile owner is not initialized');
  return ownerUserId;
}

type LocalPlaylistRow = {
  uuid: string;
  board_type: string | null;
  layout_id: number | null;
  name: string | null;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_accessed_at: string | null;
  climb_count: number;
};

function toLocalPlaylist(row: LocalPlaylistRow): Playlist {
  const createdAt = row.created_at ?? new Date(0).toISOString();
  return {
    id: row.uuid,
    uuid: row.uuid,
    boardType: row.board_type ?? '',
    layoutId: row.layout_id,
    name: row.name ?? '',
    description: row.description ?? undefined,
    isPublic: false,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    createdAt,
    updatedAt: row.updated_at ?? createdAt,
    lastAccessedAt: row.last_accessed_at,
    climbCount: row.climb_count,
    userRole: 'owner',
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

const LOCAL_PLAYLIST_SELECT = `
  SELECT playlists.uuid, playlists.board_type, playlists.layout_id, playlists.name,
         playlists.description, playlists.color, playlists.icon, playlists.created_at,
         playlists.updated_at, playlists.last_accessed_at,
         COUNT(playlist_climbs.climb_uuid) AS climb_count
  FROM playlists
  LEFT JOIN playlist_climbs ON playlist_climbs.playlist_uuid = playlists.uuid`;

export async function getPlaylistsLocal(db: OfflineDatabase): Promise<Playlist[]> {
  await requireLocalProfileOwner(db);
  const rows = await db.getAllAsync<LocalPlaylistRow>(
    `${LOCAL_PLAYLIST_SELECT}
     GROUP BY playlists.uuid
     ORDER BY COALESCE(playlists.last_accessed_at, playlists.updated_at, playlists.created_at) DESC,
              playlists.name ASC`,
  );
  return rows.map(toLocalPlaylist);
}

export async function getPlaylistLocal(db: OfflineDatabase, playlistUuid: string): Promise<Playlist | null> {
  await requireLocalProfileOwner(db);
  const row = await db.getFirstAsync<LocalPlaylistRow>(
    `${LOCAL_PLAYLIST_SELECT}
     WHERE playlists.uuid = ?
     GROUP BY playlists.uuid`,
    [playlistUuid],
  );
  return row ? toLocalPlaylist(row) : null;
}

export async function getPlaylistMembershipsLocal(db: OfflineDatabase): Promise<Map<string, Set<string>>> {
  await requireLocalProfileOwner(db);
  const rows = await db.getAllAsync<{ climb_uuid: string; playlist_uuid: string }>(
    `SELECT playlist_climbs.climb_uuid, playlist_climbs.playlist_uuid
     FROM playlist_climbs
     INNER JOIN playlists ON playlists.uuid = playlist_climbs.playlist_uuid
     ORDER BY playlist_climbs.position ASC, playlist_climbs.added_at ASC`,
  );
  const memberships = new Map<string, Set<string>>();
  for (const { climb_uuid: climbUuid, playlist_uuid: playlistUuid } of rows) {
    const playlistUuids = memberships.get(climbUuid) ?? new Set<string>();
    playlistUuids.add(playlistUuid);
    memberships.set(climbUuid, playlistUuids);
  }
  return memberships;
}

export async function createPlaylistLocal(
  db: OfflineDatabase,
  input: CreatePlaylistInput,
  playlistUuid: string,
  delivery: LocalWriteDelivery = 'local-only',
): Promise<Playlist> {
  const now = new Date().toISOString();
  await runLocalWrite(
    db,
    'playlists',
    'create',
    async (txn) => {
      await requireLocalProfileOwner(txn);
      await txn.runAsync(
        `INSERT OR IGNORE INTO playlists
           (uuid, board_type, layout_id, name, description, is_public, color, icon, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          playlistUuid,
          input.boardType,
          input.layoutId,
          input.name,
          input.description ?? null,
          input.color ?? null,
          input.icon ?? null,
          now,
          now,
        ],
      );
      if (delivery === 'account') {
        const payload: Record<string, unknown> = { ...input };
        delete payload.uuid;
        await enqueue(txn, 'playlists', 'create', payload, playlistUuid);
      }
    },
    undefined,
    delivery === 'account',
  );
  const playlist = await getPlaylistLocal(db, playlistUuid);
  if (!playlist) throw new Error('Local playlist write did not persist');
  return playlist;
}

export async function updatePlaylistLocal(
  db: OfflineDatabase,
  input: UpdatePlaylistInput,
  delivery: LocalWriteDelivery = 'local-only',
): Promise<Playlist> {
  if (delivery === 'account' && input.isPublic === true) {
    throw new Error('Go online to publish a playlist');
  }
  const assignments: string[] = [];
  const parameters: SqlValue[] = [];
  const fields = [
    ['name', input.name],
    ['description', input.description],
    ['color', input.color],
    ['icon', input.icon],
  ] as const;
  for (const [column, fieldValue] of fields) {
    if (fieldValue === undefined) continue;
    assignments.push(`${column} = ?`);
    parameters.push(fieldValue);
  }
  assignments.push('is_public = 0', 'updated_at = ?');
  parameters.push(new Date().toISOString(), input.playlistId);

  await runLocalWrite(
    db,
    'playlists',
    'update',
    async (txn) => {
      await requireLocalProfileOwner(txn);
      await txn.runAsync(`UPDATE playlists SET ${assignments.join(', ')} WHERE uuid = ?`, parameters);
      if (delivery === 'account') {
        const idempotencyKey = `update:playlists:${input.playlistId}`;
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          idempotencyKey,
        ]);
        await enqueue(txn, 'playlists', 'update', input, idempotencyKey);
      }
    },
    undefined,
    delivery === 'account',
  );
  const playlist = await getPlaylistLocal(db, input.playlistId);
  if (!playlist) throw new Error('Local playlist not found');
  return playlist;
}

export async function deletePlaylistLocal(
  db: OfflineDatabase,
  playlistUuid: string,
  delivery: LocalWriteDelivery = 'local-only',
): Promise<boolean> {
  let deleted = false;
  await runLocalWrite(
    db,
    'playlists',
    'delete',
    async (txn) => {
      await requireLocalProfileOwner(txn);
      deleted =
        (await txn.getFirstAsync<{ uuid: string }>('SELECT uuid FROM playlists WHERE uuid = ?', [playlistUuid])) !==
        null;
      await txn.runAsync('DELETE FROM playlist_climbs WHERE playlist_uuid = ?', [playlistUuid]);
      await txn.runAsync('DELETE FROM playlists WHERE uuid = ?', [playlistUuid]);
      if (delivery === 'account') {
        await enqueue(txn, 'playlists', 'delete', { uuid: playlistUuid }, `delete:playlists:${playlistUuid}`);
      }
    },
    undefined,
    delivery === 'account',
  );
  return deleted;
}

export async function addClimbToPlaylistLocal(
  db: OfflineDatabase,
  input: AddClimbToPlaylistInput,
  delivery: LocalWriteDelivery = 'local-only',
): Promise<boolean> {
  let wasAlreadyInPlaylist = false;
  const now = new Date().toISOString();
  await runLocalWrite(
    db,
    'playlist_climbs',
    'create',
    async (txn) => {
      await requireLocalProfileOwner(txn);
      const playlist = await txn.getFirstAsync<{ uuid: string }>('SELECT uuid FROM playlists WHERE uuid = ?', [
        input.playlistId,
      ]);
      if (!playlist) throw new Error('Local playlist not found');
      const existing = await txn.getFirstAsync<{ climb_uuid: string }>(
        'SELECT climb_uuid FROM playlist_climbs WHERE playlist_uuid = ? AND climb_uuid = ?',
        [input.playlistId, input.climbUuid],
      );
      wasAlreadyInPlaylist = existing !== null;
      const nextPositionRow = await txn.getFirstAsync<{ next_position: number }>(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM playlist_climbs WHERE playlist_uuid = ?',
        [input.playlistId],
      );
      await txn.runAsync(
        `INSERT OR IGNORE INTO playlist_climbs
           (playlist_uuid, climb_uuid, angle, position, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.playlistId, input.climbUuid, input.angle, nextPositionRow?.next_position ?? 0, now, now],
      );
      if (delivery === 'account' && !wasAlreadyInPlaylist) {
        const idempotencyKey = `add:playlist_climbs:${input.playlistId}:${input.climbUuid}`;
        await txn.runAsync(
          `DELETE FROM pending_mutations
           WHERE idempotency_key = ? AND status = 'pending'`,
          [`del:playlist_climbs:${input.playlistId}:${input.climbUuid}`],
        );
        await enqueue(txn, 'playlist_climbs', 'create', input, idempotencyKey);
      }
    },
    undefined,
    delivery === 'account',
  );
  return wasAlreadyInPlaylist;
}

export async function removeClimbFromPlaylistLocal(
  db: OfflineDatabase,
  input: RemoveClimbFromPlaylistInput,
  delivery: LocalWriteDelivery = 'local-only',
): Promise<boolean> {
  let removed = false;
  await runLocalWrite(
    db,
    'playlist_climbs',
    'delete',
    async (txn) => {
      await requireLocalProfileOwner(txn);
      const existing = await txn.getFirstAsync<{ climb_uuid: string }>(
        'SELECT climb_uuid FROM playlist_climbs WHERE playlist_uuid = ? AND climb_uuid = ?',
        [input.playlistId, input.climbUuid],
      );
      removed = existing !== null;
      await txn.runAsync('DELETE FROM playlist_climbs WHERE playlist_uuid = ? AND climb_uuid = ?', [
        input.playlistId,
        input.climbUuid,
      ]);
      if (delivery === 'account') {
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          `add:playlist_climbs:${input.playlistId}:${input.climbUuid}`,
        ]);
        await enqueue(
          txn,
          'playlist_climbs',
          'delete',
          input,
          `del:playlist_climbs:${input.playlistId}:${input.climbUuid}`,
        );
      }
    },
    undefined,
    delivery === 'account',
  );
  return removed;
}

export async function getPlaylistClimbsLocal(
  db: OfflineDatabase,
  input: GetPlaylistClimbsInput,
): Promise<PlaylistClimbsResult> {
  await requireLocalProfileOwner(db);
  const playlist = await getPlaylistLocal(db, input.playlistId);
  if (!playlist) return { climbs: [], totalCount: 0, hasMore: false };
  if (input.boardName !== undefined && input.boardName !== playlist.boardType) {
    return { climbs: [], totalCount: 0, hasMore: false };
  }
  if (input.layoutId !== undefined && input.layoutId !== playlist.layoutId) {
    return { climbs: [], totalCount: 0, hasMore: false };
  }

  const rows = await db.getAllAsync<{ climb_uuid: string; angle: number | null }>(
    `SELECT climb_uuid, angle
     FROM playlist_climbs
     WHERE playlist_uuid = ?
     ORDER BY position ASC, added_at ASC, climb_uuid ASC`,
    [input.playlistId],
  );
  const page = Math.max(0, Math.trunc(input.page ?? 0));
  const pageSize = Math.max(1, Math.trunc(input.pageSize ?? 20));
  const start = page * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const localClimbs = (
    await Promise.all(
      pageRows.map(({ climb_uuid: climbUuid, angle }) =>
        getClimbLocal(db, {
          boardName: playlist.boardType,
          layoutId: playlist.layoutId ?? 0,
          angle:
            input.angle ?? (input.activeBoardName === playlist.boardType ? input.activeAngle : undefined) ?? angle ?? 0,
          climbUuid,
        }),
      ),
    )
  ).filter((climb): climb is NonNullable<typeof climb> => climb !== null);
  const climbs: PlaylistClimbsResult['climbs'] = localClimbs.map((climb) => ({
    uuid: climb.uuid,
    layoutId: climb.layoutId,
    boardType: climb.boardType,
    setter_username: climb.setter_username,
    name: climb.name,
    description: climb.description ?? '',
    frames: climb.frames,
    framesCount: climb.framesCount,
    framesPace: climb.framesPace,
    angle: climb.angle,
    ascensionist_count: climb.ascensionist_count,
    difficulty: climb.difficulty,
    quality_average: climb.quality_average,
    stars: climb.stars,
    difficulty_error: climb.difficulty_error,
    benchmark_difficulty: climb.benchmark_difficulty,
    boardseshDifficulty: climb.boardseshDifficulty,
    boardseshConfidence: climb.boardseshConfidence,
    compatibleSizeIds: climb.compatibleSizeIds,
  }));
  return { climbs, totalCount: rows.length, hasMore: start + pageSize < rows.length };
}

export async function reorderPlaylistClimbLocal(
  db: OfflineDatabase,
  input: ReorderPlaylistClimbInput,
  delivery: LocalWriteDelivery = 'local-only',
): Promise<boolean> {
  let reordered = false;
  await runLocalWrite(
    db,
    'playlist_climbs',
    'update',
    async (txn) => {
      await requireLocalProfileOwner(txn);
      const rows = await txn.getAllAsync<{ climb_uuid: string }>(
        `SELECT climb_uuid FROM playlist_climbs
         WHERE playlist_uuid = ?
         ORDER BY position ASC, added_at ASC, climb_uuid ASC`,
        [input.playlistId],
      );
      const oldIndex = rows.findIndex(({ climb_uuid: climbUuid }) => climbUuid === input.climbUuid);
      if (oldIndex === -1) return;
      const [moved] = rows.splice(oldIndex, 1);
      rows.splice(Math.max(0, Math.min(input.newIndex, rows.length)), 0, moved);
      const updatedAt = new Date().toISOString();
      // Stay below SQLite's legacy 999-variable ceiling while reducing a
      // 500-climb reorder from 500 awaited statements to two batched writes.
      const reorderBatchSize = 300;
      for (let batchStart = 0; batchStart < rows.length; batchStart += reorderBatchSize) {
        const batch = rows.slice(batchStart, batchStart + reorderBatchSize);
        const positionCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
        const climbPlaceholders = batch.map(() => '?').join(', ');
        const positionParameters = batch.flatMap(({ climb_uuid: climbUuid }, batchIndex) => [
          climbUuid,
          batchStart + batchIndex,
        ]);
        const climbUuids = batch.map(({ climb_uuid: climbUuid }) => climbUuid);
        await txn.runAsync(
          `UPDATE playlist_climbs
           SET position = CASE climb_uuid ${positionCases} ELSE position END,
               updated_at = ?
           WHERE playlist_uuid = ? AND climb_uuid IN (${climbPlaceholders})`,
          [...positionParameters, updatedAt, input.playlistId, ...climbUuids],
        );
      }
      reordered = true;
      if (delivery === 'account') {
        const idempotencyKey = `reorder:playlist_climbs:${input.playlistId}:${input.climbUuid}`;
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          idempotencyKey,
        ]);
        await enqueue(txn, 'playlist_climbs', 'update', input, idempotencyKey);
      }
    },
    undefined,
    delivery === 'account',
  );
  return reordered;
}

export function useOfflineFollowUser(db: OfflineDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const now = new Date().toISOString();
      const idempotencyKey = `add:user_follows:${followingId}`;
      const enqueueOutcome = newEnqueueOutcome();

      await runLocalWrite(db, 'user_follows', 'create', async (txn) => {
        await txn.runAsync(
          `INSERT OR IGNORE INTO user_follows (following_id, created_at, updated_at)
           VALUES (?, ?, ?)`,
          [followingId, now, now],
        );

        // Cancel a not-yet-drained unfollow (mirrors the favorites pair):
        // without this, offline follow→unfollow→follow leaves [add, del] in
        // the queue (the second add is INSERT OR IGNOREd away) and drains to
        // UNFOLLOWED — the opposite of the user's last action.
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          `del:user_follows:${followingId}`,
        ]);
        enqueueOutcome.result = await enqueue(txn, 'user_follows', 'create', { followingId }, idempotencyKey);
      });

      reportSuppressedEnqueue('user_follows', 'create', enqueueOutcome);

      void queryClient.invalidateQueries({ queryKey: ['followers'] });
      void queryClient.invalidateQueries({ queryKey: ['following'] });

      scheduleDrain(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}

export function useOfflineUnfollowUser(db: OfflineDatabase, graphqlFetch: GraphQLFetch) {
  const queryClient = useQueryClient();

  return useCallback(
    async (followingId: string) => {
      const idempotencyKey = `del:user_follows:${followingId}`;
      const enqueueOutcome = newEnqueueOutcome();

      await runLocalWrite(db, 'user_follows', 'delete', async (txn) => {
        await txn.runAsync(`DELETE FROM user_follows WHERE following_id = ?`, [followingId]);

        // Cancel a not-yet-drained follow, but ALWAYS enqueue the unfollow —
        // same TOCTOU reasoning as removeFavoriteLocal: the canceled add may
        // already be in flight, and the server unfollow is an idempotent no-op.
        await txn.runAsync(`DELETE FROM pending_mutations WHERE idempotency_key = ? AND status = 'pending'`, [
          `add:user_follows:${followingId}`,
        ]);
        enqueueOutcome.result = await enqueue(txn, 'user_follows', 'delete', { followingId }, idempotencyKey);
      });

      reportSuppressedEnqueue('user_follows', 'delete', enqueueOutcome);

      void queryClient.invalidateQueries({ queryKey: ['followers'] });
      void queryClient.invalidateQueries({ queryKey: ['following'] });

      scheduleDrain(db, queryClient, graphqlFetch);
    },
    [db, queryClient, graphqlFetch],
  );
}
