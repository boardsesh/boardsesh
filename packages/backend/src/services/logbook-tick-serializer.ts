import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { TickSchema, type Grade, type Tick } from '@boardsesh/public-api';
import { BOARD_TYPE_LABELS } from '@boardsesh/board-constants';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import { boardClimbStats, boardClimbs, boardLayouts } from '@boardsesh/db/schema';
import type { FeedTransaction, LogbookFeedTick } from './logbook-feed';

/**
 * Turns the columns the feed and the snapshot store (`LogbookFeedTick`) into
 * the public tick (`@boardsesh/public-api`'s `TickSchema`). The field sources
 * are the table in docs/integration-platform.md, "The tick".
 *
 * Climb metadata is read at delivery, in the page's own read transaction, so a
 * snapshot made before a spray wall went private never serves its old names:
 * the stored tick keeps its values and identity, and its public metadata is
 * read again under today's rules.
 *
 * Every climb the climber has logged is served, including a draft or an
 * unlisted climb someone else set: the climber's logbook is theirs, and an app
 * they connected sees all of it (owner decision, 2026-11-10). The one exception
 * is the documented spray-wall rule below.
 */

/** What `climb.board.layout` says when the wall's name is withheld. */
export const WITHHELD_LAYOUT_NAME = 'Spray wall';

export interface LogbookClimbRecord {
  name: string | null;
  layoutName: string | null;
  /**
   * False for a climb on someone else's spray wall that is not public, and for
   * a spray tick whose climb row is gone (no wall left to check): the owner
   * shared the wall with the climber, not with the climber's apps.
   */
  namesVisible: boolean;
}

/** The metadata one page needs, keyed so every tick finds its climb and its community grade. */
export interface LogbookClimbMetadata {
  climbs: Map<string, LogbookClimbRecord>;
  /** `board_climb_stats.display_difficulty` at the tick's angle, on the difficulty-id scale. */
  communityDifficulty: Map<string, number | null>;
}

const climbKey = (boardType: string, climbUuid: string) => `${boardType}\u0000${climbUuid}`;
const angleKey = (boardType: string, climbUuid: string, angle: number) =>
  `${boardType}\u0000${climbUuid}\u0000${angle}`;

/**
 * A spray climb shows its names only to apps of the wall's owner, or when the
 * wall is public: the by-layout rule with no viewer, so a gym membership, a
 * follow or a grant the climber holds is not passed on to their apps. Every
 * other board type always shows its names.
 */
function namesVisibleTo(userId: string): SQL<boolean> {
  return sql<boolean>`CASE WHEN ${boardClimbs.boardType} IS DISTINCT FROM 'spray' THEN true ELSE (
    EXISTS (
      SELECT 1
      FROM spray_walls owned_wall
      JOIN user_boards owned_board ON owned_board.uuid = owned_wall.board_uuid
      WHERE owned_wall.layout_id = ${boardClimbs.layoutId}
        AND owned_board.owner_id = ${userId}::text
    )
    OR ${sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, null)}
  ) END`;
}

/**
 * Two batched reads for a page: the climbs (name, layout, whether names show)
 * and their community grade at each tick's angle. Never one query per tick.
 */
export async function readLogbookClimbMetadata(
  transaction: FeedTransaction,
  userId: string,
  ticks: readonly LogbookFeedTick[],
): Promise<LogbookClimbMetadata> {
  const metadata: LogbookClimbMetadata = { climbs: new Map(), communityDifficulty: new Map() };
  if (ticks.length === 0) return metadata;

  const climbUuids = [...new Set(ticks.map((tick) => tick.canonicalClimbUuid))];
  const climbRows = await transaction
    .select({
      boardType: boardClimbs.boardType,
      uuid: boardClimbs.uuid,
      name: boardClimbs.name,
      layoutName: boardLayouts.name,
      namesVisible: namesVisibleTo(userId),
    })
    .from(boardClimbs)
    .leftJoin(
      boardLayouts,
      and(eq(boardLayouts.boardType, boardClimbs.boardType), eq(boardLayouts.id, boardClimbs.layoutId)),
    )
    .where(inArray(boardClimbs.uuid, climbUuids));
  for (const row of climbRows) {
    metadata.climbs.set(climbKey(row.boardType, row.uuid), {
      name: row.name,
      layoutName: row.layoutName,
      namesVisible: row.namesVisible,
    });
  }

  const wanted = new Map<string, { boardType: string; climbUuid: string; angle: number }>();
  for (const tick of ticks) {
    wanted.set(angleKey(tick.boardType, tick.canonicalClimbUuid, tick.angle), {
      boardType: tick.boardType,
      climbUuid: tick.canonicalClimbUuid,
      angle: tick.angle,
    });
  }
  const triples = sql.join(
    [...wanted.values()].map(
      ({ boardType, climbUuid, angle }) => sql`(${boardType}::text, ${climbUuid}::text, ${angle}::int)`,
    ),
    sql`, `,
  );
  const statsRows = await transaction
    .select({
      boardType: boardClimbStats.boardType,
      climbUuid: boardClimbStats.climbUuid,
      angle: boardClimbStats.angle,
      displayDifficulty: boardClimbStats.displayDifficulty,
    })
    .from(boardClimbStats)
    .where(sql`(${boardClimbStats.boardType}, ${boardClimbStats.climbUuid}, ${boardClimbStats.angle}) IN (${triples})`);
  for (const row of statsRows) {
    metadata.communityDifficulty.set(angleKey(row.boardType, row.climbUuid, row.angle), row.displayDifficulty);
  }
  return metadata;
}

