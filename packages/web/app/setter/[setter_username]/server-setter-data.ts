import 'server-only';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getClimbStars, getGradeLabel, withSerialPlan, type SerialPlanDb } from '@boardsesh/db/queries';
import { dbzRead, executeRows } from '@/app/lib/db/db';
import { boardClimbs, boardClimbStats } from '@/app/lib/db/schema';
import { publishableAngleWhere, publishedAngleOrderBy } from '@/app/lib/seo/sitemap/published-angle';
import { SETTER_PAGE_SIZE } from '@/app/lib/seo/sitemap/setter-page-contract';
import type { Climb } from '@/app/lib/types';

/**
 * The setter front door's own data layer, reading Postgres directly the way
 * `profile/[user_id]/server-profile-data.ts` and `lib/data/list-page-data.server.ts`
 * do.
 *
 * It is deliberately NOT the `setterProfile` / `setterClimbsFull` GraphQL pair
 * the client component used, for two reasons that both matter on an indexable
 * page:
 *
 *  1. Those resolvers carried no `is_listed` / `is_draft` predicate, so they
 *     hand back a setter's drafts and unlisted climbs. (Fixed in the same
 *     change — but a page that publishes a crawlable list must own its own
 *     visibility rule rather than inherit one.)
 *  2. `setterClimbsFull` returns no `compatible_size_ids` / `required_set_ids`,
 *     and a setter's climbs span layouts. Without those two arrays there is no
 *     way to prove a climb actually renders on the configuration its link
 *     names, which is how a page ends up linking every climb to a URL the
 *     climbs sitemap never submitted.
 */

/**
 * One climb of this setter's, with the two array columns the canonical-config
 * resolver needs on top of the ordinary `Climb` fields.
 */
export type SetterClimbRow = Climb & {
  layoutId: number;
  boardType: string;
  compatibleSizeIds: number[];
  requiredSetIds: number[];
  updatedAt: Date;
};

export type SetterPageData = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  boardTypes: string[];
  /** Publicly visible climbs only — the same count the page 404s on when it is 0. */
  climbCount: number;
  followerCount: number;
  climbs: SetterClimbRow[];
  hasMore: boolean;
};

/**
 * The single visibility predicate. Both builders below call it, so the count
 * that decides "does this page exist" and the list that decides "what does it
 * show" can never describe different sets of climbs — a divergence that would
 * render a 200 with an empty list, or 404 a setter whose climbs are right there.
 *
 * `server-setter-data.test.ts` byte-compares the two rendered WHERE clauses
 * rather than trusting this comment.
 */
function visibleSetterClimbsWhere(username: string): SQL | undefined {
  // `SQL | undefined` rather than a cast: drizzle types `and()` that way for the
  // zero-argument case, `.where()` accepts it, and asserting it away would only
  // silence the compiler about a shape it is describing correctly.
  return and(eq(boardClimbs.setterUsername, username), eq(boardClimbs.isListed, true), eq(boardClimbs.isDraft, false));
}

/**
 * Board types and visible-climb count for one setter.
 *
 * Split out as a `.toSQL()`-inspectable seam — the same seam `buildTier2ClimbQuery`
 * establishes — so a test can render the predicate this really runs instead of
 * rebuilding a lookalike and asserting a tautology.
 */
export function buildSetterProfileQuery(db: SerialPlanDb, username: string) {
  return db
    .select({
      boardType: boardClimbs.boardType,
      climbCount: sql<number>`count(*)::int`,
    })
    .from(boardClimbs)
    .where(visibleSetterClimbsWhere(username))
    .groupBy(boardClimbs.boardType);
}

/** The stats rows this climb could be linked at, aliased away from the outer join. */
const angleCandidates = alias(boardClimbStats, 'angle_candidate');

