import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  auroraWallSources,
  boardClimbAliases,
  boardClimbEvents,
  boardClimbs,
  locationSyncGymSources,
  userBoards,
} from '@boardsesh/db/schema';
import type { AuroraLiveDisplay } from '@boardsesh/aurora-sync/api';
import { publicClimbCondition } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { reserveBoardPresenceSeq } from '../graphql/resolvers/board-presence/shared';
import { HISTORY_TTL_SECONDS, readImportedRecentClimbs } from './board-history';
import { isAuroraLiveBoardName, type AuroraLiveBoardName } from './aurora-live-token';
import { logger } from '../utils/logger';

export type MatchedAuroraWall = {
  sourceKey: string;
  sourceBoardUuid: string;
  boardId: number;
  boardType: AuroraLiveBoardName;
  gymUserId: number;
  wallUuid: string;
  serialNumber: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

const normalizedSets = (setIds: string) =>
  setIds
    .split(',')
    .map(Number)
    .sort((left, right) => left - right)
    .join(',');

/** A serial-only feed must resolve to exactly one public physical source, including merged sources. */
export async function matchAuroraWall(
  boardId: number,
  reader: Pick<typeof db, 'select'> = db,
): Promise<MatchedAuroraWall | null> {
  const [board] = await reader
    .select()
    .from(userBoards)
    .where(and(eq(userBoards.id, boardId), isNull(userBoards.deletedAt)))
    .limit(1);
  if (!board?.isPublic || board.isUnlisted || !isAuroraLiveBoardName(board.boardType)) return null;
  const sourceUuids = new Set([board.uuid]);
  let frontier = [board.uuid];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const ancestors = await reader
      .select({ uuid: userBoards.uuid })
      .from(userBoards)
      .where(inArray(userBoards.mergedIntoBoardUuid, frontier));
    frontier = ancestors.map((ancestor) => ancestor.uuid).filter((uuid) => !sourceUuids.has(uuid));
    for (const uuid of frontier) sourceUuids.add(uuid);
  }
  const mappings = await reader
    .select()
    .from(auroraWallSources)
    .where(
      and(
        inArray(auroraWallSources.sourceBoardUuid, [...sourceUuids]),
        eq(auroraWallSources.boardType, board.boardType),
        eq(auroraWallSources.isListed, true),
      ),
    );
  if (mappings.length !== 1) return null;
  const mapping = mappings[0];
  if (
    !mapping.sourceBoardUuid ||
    !mapping.serialNumber ||
    mapping.serialNumber !== board.serialNumber ||
    mapping.layoutId !== board.layoutId ||
    mapping.sizeId !== board.sizeId ||
    normalizedSets(mapping.setIds) !== normalizedSets(board.setIds)
  )
    return null;
  // Controller serials are not globally unique. Never merge separate upstream walls' streams.
  const serialSources = await reader
    .select({ gymUserId: auroraWallSources.gymUserId, wallUuid: auroraWallSources.wallUuid })
    .from(auroraWallSources)
    .where(
      and(eq(auroraWallSources.boardType, board.boardType), eq(auroraWallSources.serialNumber, mapping.serialNumber)),
    );
  if (serialSources.some((source) => source.gymUserId !== mapping.gymUserId || source.wallUuid !== mapping.wallUuid))
    return null;
  const [gymSource] = await reader
    .select({ gymId: locationSyncGymSources.gymId })
    .from(locationSyncGymSources)
    .where(eq(locationSyncGymSources.sourceKey, `${board.boardType}:${mapping.gymUserId}`))
    .limit(1);
  if (!gymSource || gymSource.gymId !== board.gymId) return null;
  return {
    sourceKey: mapping.sourceKey,
    sourceBoardUuid: mapping.sourceBoardUuid,
    boardId,
    boardType: board.boardType,
    gymUserId: mapping.gymUserId,
    wallUuid: mapping.wallUuid,
    serialNumber: mapping.serialNumber,
    layoutId: mapping.layoutId,
    sizeId: mapping.sizeId,
    setIds: normalizedSets(mapping.setIds),
  };
}

export function sameAuroraWall(left: MatchedAuroraWall, right: MatchedAuroraWall | null): boolean {
  return (
    !!right &&
    left.sourceKey === right.sourceKey &&
    left.sourceBoardUuid === right.sourceBoardUuid &&
    left.boardType === right.boardType &&
    left.gymUserId === right.gymUserId &&
    left.wallUuid === right.wallUuid &&
    left.serialNumber === right.serialNumber &&
    left.layoutId === right.layoutId &&
    left.sizeId === right.sizeId &&
    left.setIds === right.setIds
  );
}

