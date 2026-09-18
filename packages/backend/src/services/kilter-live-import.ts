import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  boardClimbAliases,
  boardClimbs,
  boardClimbStats,
  boardDifficultyGrades,
  boardClimbEvents,
  kilterWallSources,
  locationSyncGymSources,
  userBoards,
} from '@boardsesh/db/schema';
import type { KilterLiveDisplay, KilterWallSelection } from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { reserveBoardPresenceSeq } from '../graphql/resolvers/board-presence/shared';
import { HISTORY_TTL_SECONDS, readImportedRecentClimbs } from './board-history';
import { logger } from '../utils/logger';

export type MatchedKilterWall = KilterWallSelection & { sourceKey: string; boardId: number; layoutId: number };

/** Reverse the bounded merge chain, then require exactly one matching source. */
export async function matchKilterWall(
  boardId: number,
  reader: Pick<typeof db, 'select'> = db,
): Promise<MatchedKilterWall | null> {
  const [board] = await reader
    .select()
    .from(userBoards)
    .where(and(eq(userBoards.id, boardId), isNull(userBoards.deletedAt)))
    .limit(1);
  if (!board || board.boardType !== 'kilter' || !board.isPublic) return null;
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
    .from(kilterWallSources)
    .where(and(inArray(kilterWallSources.sourceBoardUuid, [...sourceUuids]), eq(kilterWallSources.isListed, true)));
  if (mappings.length !== 1) return null;
  const mapping = mappings[0];
  const [gymSource] = await reader
    .select({ gymId: locationSyncGymSources.gymId })
    .from(locationSyncGymSources)
    .where(eq(locationSyncGymSources.sourceKey, `kilter:${mapping.gymUuid}`))
    .limit(1);
  if (!gymSource || gymSource.gymId !== board.gymId) return null;
  const normalizeSets = (setIds: string) =>
    setIds
      .split(',')
      .map(Number)
      .sort((left, right) => left - right)
      .join(',');
  if (
    mapping.layoutId !== board.layoutId ||
    mapping.sizeId !== board.sizeId ||
    normalizeSets(mapping.setIds) !== normalizeSets(board.setIds)
  )
    return null;
  return {
    gymUuid: mapping.gymUuid,
    productLayoutUuid: mapping.productLayoutUuid,
    wallUuid: mapping.wallUuid,
    sourceKey: mapping.sourceKey,
    boardId,
    layoutId: board.layoutId,
  };
}

