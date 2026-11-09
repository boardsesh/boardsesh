import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { resolveRenderBoard, type RenderBoardConfig } from '@boardsesh/board-config';
import { db } from '../../db/client';
import { sessionTickVisibleCondition } from '../../graphql/resolvers/shared/activity-privacy';
import { fetchOwnerBoards, toTickBoardCandidate } from '../../graphql/resolvers/shared/render-board';
import { sessionVisibleUserIds } from '../board-session-privacy';
import { canAccessResource } from '../privacy';

/**
 * How many of a session's ticks the recap considers, newest first. The privacy
 * rules are correlated subqueries, so a session of a few thousand ticks costs as
 * much as `sessionDetail`. Past this the card says so (`1,000+`) instead of
 * pretending it counted them all.
 */
export const RECAP_TICKS_CONSIDERED = 1000;

export type RecapGradeRow = { difficulty: number; flashes: number; sends: number };

export type RecapFeaturedTick = {
  status: string;
  /** Only ever a name the anonymous roster rule allows, so a masked climber is not credited. */
  climberName: string | null;
  climbName: string | null;
  boardType: string;
  angle: number;
  difficulty: number | null;
  frames: string | null;
  renderBoard: RenderBoardConfig | null;
};

export type SessionRecapRead = {
  sends: number;
  flashes: number;
  attempts: number;
  capped: boolean;
  gradeRows: RecapGradeRow[];
  featured: RecapFeaturedTick | null;
  participants: { name: string | null; sends: number }[];
  durationMinutes: number | null;
};

/** The anonymous rule for reading this session at all. Runs on every request. */
export function canViewSessionRecap(sessionId: string): Promise<boolean> {
  return canAccessResource('session', sessionId, undefined);
}

function effectiveDifficulty(logged: number | null, consensus: number | null): number | null {
  if (logged !== null) return logged;
  return consensus !== null ? Math.round(consensus) : null;
}

/**
 * Everything the recap card draws, from one bounded read of the ticks a stranger
 * may see. `sessionDetail` answers the same question with every tick's votes,
 * clips and attempt totals, in front of every cache; this reads only the columns
 * the card uses, with the anonymous rules applied where the rows are chosen.
 *
 * A policy read, so the primary: a lagging replica must not restore a revoked tick.
 */
