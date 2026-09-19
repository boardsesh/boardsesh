import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { boardClimbEvents, users, userProfiles } from '@boardsesh/db/schema';
import type { BoardHistoryPage, BoardPresenceClimb } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { parsePostgresUtcTimestamp } from '../utils/postgres-timestamps';
import { mergeBoardHistory } from '@boardsesh/board-presence';
import { logger } from '../utils/logger';

export const HISTORY_TTL_SECONDS = 604_800;
const selectedHistory = {
  climbUuid: boardClimbEvents.climbUuid,
  name: boardClimbEvents.name,
  grade: boardClimbEvents.grade,
  frames: boardClimbEvents.frames,
  angle: boardClimbEvents.angle,
  setter: boardClimbEvents.setter,
  source: boardClimbEvents.source,
  confirmedAt: boardClimbEvents.confirmedAt,
  seq: boardClimbEvents.seq,
  userId: boardClimbEvents.userId,
  externalDisplayName: boardClimbEvents.externalDisplayName,
  userName: users.name,
  userImage: users.image,
  displayName: userProfiles.displayName,
  avatarUrl: userProfiles.avatarUrl,
};
type HistoryRow = {
  climbUuid: string;
  name: string | null;
  grade: string | null;
  frames: string | null;
  angle: number;
  setter: string | null;
  source: string;
  confirmedAt: string;
  seq: number;
  userId: string | null;
  externalDisplayName: string | null;
  userName: string | null;
  userImage: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export function historyRowToClimb(row: HistoryRow): BoardPresenceClimb {
  const imported = row.source === 'kilter';
  // Postgres timestamps are UTC by convention; retain sub-millisecond ordering.
  const timestamp = row.confirmedAt.replace(' ', 'T');
  const sentAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(timestamp)
    ? `${timestamp}Z`
    : (parsePostgresUtcTimestamp(row.confirmedAt) ?? row.confirmedAt);
  return {
    climbUuid: row.climbUuid,
    name: row.name,
    grade: row.grade,
    frames: row.frames,
    angle: row.angle,
    setter: row.setter,
    source: imported ? 'kilter' : 'boardsesh',
    seq: Number(row.seq),
    sentAt,
    sentByUserId: imported ? null : row.userId,
    sentByDisplayName: imported ? row.externalDisplayName : (row.displayName ?? row.userName),
    sentByAvatarUrl: imported ? null : (row.avatarUrl ?? row.userImage),
  };
}

export function parseHistoryPageCursor(cursor: string, boardId: number): { timestamp: string; seq: number } {
  try {
    if (cursor.length > 512) throw new Error('Too long');
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      decoded[0] !== boardId ||
      typeof decoded[1] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(decoded[1]) ||
      !Number.isFinite(Date.parse(`${decoded[1].replace(' ', 'T')}Z`)) ||
      !Number.isSafeInteger(decoded[2]) ||
      decoded[2] < 1
    )
      throw new Error('Invalid cursor');
    return { timestamp: decoded[1], seq: decoded[2] };
  } catch {
    throw new GraphQLError('Invalid history cursor', { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

export async function readBoardHistoryPage(
  boardId: number,
  limit = 50,
  before?: string | null,
): Promise<BoardHistoryPage> {
  const pageSize = Math.min(100, Math.max(1, limit));
  const cursor = before ? parseHistoryPageCursor(before, boardId) : null;
  const rows = await db
    .select(selectedHistory)
    .from(boardClimbEvents)
    .leftJoin(users, eq(users.id, boardClimbEvents.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, boardClimbEvents.userId))
    .where(
      and(
        eq(boardClimbEvents.boardId, boardId),
        cursor
          ? or(
              lt(boardClimbEvents.confirmedAt, cursor.timestamp),
              and(eq(boardClimbEvents.confirmedAt, cursor.timestamp), lt(boardClimbEvents.seq, cursor.seq)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(boardClimbEvents.confirmedAt), desc(boardClimbEvents.seq))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    entries: page.map(historyRowToClimb),
    nextCursor:
      rows.length > pageSize && last
        ? Buffer.from(JSON.stringify([boardId, last.confirmedAt, last.seq])).toString('base64url')
        : null,
  };
}

export async function readImportedRecentClimbs(boardId: number): Promise<BoardPresenceClimb[]> {
  const rows = await db
    .select(selectedHistory)
    .from(boardClimbEvents)
    .leftJoin(users, eq(users.id, boardClimbEvents.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, boardClimbEvents.userId))
    .where(
      and(
        eq(boardClimbEvents.boardId, boardId),
        eq(boardClimbEvents.source, 'kilter'),
        gte(boardClimbEvents.confirmedAt, new Date(Date.now() - HISTORY_TTL_SECONDS * 1000).toISOString()),
      ),
    )
    .orderBy(desc(boardClimbEvents.confirmedAt), desc(boardClimbEvents.seq))
    .limit(50);
  return rows.map(historyRowToClimb);
}

function isImportedHistoryEntry(entry: unknown): entry is BoardPresenceClimb {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const cachedEntry = entry as Record<string, unknown>;
  const nullableStringFields = [
    'queueItemUuid',
    'name',
    'grade',
    'gradeColor',
    'frames',
    'setter',
    'sentByDisplayName',
    'sentByAvatarUrl',
    'sentByUserId',
  ];
  return (
    cachedEntry.source === 'kilter' &&
    typeof cachedEntry.climbUuid === 'string' &&
    typeof cachedEntry.sentAt === 'string' &&
    Number.isFinite(Date.parse(cachedEntry.sentAt)) &&
    typeof cachedEntry.seq === 'number' &&
    Number.isSafeInteger(cachedEntry.seq) &&
    cachedEntry.seq > 0 &&
    (cachedEntry.angle == null || (typeof cachedEntry.angle === 'number' && Number.isSafeInteger(cachedEntry.angle))) &&
    nullableStringFields.every((field) => cachedEntry[field] == null || typeof cachedEntry[field] === 'string')
  );
}

export async function readMergedRecentHistory(boardId: number): Promise<BoardPresenceClimb[]> {
  const native = await pubsub.getRecentBoardClimbs(String(boardId));
  let imported: BoardPresenceClimb[] | null = null;
  if (redisClientManager.isRedisConnected()) {
    try {
      const cached = await redisClientManager.getClients().publisher.get(`board:${boardId}:kilter-history`);
      const parsed: unknown = cached ? JSON.parse(cached) : null;
      if (Array.isArray(parsed) && parsed.every(isImportedHistoryEntry)) {
        imported = parsed;
      } else if (cached !== null) {
        logger.warn('[BoardHistory] Invalid imported history cache; reading durable history', { boardId });
      }
    } catch {
      /* Durable history remains readable when Redis is unavailable. */
    }
  }
  // Only the importer writes the cache, so a racing query cannot suppress its
  // history-change broadcast or overwrite a newer committed cache snapshot.
  imported ??= await readImportedRecentClimbs(boardId);
  const cutoff = Date.now() - HISTORY_TTL_SECONDS * 1000;
  let invalidTimestampCount = 0;
  const recent = mergeBoardHistory(native, imported).filter((climb) => {
    const timestamp = Date.parse(climb.sentAt);
    if (!Number.isFinite(timestamp)) {
      invalidTimestampCount++;
      return false;
    }
    return timestamp >= cutoff;
  });
  if (invalidTimestampCount) {
    logger.warn('[BoardHistory] Skipped history with invalid timestamps', { boardId, invalidTimestampCount });
  }
  return recent.slice(0, 50);
}