export async function importKilterDisplays(
  wall: MatchedKilterWall,
  displays: KilterLiveDisplay[],
  isCurrent: () => Promise<boolean>,
): Promise<number> {
  if (!displays.length || !(await isCurrent())) return 0;
  const upstreamUuids = [...new Set(displays.map((display) => display.climbUuid))];
  const aliases = await db
    .select()
    .from(boardClimbAliases)
    .where(and(eq(boardClimbAliases.boardType, 'kilter'), inArray(boardClimbAliases.aliasUuid, upstreamUuids)));
  const canonicalByAlias = new Map(aliases.map((alias) => [alias.aliasUuid, alias.canonicalUuid]));
  const canonicalUuids = upstreamUuids.map((uuid) => canonicalByAlias.get(uuid) ?? uuid);
  const catalog = await db
    .select({
      uuid: boardClimbs.uuid,
      name: boardClimbs.name,
      frames: boardClimbs.frames,
      setter: boardClimbs.setterUsername,
      angle: boardClimbStats.angle,
      grade: boardDifficultyGrades.boulderName,
    })
    .from(boardClimbs)
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, boardClimbs.boardType),
        eq(boardClimbStats.climbUuid, boardClimbs.uuid),
        inArray(boardClimbStats.angle, [...new Set(displays.map((display) => display.angle))]),
      ),
    )
    .leftJoin(
      boardDifficultyGrades,
      and(
        eq(boardDifficultyGrades.boardType, boardClimbStats.boardType),
        eq(boardDifficultyGrades.difficulty, sql`ROUND(${boardClimbStats.displayDifficulty})`),
      ),
    )
    .where(
      and(
        eq(boardClimbs.boardType, 'kilter'),
        eq(boardClimbs.layoutId, wall.layoutId),
        inArray(boardClimbs.uuid, canonicalUuids),
      ),
    );
  // Climb identity/geometry is angle-independent. A missing angle-specific
  // stats row still permits history, but must never borrow another angle's grade.
  const climbsByUuid = new Map(catalog.map(({ uuid, name, frames, setter }) => [uuid, { name, frames, setter }]));
  const climbsByAngle = new Map(catalog.map((climb) => [`${climb.uuid}:${climb.angle}`, climb]));
  let insertedCount = 0;
  const warnedReasons = new Set<string>();
  const warnValidationFailure = (reason: string) => {
    if (warnedReasons.has(reason)) return;
    warnedReasons.add(reason);
    logger.warn('[KilterLive] Import validation failed', { boardId: wall.boardId, sourceKey: wall.sourceKey, reason });
  };
  for (const display of displays) {
    if (!(await isCurrent())) break;
    const climbUuid = canonicalByAlias.get(display.climbUuid) ?? display.climbUuid;
    const climb = climbsByUuid.get(climbUuid);
    if (!climb) continue;
    const inserted = await db.transaction(async (transaction) => {
      // Same board row lock as native reports and board merges. Revalidate public scope.
      const [board] = await transaction
        .select({ id: userBoards.id, layoutId: userBoards.layoutId })
        .from(userBoards)
        .where(and(eq(userBoards.id, wall.boardId), eq(userBoards.isPublic, true), isNull(userBoards.deletedAt)))
        .for('update')
        .limit(1);
      if (!board || board.layoutId !== wall.layoutId) {
        warnValidationFailure('board_unavailable_or_layout_changed');
        return false;
      }
      if (!(await isCurrent())) return false;
      const currentWall = await matchKilterWall(wall.boardId, transaction);
      if (
        !currentWall ||
        currentWall.sourceKey !== wall.sourceKey ||
        currentWall.gymUuid !== wall.gymUuid ||
        currentWall.wallUuid !== wall.wallUuid ||
        currentWall.productLayoutUuid !== wall.productLayoutUuid
      ) {
        warnValidationFailure('wall_binding_changed');
        return false;
      }
      const [existing] = await transaction
        .select({ id: boardClimbEvents.id })
        .from(boardClimbEvents)
        .where(
          and(eq(boardClimbEvents.source, 'kilter'), eq(boardClimbEvents.externalOccurrenceKey, display.occurrenceKey)),
        )
        .limit(1);
      if (existing) return false;
      const seq = await reserveBoardPresenceSeq(transaction, wall.boardId, 1);
      const rows = await transaction
        .insert(boardClimbEvents)
        .values({
          boardId: wall.boardId,
          boardType: 'kilter',
          source: 'kilter',
          externalOccurrenceKey: display.occurrenceKey,
          externalDisplayName: display.displayName,
          climbUuid,
          angle: display.angle,
          confirmedAt: display.displayedAt,
          seq,
          frames: climb.frames,
          name: climb.name,
          setter: climb.setter,
          grade: climbsByAngle.get(`${climbUuid}:${display.angle}`)?.grade ?? null,
        })
        .onConflictDoNothing({ target: [boardClimbEvents.source, boardClimbEvents.externalOccurrenceKey] })
        .returning({ id: boardClimbEvents.id });
      return rows.length > 0;
    });
    if (inserted) insertedCount++;
  }
  if (!(await isCurrent())) return insertedCount;
  // Rebuild even on duplicate polls: a previous commit may have outlived Redis.
  const climbs = await readImportedRecentClimbs(wall.boardId);
  const publisher = redisClientManager.getClients().publisher;
  const serialized = JSON.stringify(climbs);
  const previous = await publisher.set(
    `board:${wall.boardId}:kilter-history`,
    serialized,
    'EX',
    HISTORY_TTL_SECONDS,
    'GET',
  );
  if (previous !== serialized && climbs.length && (await isCurrent())) {
    const seq = await pubsub.nextBoardSeq(String(wall.boardId));
    pubsub.publishBoardPresenceEvent(String(wall.boardId), { __typename: 'BoardHistoryUpdated', climbs, seq });
  }
  return insertedCount;
}
