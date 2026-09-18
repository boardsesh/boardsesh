import { and, eq, getTableName, sql, type SQL } from 'drizzle-orm';
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

/**
 * Who a climb is filed under in the feed, as one comparable string.
 *
 * `setter_username` is the name the card shows and the key two of the three
 * follow paths match on, so it leads. A native climb can carry a null username
 * (the author only exists as a Boardsesh account), and those fall back to the
 * user id — otherwise every accountless-username climb in the window would
 * collapse into one group under SQL's "all NULLs are one group" rule.
 */
const crewAuthorKey = sql`COALESCE(NULLIF(${boardClimbs.setterUsername}, ''), 'user:' || ${boardClimbs.userId})`;

/** How a moment is spelled on the wire, everywhere in this feed. */
const isoUtc = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One row per (board, author, local day) — the card the feed draws, not the
 * climb. Grouping happens here rather than after the page is cut, so a setter's
 * day can never be split across two pages.
 */
export type CrewClimbCandidateRow = {
  groupId: string;
  boardType: string;
  authorKey: string;
  day: string;
  occurredAt: string;
  climbCount: number;
};

/** The `(board, author, day)` tuple that identifies one group's climbs. */
export type CrewClimbGroupKey = Pick<CrewClimbCandidateRow, 'boardType' | 'authorKey' | 'day'>;

/**
 * Every published climb by an author the viewer follows, as a narrow row set.
 *
 * Both phases of the feed start here so their membership cannot drift: the
 * candidate query groups it, and the per-group climb query ranks within it.
 */