export async function importAuroraDisplays(
  wall: MatchedAuroraWall,
  displays: AuroraLiveDisplay[],
  isCurrent: (reader?: Pick<typeof db, 'select'>) => Promise<boolean>,
): Promise<number> {
  if (!(await isCurrent())) return 0;
  const validDisplays = displays.filter((display) => display.serialNumber === wall.serialNumber);
  const upstreamUuids = [...new Set(validDisplays.map((display) => display.climbUuid))];
  const aliases = upstreamUuids.length
    ? await db
        .select()
        .from(boardClimbAliases)
        .where(
          and(eq(boardClimbAliases.boardType, wall.boardType), inArray(boardClimbAliases.aliasUuid, upstreamUuids)),
        )
    : [];
  const canonicalByAlias = new Map(aliases.map((alias) => [alias.aliasUuid, alias.canonicalUuid]));
  const canonicalUuids = upstreamUuids.map((uuid) => canonicalByAlias.get(uuid) ?? uuid);
  const catalog = canonicalUuids.length
    ? await db
        .select({
          uuid: boardClimbs.uuid,
          name: boardClimbs.name,
          frames: boardClimbs.frames,
          setter: boardClimbs.setterUsername,
        })
        .from(boardClimbs)
        .where(
          and(
            eq(boardClimbs.boardType, wall.boardType),
            eq(boardClimbs.layoutId, wall.layoutId),
            publicClimbCondition(boardClimbs),
            inArray(boardClimbs.uuid, canonicalUuids),
          ),
        )
    : [];
  const climbsByUuid = new Map(catalog.map((climb) => [climb.uuid, climb]));
  let insertedCount = 0;
  for (const display of validDisplays) {
    if (!(await isCurrent())) break;
    const climbUuid = canonicalByAlias.get(display.climbUuid) ?? display.climbUuid;
    const climb = climbsByUuid.get(climbUuid);
    if (!climb) continue;
    const occurrenceKey = createHash('sha256')
      .update(
        JSON.stringify([
          'aurora',
          wall.boardType,
          wall.sourceKey,
          wall.gymUserId,
          wall.wallUuid,
          wall.serialNumber,
          display.climbUuid,
          display.displayedAt,
        ]),
      )
      .digest('hex');
    const inserted = await db.transaction(async (transaction) => {
      const [board] = await transaction
        .select({ id: userBoards.id })
        .from(userBoards)
        .where(and(eq(userBoards.id, wall.boardId), eq(userBoards.isPublic, true), isNull(userBoards.deletedAt)))
        .for('update')
        .limit(1);
      if (!board || !(await isCurrent(transaction))) return false;
      if (!sameAuroraWall(wall, await matchAuroraWall(wall.boardId, transaction))) {
        logger.warn('[AuroraLive] Import validation failed', { boardId: wall.boardId, reason: 'wall_binding_changed' });
        return false;
      }
      // A public feed has no draft-owner exception. Recheck and lock the catalog
      // after the HTTP read so publication changes cannot leak stale snapshots.
      const [currentClimb] = await transaction
        .select({ name: boardClimbs.name, frames: boardClimbs.frames, setter: boardClimbs.setterUsername })
        .from(boardClimbs)
        .where(
          and(
            eq(boardClimbs.boardType, wall.boardType),
            eq(boardClimbs.uuid, climbUuid),
            eq(boardClimbs.layoutId, wall.layoutId),
            publicClimbCondition(boardClimbs),
          ),
        )
        .for('share')
        .limit(1);
      if (!currentClimb) return false;
      const [existing] = await transaction
        .select({ id: boardClimbEvents.id })
        .from(boardClimbEvents)
        .where(and(eq(boardClimbEvents.source, 'aurora'), eq(boardClimbEvents.externalOccurrenceKey, occurrenceKey)))
        .limit(1);
      if (existing) return false;
      const seq = await reserveBoardPresenceSeq(transaction, wall.boardId, 1);
      const rows = await transaction
        .insert(boardClimbEvents)
        .values({
          boardId: wall.boardId,
          boardType: wall.boardType,
          source: 'aurora',
          externalOccurrenceKey: occurrenceKey,
          externalDisplayName: null,
          climbUuid,
          angle: null,
          confirmedAt: display.displayedAt,
          seq,
          frames: currentClimb.frames,
          name: currentClimb.name,
          setter: currentClimb.setter,
          grade: null,
        })
        .onConflictDoNothing({ target: [boardClimbEvents.source, boardClimbEvents.externalOccurrenceKey] })
        .returning({ id: boardClimbEvents.id });
      return rows.length > 0;
    });
    if (inserted) insertedCount++;
  }
  if (!(await isCurrent())) return insertedCount;
  // Rebuild on empty/duplicate reads too, recovering a lost cache without changing event identity.
  const climbs = await readImportedRecentClimbs(wall.boardId, 'aurora');
  const serialized = JSON.stringify(climbs);
  const previous = await redisClientManager
    .getClients()
    .publisher.set(`board:${wall.boardId}:aurora-history`, serialized, 'EX', HISTORY_TTL_SECONDS, 'GET');
  if (previous !== serialized && climbs.length && (await isCurrent())) {
    const seq = await pubsub.nextBoardSeq(String(wall.boardId));
    pubsub.publishBoardPresenceEvent(String(wall.boardId), { __typename: 'BoardHistoryUpdated', climbs, seq });
  }
  return insertedCount;
}
