import { and, desc, eq, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import { boardClimbs, setterFollows, userBoardMappings, userFollows } from '@boardsesh/db/schema';

const publicationText = sql`COALESCE(NULLIF(${boardClimbs.publishedAt}, ''), NULLIF(${boardClimbs.createdAt}, ''))`;
// Validate legacy imports before casting, including month lengths and offsets.
// Invalid dates are omitted rather than treated as newly published on import.
export const crewPublicationTime = sql`CASE
  WHEN ${publicationText} ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([T ]([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])?)?$' THEN
    CASE WHEN substring(${publicationText}, 9, 2)::int <= EXTRACT(day FROM (
      make_date(substring(${publicationText}, 1, 4)::int, substring(${publicationText}, 6, 2)::int, 1)
      + interval '1 month - 1 day'
    )) THEN
      CASE WHEN ${publicationText} ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
        THEN ${publicationText}::timestamptz
        ELSE ${publicationText}::timestamp AT TIME ZONE 'UTC'
      END
    END
  END`;

export type CrewClimbCandidateRow = { sourceId: string; occurredAt: string };

export function buildCrewClimbCandidatesQuery({
  viewerId,
  snapshotAt,
  before,
  limit,
}: {
  viewerId: string;
  snapshotAt: string;
  before?: { occurredAt: string; id: string } | null;
  limit: number;
}) {
  const queryBuilder = new QueryBuilder();
  // Match followedAuthorCondition's three membership rules, but start with
  // authors so each branch can use an author index instead of OR-ed EXISTS
  // across the catalogue. UNION deduplicates overlapping follow paths.
  const columns = {
    uuid: boardClimbs.uuid,
    boardType: boardClimbs.boardType,
    layoutId: boardClimbs.layoutId,
    publishedAt: boardClimbs.publishedAt,
    createdAt: boardClimbs.createdAt,
  };
  const published = and(
    eq(boardClimbs.isListed, true),
    eq(boardClimbs.isDraft, false),
    eq(boardClimbs.isHidden, false),
  );
  const setterClimbs = queryBuilder
    .select(columns)
    .from(setterFollows)
    .innerJoin(boardClimbs, eq(boardClimbs.setterUsername, setterFollows.setterUsername))
    .where(and(eq(setterFollows.followerId, viewerId), published));
  const nativeClimbs = queryBuilder
    .select(columns)
    .from(userFollows)
    .innerJoin(boardClimbs, eq(boardClimbs.userId, userFollows.followingId))
    .where(and(eq(userFollows.followerId, viewerId), published));
  const linkedClimbs = queryBuilder
    .select(columns)
    .from(userFollows)
    .innerJoin(userBoardMappings, eq(userBoardMappings.userId, userFollows.followingId))
    .innerJoin(
      boardClimbs,
      and(
        eq(boardClimbs.boardType, userBoardMappings.boardType),
        eq(boardClimbs.setterUsername, userBoardMappings.boardUsername),
      ),
    )
    .where(and(eq(userFollows.followerId, viewerId), published));
  const followedClimbs = setterClimbs.union(nativeClimbs).union(linkedClimbs);
  const candidates = queryBuilder
    .select({
      sourceId: sql<string>`${boardClimbs.uuid}`.as('sourceId'),
      occurredAt: sql<string>`to_char(${crewPublicationTime} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'occurredAt',
      ),
    })
    .from(sql`crew_followed_climbs AS board_climbs`)
    .where(
      and(
        sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId),
        sql`${crewPublicationTime} >= ${snapshotAt}::timestamptz - interval '30 days'`,
        sql`${crewPublicationTime} <= ${snapshotAt}::timestamptz`,
        ...(before
          ? [
              sql`(${crewPublicationTime}, ('climb:' || ${boardClimbs.uuid}) COLLATE "C") < (${before.occurredAt}::timestamptz, ${before.id} COLLATE "C")`,
            ]
          : []),
      ),
    )
    .orderBy(desc(crewPublicationTime), sql`${boardClimbs.uuid} COLLATE "C" DESC`)
    .limit(limit + 1);
  // Drizzle's WITH builder cannot express MATERIALIZED. The optimization fence
  // is essential: date parsing must run only on followed climbs, never get
  // pushed back into a scan of ~900k catalogue rows. Keep the CTE narrow (no
  // frames/descriptions); enrichment still rechecks visibility and membership.
  return sql`WITH crew_followed_climbs AS MATERIALIZED (${followedClimbs}) ${candidates}`;
}