const V_GRADE = /^V(\d+)$/;

/**
 * The grade object for a difficulty id on this board's own table: the V grade
 * as an integer, the Font grade upper-cased, and the board's label
 * (`board_difficulty_grades.boulder_name`). Null when there is no grade or the
 * id is off the table, rather than a grade nobody set.
 */
export function logbookGrade(boardType: string, difficulty: number | null): Grade | null {
  if (difficulty === null || !Number.isFinite(difficulty)) return null;
  const difficultyId = Math.round(difficulty);
  const grade = getBoulderGradesForBoard(boardType).find((candidate) => candidate.difficulty_id === difficultyId);
  if (!grade) return null;
  const vGrade = V_GRADE.exec(grade.v_grade);
  return { v: vGrade ? Number(vGrade[1]) : null, font: grade.font_grade.toUpperCase(), label: grade.difficulty_name };
}

/**
 * Stored ticks carry `timestamp without time zone` values, which hold UTC
 * (`normalizeClimbedAt`), as `2026-10-20 18:42:11.123456`. RFC 3339 in UTC,
 * to the millisecond.
 */
export function utcTimestamp(stored: string): string {
  const parsed = new Date(`${stored.trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) throw new RangeError('A stored tick timestamp is not a timestamp');
  return parsed.toISOString();
}

/**
 * One public tick. Throws if the result would break the contract, so nothing
 * outside it (an origin, a session id, a user id) can ever be sent.
 *
 * `climb.boardseshGrade` is always null. The Boardsesh grade lives on the
 * difficulty-id scale (docs/boardsesh-grade.md), and no conversion to the
 * decimal V scale the contract describes is documented, so none is invented.
 */
export function serializeLogbookTick(tick: LogbookFeedTick, metadata: LogbookClimbMetadata): Tick {
  const climb = metadata.climbs.get(climbKey(tick.boardType, tick.canonicalClimbUuid));
  const communityDifficulty =
    metadata.communityDifficulty.get(angleKey(tick.boardType, tick.canonicalClimbUuid, tick.angle)) ?? null;
  // A spray tick with no climb row has no wall left to check, so it withholds.
  const namesVisible = climb ? climb.namesVisible : tick.boardType !== 'spray';
  const layout = namesVisible
    ? climb?.layoutName?.trim() || BOARD_TYPE_LABELS[tick.boardType] || tick.boardType
    : WITHHELD_LAYOUT_NAME;

  return TickSchema.parse({
    id: tick.uuid,
    climbedAt: utcTimestamp(tick.climbedAt),
    status: tick.status,
    attempts: Math.max(0, tick.attemptCount),
    angle: tick.angle,
    mirrored: tick.isMirror ?? false,
    stars: tick.quality !== null && tick.quality >= 1 && tick.quality <= 5 ? tick.quality : null,
    grade: logbookGrade(tick.boardType, tick.difficulty),
    benchmark: tick.isBenchmark ?? false,
    comment: tick.comment?.trim() ? tick.comment : null,
    climb: {
      id: tick.canonicalClimbUuid,
      name: namesVisible ? (climb?.name?.trim() ? climb.name : null) : null,
      board: { type: tick.boardType, layout },
      grade: logbookGrade(tick.boardType, communityDifficulty),
      boardseshGrade: null,
    },
    createdAt: utcTimestamp(tick.createdAt),
    updatedAt: utcTimestamp(tick.updatedAt),
  });
}
