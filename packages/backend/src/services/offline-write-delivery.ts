import { createHash } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { offlineWriteDeliveries, type OfflineWriteDeliveryRow } from '@boardsesh/db/schema';
import type {
  OfflineWriteDeliveryReceipt,
  OfflineWriteObservation,
  OfflineWriteRelease,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';

export const OFFLINE_WRITE_OPERATIONS = {
  saveClimb: ['board_climbs', 'create'],
  updateClimb: ['board_climbs', 'update'],
  saveTick: ['boardsesh_ticks', 'create'],
  updateTick: ['boardsesh_ticks', 'update'],
  deleteTick: ['boardsesh_ticks', 'delete'],
  addFavorite: ['user_favorites', 'create'],
  removeFavorite: ['user_favorites', 'delete'],
  createPlaylist: ['playlists', 'create'],
  updatePlaylist: ['playlists', 'update'],
  deletePlaylist: ['playlists', 'delete'],
  addClimbToPlaylist: ['playlist_climbs', 'create'],
  removeClimbFromPlaylist: ['playlist_climbs', 'delete'],
  followUser: ['user_follows', 'create'],
  unfollowUser: ['user_follows', 'delete'],
  followSetter: ['setter_follows', 'create'],
  unfollowSetter: ['setter_follows', 'delete'],
  followPlaylist: ['playlist_follows', 'create'],
  unfollowPlaylist: ['playlist_follows', 'delete'],
  pinPlaylist: ['user_playlist_pins', 'create'],
  unpinPlaylist: ['user_playlist_pins', 'delete'],
  recordSessionWorkout: ['session_workouts', 'create'],
} as const;

export type OfflineWriteOperation = keyof typeof OFFLINE_WRITE_OPERATIONS;

function stableSerialize(candidate: unknown): string {
  if (Array.isArray(candidate)) return `[${candidate.map(stableSerialize).join(',')}]`;
  if (candidate !== null && typeof candidate === 'object') {
    return `{${Object.entries(candidate)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(candidate) ?? 'null';
}

/** Binds the logical target, allowing corrected payloads to recover the same durable queued intent. */
export function offlineWriteBindingHash(operation: OfflineWriteOperation, args: Record<string, unknown>): string {
  const input = args.input !== null && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
  const fields: Record<OfflineWriteOperation, readonly string[]> = {
    saveClimb: ['uuid', 'boardType'],
    updateClimb: ['uuid', 'boardType'],
    saveTick: ['uuid'],
    updateTick: ['uuid'],
    deleteTick: ['uuid'],
    addFavorite: ['boardName', 'climbUuid', 'angle'],
    removeFavorite: ['boardName', 'climbUuid', 'angle'],
    createPlaylist: ['uuid'],
    updatePlaylist: ['playlistId'],
    deletePlaylist: ['playlistId'],
    addClimbToPlaylist: ['playlistId', 'climbUuid', 'angle'],
    removeClimbFromPlaylist: ['playlistId', 'climbUuid'],
    followUser: ['userId'],
    unfollowUser: ['userId'],
    followSetter: ['setterUsername'],
    unfollowSetter: ['setterUsername'],
    followPlaylist: ['playlistUuid'],
    unfollowPlaylist: ['playlistUuid'],
    pinPlaylist: ['playlistUuid'],
    unpinPlaylist: ['playlistUuid'],
    recordSessionWorkout: ['sessionId', 'revision'],
  };
  const target = Object.fromEntries(fields[operation].map((field) => [field, args[field] ?? input[field] ?? null]));
  return createHash('sha256').update(stableSerialize({ operation, target })).digest('hex');
}

function receiptFor(row: OfflineWriteDeliveryRow, revision: number): OfflineWriteDeliveryReceipt {
  return {
    deliveryId: row.deliveryId,
    revision,
    serverAcceptedAt: row.serverAcceptedAt?.toISOString() ?? null,
    serverRejectedAt: row.serverRejectedAt?.toISOString() ?? null,
  };
}

const toDate = (candidate: string | null): Date | null => (candidate === null ? null : new Date(candidate));

/** Uploading an observation can never set the backend acceptance/rejection columns. */
export async function recordOfflineWriteObservation(
  userId: string,
  observation: OfflineWriteObservation,
  now = new Date(),
): Promise<OfflineWriteDeliveryReceipt | null> {
  const table = offlineWriteDeliveries;
  const queuedAt = new Date(observation.queuedAt);
  const clientFields = {
    clientState: observation.state,
    clientRevision: observation.revision,
    clientObservedAt: new Date(observation.observedAt),
    clientServerResponseAt: toDate(observation.serverResponseAt),
    clientReconciledAt: toDate(observation.reconciledAt),
    firstDeadLetterAt: toDate(observation.firstDeadLetterAt),
    lastDeadLetterAt: toDate(observation.lastDeadLetterAt),
    recovered: observation.recovered,
    observedRelease: observation.observedRelease ?? null,
    lastReportedAt: now,
  };
  await db
    .insert(table)
    .values({
      userId,
      deliveryId: observation.deliveryId,
      tableName: observation.tableName,
      operation: observation.operation,
      queuedAt,
      connectivityReason: observation.connectivityReason,
      originRelease: observation.originRelease,
      firstSeenAt: now,
      ...clientFields,
      reconciledReportedAt: observation.state === 'reconciled' ? now : null,
    })
    .onConflictDoUpdate({
      target: [table.userId, table.deliveryId],
      set: {
        ...clientFields,
        queuedAt: sql`COALESCE(${table.queuedAt}, ${queuedAt.toISOString()})`,
        connectivityReason: sql`COALESCE(${table.connectivityReason}, ${observation.connectivityReason})`,
        originRelease: sql`COALESCE(${table.originRelease}, ${JSON.stringify(observation.originRelease)}::jsonb)`,
        // Keep observed recovery/failure history even if a newer client omitted a past stage.
        recovered: sql`${table.recovered} OR ${observation.recovered}`,
        firstDeadLetterAt: sql`COALESCE(${table.firstDeadLetterAt}, ${observation.firstDeadLetterAt})`,
        lastDeadLetterAt: sql`COALESCE(${observation.lastDeadLetterAt}, ${table.lastDeadLetterAt})`,
        reconciledReportedAt:
          observation.state === 'reconciled'
            ? sql`COALESCE(${table.reconciledReportedAt}, ${now.toISOString()})`
            : table.reconciledReportedAt,
      },
      setWhere: and(
        eq(table.tableName, observation.tableName),
        eq(table.operation, observation.operation),
        or(
          isNull(table.queuedAt),
          and(
            eq(table.queuedAt, queuedAt),
            eq(table.connectivityReason, observation.connectivityReason),
            eq(table.originRelease, observation.originRelease),
          ),
        ),
        lt(table.clientRevision, observation.revision),
      ),
    });
  const [stored] = await db
    .select()
    .from(table)
    .where(and(eq(table.userId, userId), eq(table.deliveryId, observation.deliveryId)))
    .limit(1);
  if (
    !stored ||
    stored.tableName !== observation.tableName ||
    stored.operation !== observation.operation ||
    stored.queuedAt?.getTime() !== queuedAt.getTime() ||
    stored.connectivityReason !== observation.connectivityReason ||
    stableSerialize(stored.originRelease) !== stableSerialize(observation.originRelease) ||
    stored.clientRevision < observation.revision
  )
    return null;
  // Acknowledge exactly the uploaded revision, never a concurrently generated future revision.
  return receiptFor(stored, observation.revision);
}

export type OfflineWriteVerdict = {
  userId: string;
  deliveryId: string;
  operation: OfflineWriteOperation;
  bindingHash: string;
  accepted: boolean;
  rejectionCode?: string;
  receivingRelease?: OfflineWriteRelease;
};

/** Called by the resolver observer, never by the client observation API. */
export async function recordOfflineWriteVerdict(verdict: OfflineWriteVerdict, now = new Date()): Promise<void> {
  const table = offlineWriteDeliveries;
  const [tableName, operation] = OFFLINE_WRITE_OPERATIONS[verdict.operation];
  await db
    .insert(table)
    .values({
      userId: verdict.userId,
      deliveryId: verdict.deliveryId,
      tableName,
      operation,
      bindingHash: verdict.bindingHash,
      firstSeenAt: now,
      serverAcceptedAt: verdict.accepted ? now : null,
      serverRejectedAt: verdict.accepted ? null : now,
      serverRejectionCode: verdict.rejectionCode ?? null,
      receivingRelease: verdict.accepted ? (verdict.receivingRelease ?? null) : null,
      rejectionRelease: verdict.accepted ? null : (verdict.receivingRelease ?? null),
    })
    .onConflictDoUpdate({
      target: [table.userId, table.deliveryId],
      set: {
        bindingHash: verdict.bindingHash,
        ...(verdict.accepted
          ? {
              serverAcceptedAt: sql`COALESCE(${table.serverAcceptedAt}, ${now.toISOString()})`,
              receivingRelease: sql`CASE WHEN ${table.serverAcceptedAt} IS NULL
          THEN ${JSON.stringify(verdict.receivingRelease ?? null)}::jsonb ELSE ${table.receivingRelease} END`,
            }
          : {
              serverRejectedAt: sql`COALESCE(${table.serverRejectedAt}, ${now.toISOString()})`,
              serverRejectionCode: sql`COALESCE(${table.serverRejectionCode}, ${verdict.rejectionCode ?? null})`,
              rejectionRelease: sql`CASE WHEN ${table.serverRejectedAt} IS NULL
          THEN ${JSON.stringify(verdict.receivingRelease ?? null)}::jsonb ELSE ${table.rejectionRelease} END`,
            }),
      },
      setWhere: and(
        eq(table.tableName, tableName),
        eq(table.operation, operation),
        or(isNull(table.bindingHash), eq(table.bindingHash, verdict.bindingHash)),
      ),
    });
}