/**
 * The angle a climb's row is shown (and linked) at.
 *
 * Both halves come from `published-angle.ts`, which is also what
 * `buildChosenSubquery` builds the climbs sitemap's `DISTINCT ON` ordering
 * from. That sharing is the whole point: the angle is a path segment, so a
 * second rule here is a second indexable URL for a climb Google was already
 * told about at a different address.
 *
 * It shipped as a hand-written `ORDER BY s.ascensionist_count DESC NULLS LAST,
 * s.angle ASC` that was missing both of the sitemap's other clauses, and both
 * misses were live on the dev image: 28 tier-2 climbs were linked at a
 * tied-but-different angle, and one climb's argmax was `-5`, an angle the route
 * tables do not carry at all.
 */
function mostAscendedAngle(db: SerialPlanDb): SQL {
  return sql`(${db
    .select({ angle: angleCandidates.angle })
    .from(angleCandidates)
    .where(
      and(
        eq(angleCandidates.boardType, boardClimbs.boardType),
        eq(angleCandidates.climbUuid, boardClimbs.uuid),
        publishableAngleWhere(angleCandidates.angle, boardClimbs.boardType),
      ),
    )
    .orderBy(
      ...publishedAngleOrderBy({
        ascensionistCount: angleCandidates.ascensionistCount,
        statsAngle: angleCandidates.angle,
        climbAngle: boardClimbs.angle,
      }),
    )
    .limit(1)
    .getSQL()})`;
}

/**
 * Angle used when a climb has no publishable stats row at all — matches the
 * resolvers' fallback, and 40 is in `ANGLES` for every board we ship, so the
 * fallback never itself invents a 404ing URL.
 */
export const DEFAULT_SETTER_CLIMB_ANGLE = 40;

/**
 * One page of a setter's publicly visible climbs, most-ascended first.
 *
 * `limit + 1` rather than a second `count(*)`: the page only needs to know
 * whether there is a next page, and the profile query already carries the total.
 */