export async function readSessionRecap(sessionId: string): Promise<SessionRecapRead | null> {
  const ticks = dbSchema.boardseshTicks;
  const climbs = dbSchema.boardClimbs;
  const aliases = dbSchema.boardClimbAliases;
  const stats = dbSchema.boardClimbStats;

  const rows = await db
    .select({
      userId: ticks.userId,
      status: ticks.status,
      attemptCount: ticks.attemptCount,
      difficulty: ticks.difficulty,
      boardType: ticks.boardType,
      angle: ticks.angle,
      climbedAt: ticks.climbedAt,
      consensusDifficulty: stats.displayDifficulty,
      climbName: climbs.name,
      climbIsHidden: climbs.isHidden,
      layoutId: climbs.layoutId,
      frames: climbs.frames,
      compatibleSizeIds: climbs.compatibleSizeIds,
      requiredSetIds: climbs.requiredSetIds,
      boardLayoutId: dbSchema.userBoards.layoutId,
      boardSizeId: dbSchema.userBoards.sizeId,
      boardSetIds: dbSchema.userBoards.setIds,
    })
    .from(ticks)
    .leftJoin(dbSchema.userBoards, eq(ticks.boardId, dbSchema.userBoards.id))
    // Same alias resolution as `sessionDetail`: a tick can point at a climb that
    // was deduplicated away. An inner join, so a tick whose climb row is gone (a
    // hard-deleted spray climb) simply has no row to draw.
    .leftJoin(aliases, and(eq(ticks.climbUuid, aliases.aliasUuid), eq(ticks.boardType, aliases.boardType)))
    .innerJoin(
      climbs,
      and(
        sql`COALESCE(${aliases.canonicalUuid}, ${ticks.climbUuid}) = ${climbs.uuid}`,
        eq(ticks.boardType, climbs.boardType),
      ),
    )
    .leftJoin(
      stats,
      and(
        sql`COALESCE(${aliases.canonicalUuid}, ${ticks.climbUuid}) = ${stats.climbUuid}`,
        eq(ticks.boardType, stats.boardType),
        eq(ticks.angle, stats.angle),
      ),
    )
    .where(
      and(
        eq(ticks.sessionId, sessionId),
        // Covers the tick's audience and its climb: draft, unlisted and private spray walls.
        sessionTickVisibleCondition(null),
      ),
    )
    .orderBy(desc(ticks.climbedAt))
    .limit(RECAP_TICKS_CONSIDERED + 1);

  if (rows.length === 0) return null;

  const capped = rows.length > RECAP_TICKS_CONSIDERED;
  const considered = capped ? rows.slice(0, RECAP_TICKS_CONSIDERED) : rows;

  const isSend = (status: string) => status === 'flash' || status === 'send';
  const graded = considered.map((row) => ({
    ...row,
    effectiveDifficulty: effectiveDifficulty(row.difficulty, row.consensusDifficulty),
  }));
  const sendRows = graded.filter((row) => isSend(row.status));
  const flashes = sendRows.filter((row) => row.status === 'flash').length;

  const gradeRowsByDifficulty = new Map<number, RecapGradeRow>();
  for (const row of sendRows) {
    if (row.effectiveDifficulty === null) continue;
    const gradeRow = gradeRowsByDifficulty.get(row.effectiveDifficulty) ?? {
      difficulty: row.effectiveDifficulty,
      flashes: 0,
      sends: 0,
    };
    if (row.status === 'flash') gradeRow.flashes += 1;
    else gradeRow.sends += 1;
    gradeRowsByDifficulty.set(row.effectiveDifficulty, gradeRow);
  }
  const gradeRows = [...gradeRowsByDifficulty.values()].sort((first, second) => second.difficulty - first.difficulty);

  const hardestOf = (candidates: typeof graded) =>
    candidates
      .filter((row) => row.effectiveDifficulty !== null)
      .reduce<(typeof graded)[number] | null>(
        (best, row) => (best === null || row.effectiveDifficulty! > best.effectiveDifficulty! ? row : best),
        null,
      );
  // A community-hidden climb still counts, as it does on the session page, but it
  // is never the one the card puts forward. Attempts only headline a session with
  // no sends at all, so a session whose sends are all hidden features nothing.
  const featurable = (candidates: typeof graded) => candidates.filter((row) => !row.climbIsHidden);
  const featurableSends = featurable(sendRows);
  const featurableTicks = featurable(graded);
  const featuredRow =
    sendRows.length > 0
      ? (hardestOf(featurableSends) ?? featurableSends[0] ?? null)
      : (hardestOf(featurableTicks) ?? featurableTicks[0] ?? null);

  const sendsByUser = new Map<string, number>();
  for (const row of graded) {
    sendsByUser.set(row.userId, (sendsByUser.get(row.userId) ?? 0) + (isSend(row.status) ? 1 : 0));
  }
  const nameableIds = await sessionVisibleUserIds([...sendsByUser.keys()], null, sessionId);
  const nameRows =
    nameableIds.size > 0
      ? await db
          .select({
            id: dbSchema.users.id,
            name: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
          })
          .from(dbSchema.users)
          .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
          .where(inArray(dbSchema.users.id, [...nameableIds]))
      : [];
  const nameById = new Map(nameRows.map((row) => [row.id, row.name]));
  const participants = [...sendsByUser]
    .map(([userId, sends]) => ({ userId, name: nameById.get(userId)?.trim() || null, sends }))
    .sort((first, second) => second.sends - first.sends);

  let renderBoard: RenderBoardConfig | null = null;
  if (featuredRow && featuredRow.layoutId !== null) {
    const ownerBoards = (await fetchOwnerBoards([featuredRow.userId])).get(featuredRow.userId) ?? [];
    renderBoard = resolveRenderBoard({
      boardType: featuredRow.boardType,
      climbLayoutId: featuredRow.layoutId,
      compatibleSizeIds: featuredRow.compatibleSizeIds,
      requiredSetIds: featuredRow.requiredSetIds,
      tickBoard: toTickBoardCandidate({
        boardType: featuredRow.boardType,
        layoutId: featuredRow.boardLayoutId,
        sizeId: featuredRow.boardSizeId,
        setIds: featuredRow.boardSetIds,
      }),
      ownerBoards,
    });
  }

  const timestamps = considered.map((row) => new Date(row.climbedAt).getTime());
  const durationMinutes = Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60_000) || null;

  return {
    sends: sendRows.length,
    flashes,
    attempts: graded.filter((row) => row.status === 'attempt').reduce((sum, row) => sum + row.attemptCount, 0),
    capped,
    gradeRows,
    featured: featuredRow
      ? {
          status: featuredRow.status,
          climberName: nameById.get(featuredRow.userId)?.trim() || null,
          climbName: featuredRow.climbName,
          boardType: featuredRow.boardType,
          angle: featuredRow.angle,
          difficulty: featuredRow.effectiveDifficulty,
          frames: featuredRow.frames,
          renderBoard,
        }
      : null,
    participants: participants.map(({ name, sends }) => ({ name, sends })),
    durationMinutes,
  };
}
