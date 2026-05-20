import type { BoardClimbHistory } from '@boardsesh/db/schema/app';
import type { BoardHistoryEntry, BoardHistorySource } from '@boardsesh/shared-schema';

const DB_TO_GRAPHQL_SOURCE: Record<BoardClimbHistory['source'], BoardHistorySource> = {
  ble_send: 'BLE_SEND',
  manual: 'MANUAL',
  shared_queue_relay: 'SHARED_QUEUE_RELAY',
};

const GRAPHQL_TO_DB_SOURCE: Record<BoardHistorySource, BoardClimbHistory['source']> = {
  BLE_SEND: 'ble_send',
  MANUAL: 'manual',
  SHARED_QUEUE_RELAY: 'shared_queue_relay',
};

export function dbSourceToGraphql(source: BoardClimbHistory['source']): BoardHistorySource {
  return DB_TO_GRAPHQL_SOURCE[source];
}

export function graphqlSourceToDb(source: BoardHistorySource): BoardClimbHistory['source'] {
  return GRAPHQL_TO_DB_SOURCE[source];
}

/**
 * Project a board_climb_history row to the GraphQL BoardHistoryEntry shape.
 * `username` is looked up separately via {@link lookupUsername} — pass it
 * in so this projection stays pure and easy to test.
 */
export function serializeBoardHistoryEntry(row: BoardClimbHistory, username: string | null): BoardHistoryEntry {
  return {
    id: row.id.toString(),
    uuid: row.uuid,
    boardSerial: row.boardSerial,
    boardId: row.boardId != null ? row.boardId.toString() : null,
    climbUuid: row.climbUuid,
    angle: row.angle,
    isMirror: row.isMirror,
    source: dbSourceToGraphql(row.source),
    userId: row.userId,
    username,
    sessionId: row.sessionId,
    sentAt: row.sentAt.toISOString(),
    // `sequence` is bigint in the DB. The GraphQL Int is 32-bit (signed,
    // ~2.1B max). At a steady 10 sends/minute every minute that's ~400 years
    // before the wrap, so the coercion is safe for the foreseeable future.
    // If a single board's sequence ever approaches the ceiling, the fix is
    // to widen the GraphQL scalar (Int → custom Long/String) — both the DB
    // and the Redis hot-buffer already store as strings/bigint.
    sequence: Number(row.sequence),
  };
}