export function buildSetterClimbsQuery(db: SerialPlanDb, username: string, offset: number, limit: number) {
  return db
    .select({
      uuid: boardClimbs.uuid,
      layoutId: boardClimbs.layoutId,
      boardType: boardClimbs.boardType,
      setterUsername: boardClimbs.setterUsername,
      name: boardClimbs.name,
      description: boardClimbs.description,
      frames: boardClimbs.frames,
      framesCount: boardClimbs.framesCount,
      framesPace: boardClimbs.framesPace,
      compatibleSizeIds: boardClimbs.compatibleSizeIds,
      requiredSetIds: boardClimbs.requiredSetIds,
      updatedAt: boardClimbs.updatedAt,
      createdAt: boardClimbs.createdAt,
      statsAngle: boardClimbStats.angle,
      ascensionistCount: boardClimbStats.ascensionistCount,
      difficultyId: sql<number | null>`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
      qualityAverage: sql<number | null>`ROUND(${boardClimbStats.qualityAverage}::numeric, 2)`,
      difficultyError: sql<
        number | null
      >`ROUND(${boardClimbStats.difficultyAverage}::numeric - ${boardClimbStats.displayDifficulty}::numeric, 2)`,
      benchmarkDifficulty: boardClimbStats.benchmarkDifficulty,
    })
    .from(boardClimbs)
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, boardClimbs.boardType),
        eq(boardClimbStats.climbUuid, boardClimbs.uuid),
        eq(boardClimbStats.angle, mostAscendedAngle(db)),
      ),
    )
    .where(visibleSetterClimbsWhere(username))
    .orderBy(desc(sql`COALESCE(${boardClimbStats.ascensionistCount}, 0)`), boardClimbs.uuid)
    .limit(limit + 1)
    .offset(offset);
}

type SetterIdentity = { displayName: string; avatarUrl: string | null; followerCount: number };

/**
 * Display name, avatar and follower count for the hero.
 *
 * Raw `sql` rather than Drizzle builders because `user_board_mappings` →
 * `users` → `user_profiles` is a three-table lookup for at most one row and the
 * follower count is a scalar subquery; expressing it as a join chain buys
 * nothing. Falls back to the raw username, which is what the setter is called
 * on every climb row anyway.
 */
async function fetchSetterIdentity(username: string): Promise<SetterIdentity> {
  const rows = await executeRows<{
    name: string | null;
    display_name: string | null;
    avatar_url: string | null;
    follower_count: number | string | null;
  }>(
    dbzRead,
    sql`
    SELECT
      profile.name,
      profile.display_name,
      profile.avatar_url,
      (SELECT count(*) FROM setter_follows sf WHERE sf.setter_username = ${username}) AS follower_count
    FROM (SELECT 1) AS seed
    LEFT JOIN (
      SELECT u.name, p.display_name, p.avatar_url
      FROM user_board_mappings ubm
      JOIN users u ON u.id = ubm.user_id
      LEFT JOIN user_profiles p ON p.user_id = ubm.user_id
      WHERE ubm.board_username = ${username}
      LIMIT 1
    ) AS profile ON true
  `,
  );

  const row = rows[0];

  return {
    displayName: row?.display_name || row?.name || username,
    avatarUrl: row?.avatar_url || null,
    followerCount: Number(row?.follower_count ?? 0),
  };
}

function toClimbRow(row: Awaited<ReturnType<typeof buildSetterClimbsQuery>>[number]): SetterClimbRow {
  return {
    uuid: row.uuid,
    layoutId: row.layoutId,
    boardType: row.boardType,
    setter_username: row.setterUsername ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    frames: row.frames ?? '',
    framesCount: row.framesCount ?? null,
    framesPace: row.framesPace ?? null,
    angle: row.statsAngle ?? DEFAULT_SETTER_CLIMB_ANGLE,
    ascensionist_count: Number(row.ascensionistCount ?? 0),
    difficulty: getGradeLabel(row.difficultyId ?? null),
    quality_average: row.qualityAverage?.toString() ?? '0',
    stars: getClimbStars(row.qualityAverage),
    difficulty_error: row.difficultyError?.toString() ?? '0',
    benchmark_difficulty:
      row.benchmarkDifficulty && row.benchmarkDifficulty > 0 ? row.benchmarkDifficulty.toString() : null,
    created_at: row.createdAt ?? null,
    compatibleSizeIds: row.compatibleSizeIds ?? [],
    requiredSetIds: row.requiredSetIds ?? [],
    updatedAt: row.updatedAt,
  };
}

/**
 * Everything the setter front door renders, or `null` when the setter has no
 * publicly visible climb — which the page turns into a real `notFound()`.
 *
 * Rethrows on query failure rather than degrading to an empty page, the rule
 * `fetchFrontDoorListPage` records: a 200 with no climbs on an indexable URL
 * reads to Google as legitimate thin content and the page gets dropped, where a
 * 5xx makes it retry and keep the URL.
 */
export async function getSetterPageData(username: string, page: number): Promise<SetterPageData | null> {
  const offset = Math.max(0, page - 1) * SETTER_PAGE_SIZE;

  const [boardTypeRows, climbRows] = await withSerialPlan(dbzRead, async (tx) => [
    await buildSetterProfileQuery(tx, username),
    await buildSetterClimbsQuery(tx, username, offset, SETTER_PAGE_SIZE),
  ]);

  const climbCount = boardTypeRows.reduce((total, row) => total + Number(row.climbCount), 0);
  if (climbCount === 0) {
    return null;
  }

  const identity = await fetchSetterIdentity(username);
  const hasMore = climbRows.length > SETTER_PAGE_SIZE;

  return {
    username,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    followerCount: identity.followerCount,
    boardTypes: boardTypeRows
      .map((row) => row.boardType)
      .filter((boardType): boardType is string => Boolean(boardType))
      .sort(),
    climbCount,
    climbs: (hasMore ? climbRows.slice(0, SETTER_PAGE_SIZE) : climbRows).map(toClimbRow),
    hasMore,
  };
}