function followedClimbsSelect(viewerId: string) {
  const queryBuilder = new QueryBuilder();
  // Match followedAuthorCondition's three membership rules, but start with
  // authors so each branch can use an author index instead of OR-ed EXISTS
  // across the catalogue. UNION deduplicates overlapping follow paths.
  // Membership source: packages/db/src/queries/climbs/followed-authors.ts.
  // The candidates tests compare this query against that shared predicate.
  const columns = {
    uuid: boardClimbs.uuid,
    boardType: boardClimbs.boardType,
    layoutId: boardClimbs.layoutId,
    userId: boardClimbs.userId,
    setterUsername: boardClimbs.setterUsername,
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
  return setterClimbs.union(nativeClimbs).union(linkedClimbs);
}

export function buildCrewClimbCandidatesQuery({
  viewerId,
  snapshotAt,
  before,
  limit,
  timeZone,
}: {
  viewerId: string;
  snapshotAt: string;
  before?: { occurredAt: string; id: string } | null;
  limit: number;
  /** A zone Postgres knows; the resolver rejects anything else before we get here. */
  timeZone: string;
}) {
  const followedClimbs = followedClimbsSelect(viewerId);

  // Every climb the viewer may see in the window, with its publication instant
  // parsed exactly once. MATERIALIZED for the same reason the CTE above is: the
  // aggregate below reads `pub` five times (select, group, having, order), and
  // an inlined CTE would re-expand that CASE ladder at each one.
  const visibleRows = sql`
    SELECT
      ${crewAuthorKey} AS author_key,
      ${boardClimbs.boardType} AS board_type,
      ${crewPublicationTime} AS pub
    FROM crew_followed_climbs AS ${sql.identifier(getTableName(boardClimbs))}
    WHERE ${sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId)}
      AND ${crewPublicationTime} >= ${snapshotAt}::timestamptz - interval '30 days'
      AND ${crewPublicationTime} <= ${snapshotAt}::timestamptz`;

  const groupId = sql`('climbgroup:' || board_type || ':' || author_key || ':' || day)`;
  // The cursor compares against the group's NEWEST climb, so it has to be a
  // HAVING. As a WHERE it would drop a group's recent members while keeping the
  // older ones, move max(pub) backwards, and hand the same setter a second card
  // on a later page.
  const cursor = before
    ? sql`HAVING (max(pub), ${groupId} COLLATE "C") < (${before.occurredAt}::timestamptz, ${before.id} COLLATE "C")`
    : sql``;

  const candidates = sql`
    SELECT
      ${groupId} AS "groupId",
      board_type AS "boardType",
      author_key AS "authorKey",
      day::text AS "day",
      ${isoUtc(sql`max(pub)`)} AS "occurredAt",
      count(*)::int AS "climbCount"
    FROM (SELECT author_key, board_type, pub, (pub AT TIME ZONE ${timeZone})::date AS day FROM crew_climb_rows) AS day_rows
    GROUP BY board_type, author_key, day
    ${cursor}
    ORDER BY max(pub) DESC, ${groupId} COLLATE "C" DESC
    LIMIT ${limit + 1}`;

  // Drizzle's WITH builder cannot express MATERIALIZED, and its select builder
  // cannot express a HAVING over an aggregate tuple — hence the raw tail. The
  // optimization fence is essential: date parsing must run only on followed
  // climbs, never get pushed back into a scan of ~900k catalogue rows. Keep the
  // CTE narrow (no frames/descriptions); enrichment still rechecks visibility.
  return sql`WITH crew_followed_climbs AS MATERIALIZED (${followedClimbs}), crew_climb_rows AS MATERIALIZED (${visibleRows}) ${candidates}`;
}

/**
 * The climbs behind a page of groups, newest first within each group and capped
 * at `perGroup`.
 *
 * Separate from the candidate query because it runs only on the groups that
 * survived the page cut — fetching every followed climb's frames to throw most
 * of them away is what the two-phase shape exists to avoid.
 */
export function buildCrewGroupClimbsQuery({
  viewerId,
  snapshotAt,
  groups,
  timeZone,
  perGroup,
}: {
  viewerId: string;
  snapshotAt: string;
  groups: CrewClimbGroupKey[];
  timeZone: string;
  perGroup: number;
}) {
  const followedClimbs = followedClimbsSelect(viewerId);
  const day = sql`(${crewPublicationTime} AT TIME ZONE ${timeZone})::date`;
  const keys = sql.join(
    groups.map((group) => sql`(${group.boardType}, ${group.authorKey}, ${group.day}::date)`),
    sql`, `,
  );
  // The same MATERIALIZED fence as the candidate query, and for the same
  // reason: without it the tuple match below — an expression the planner has no
  // index for — becomes a scan of the whole catalogue.
  const ranked = sql`
    SELECT
      ${boardClimbs.uuid} AS uuid,
      ${boardClimbs.boardType} AS board_type,
      ${crewAuthorKey} AS author_key,
      ${day} AS day,
      ${isoUtc(crewPublicationTime)} AS occurred_at,
      row_number() OVER (
        PARTITION BY ${boardClimbs.boardType}, ${crewAuthorKey}, ${day}
        ORDER BY ${crewPublicationTime} DESC, ${boardClimbs.uuid} COLLATE "C" DESC
      ) AS rank
    FROM crew_followed_climbs AS ${sql.identifier(getTableName(boardClimbs))}
    WHERE ${sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId)}
      AND ${crewPublicationTime} >= ${snapshotAt}::timestamptz - interval '30 days'
      AND ${crewPublicationTime} <= ${snapshotAt}::timestamptz
      AND (${boardClimbs.boardType}, ${crewAuthorKey}, ${day}) IN (${keys})`;
  return sql`WITH crew_followed_climbs AS MATERIALIZED (${followedClimbs})
    SELECT uuid, board_type AS "boardType", author_key AS "authorKey", day::text AS "day",
           occurred_at AS "occurredAt", rank::int AS "rank"
    FROM (${ranked}) AS ranked
    WHERE rank <= ${perGroup}`;
}

export type CrewGroupClimbRow = CrewClimbGroupKey & {
  uuid: string;
  /** The climb's publication instant, normalised the same way a group's is. */
  occurredAt: string;
  /** 1-based position within its group, newest first. */
  rank: number;
};
