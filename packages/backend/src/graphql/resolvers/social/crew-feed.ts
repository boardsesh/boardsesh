import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolveRenderBoard } from '@boardsesh/board-config';
import type {
  ConnectionContext,
  CrewFeedInput,
  CrewFeedItem,
  CrewFeedResult,
  ActivityFeedItem,
} from '@boardsesh/shared-schema';
import { CREW_CLIMB_GROUP_LIMIT } from '@boardsesh/shared-schema';
import { followedAuthorCondition, sprayClimbVisibilityCondition, withSerialPlan } from '@boardsesh/db/queries';
import { rowsFromResult } from '@boardsesh/db/client';
import { boardClimbs, boardClimbStats, boardDifficultyGrades, users, userProfiles } from '@boardsesh/db/schema';
import { dbRead } from '../../../db/client';
import { requireAuthenticated, applyRateLimit, resolveClimbNoMatch } from '../shared/helpers';
import { climbStatsJoinConditions, resolvedClimbAngleSql } from '../../../db/queries/util/climb-stats-join';
import { getSessionFeed } from './session-feed';
import { decodeCrewCursor, encodeCrewCursor, selectCrewCandidates, type CrewCandidate } from './crew-feed-pagination';
import {
  buildCrewClimbCandidatesQuery,
  buildCrewGroupClimbsQuery,
  type CrewClimbCandidateRow,
  type CrewClimbGroupKey,
  type CrewGroupClimbRow,
} from './crew-feed-candidates';

const inputSchema = z.object({
  cursor: z.string().max(2048).nullish(),
  limit: z.number().int().min(1).max(50).default(20),
  timeZone: z.string().max(64).nullish(),
  groupClimbs: z.boolean().nullish(),
});

/**
 * Every zone name THIS Postgres accepts, lowercased, read once per process.
 *
 * Validating with `Intl` instead would be a live outage: Node's ICU accepts
 * every IANA backward link, and the Debian Postgres images moved those to
 * `tzdata-legacy` in 2023 — so `Asia/Calcutta`, `Europe/Kiev`, `US/Eastern`,
 * `US/Pacific`, `America/Buenos_Aires` and friends pass `Intl` and then raise
 * `time zone not recognized` inside the query. Android hands
 * `resolvedOptions().timeZone` back as `Asia/Calcutta` on a great many devices,
 * and React Query keys the feed cache on the zone, so those climbers would get a
 * 500 on every page with no way to recover.
 */
let knownTimeZones: Promise<Set<string>> | null = null;
function loadKnownTimeZones(): Promise<Set<string>> {
  knownTimeZones ??= dbRead
    .execute(sql`SELECT name FROM pg_timezone_names`)
    .then((result) => new Set(rowsFromResult<{ name: string }>(result).map((row) => row.name.toLowerCase())))
    .catch((error: unknown) => {
      // Don't cache a failed read — the next request should try again rather
      // than pin every climber to UTC for the life of the process.
      knownTimeZones = null;
      throw error;
    });
  return knownTimeZones;
}

/**
 * The viewer's zone, or UTC.
 *
 * Checked against what the database will actually accept, because this value
 * reaches `AT TIME ZONE` and Postgres raises on a name it does not know.
 */
async function resolveTimeZone(timeZone: string | null | undefined): Promise<string> {
  if (!timeZone) return 'UTC';
  try {
    return (await loadKnownTimeZones()).has(timeZone.toLowerCase()) ? timeZone : 'UTC';
  } catch {
    return 'UTC';
  }
}

function visibleClimbs(viewerId: string) {
  return [
    eq(boardClimbs.isListed, true),
    eq(boardClimbs.isDraft, false),
    eq(boardClimbs.isHidden, false),
    sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId),
    followedAuthorCondition(viewerId),
  ];
}

/**
 * The feed payload for each climb.
 *
 * `publishedAt` by `timeById`, not by the row's own text: the candidate query
 * already normalised every publication instant (legacy imports carry offsets,
 * bare timestamps and outright invalid dates), and the card's "an hour ago"
 * has to read the same value the feed ordered on.
 */
async function enrichClimbs(timeById: Map<string, string>, viewerId: string): Promise<Map<string, ActivityFeedItem>> {
  const climbUuids = [...timeById.keys()];
  if (climbUuids.length === 0) return new Map();
  const rows = await dbRead
    .select({
      climb: boardClimbs,
      angle: resolvedClimbAngleSql,
      difficultyName: boardDifficultyGrades.boulderName,
      // The stats join is already here for the grade; read the rest of it too,
      // so the drawer shows real ascents and stars. The card used to route
      // through the climb page, which loaded them — opening in place has to
      // carry them or it is a visible regression.
      ascensionistCount: boardClimbStats.ascensionistCount,
      qualityAverage: boardClimbStats.qualityAverage,
      benchmarkDifficulty: boardClimbStats.benchmarkDifficulty,
      actorDisplayName: sql<string | null>`COALESCE(${userProfiles.displayName}, ${users.name})`,
      actorAvatarUrl: sql<string | null>`COALESCE(${userProfiles.avatarUrl}, ${users.image})`,
    })
    .from(boardClimbs)
    .leftJoin(boardClimbStats, and(...climbStatsJoinConditions()))
    .leftJoin(
      boardDifficultyGrades,
      and(
        eq(boardDifficultyGrades.boardType, boardClimbs.boardType),
        eq(boardDifficultyGrades.difficulty, boardClimbStats.displayDifficulty),
      ),
    )
    .leftJoin(users, eq(users.id, boardClimbs.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, boardClimbs.userId))
    .where(and(inArray(boardClimbs.uuid, climbUuids), ...visibleClimbs(viewerId)));
  return new Map(
    rows.map(({ climb, angle, difficultyName, actorDisplayName, actorAvatarUrl, ...stats }) => [
      climb.uuid,
      {
        id: `climb:${climb.uuid}`,
        type: 'new_climb',
        entityType: 'climb',
        entityId: climb.uuid,
        actorId: climb.userId,
        actorDisplayName: actorDisplayName ?? climb.setterUsername,
        actorAvatarUrl,
        climbUuid: climb.uuid,
        climbName: climb.name,
        boardType: climb.boardType,
        layoutId: climb.layoutId,
        renderBoard: resolveRenderBoard({
          boardType: climb.boardType,
          climbLayoutId: climb.layoutId,
          compatibleSizeIds: climb.compatibleSizeIds,
          requiredSetIds: climb.requiredSetIds,
        }),
        setterUsername: climb.setterUsername,
        frames: climb.frames,
        angle,
        difficultyName,
        ascensionistCount: stats.ascensionistCount,
        qualityAverage: stats.qualityAverage,
        isBenchmark: stats.benchmarkDifficulty != null,
        isNoMatch: resolveClimbNoMatch(climb.boardType, climb.characteristics, climb.description),
        createdAt: timeById.get(climb.uuid)!,
      },
    ]),
  );
}

/** The `(board, author, day)` tuple as one string, for keying a lookup. */
function groupKeyOf(key: CrewClimbGroupKey): string {
  return `${key.boardType}:${key.authorKey}:${key.day}`;
}

/**
 * The climbs behind each selected group, newest first and capped.
 *
 * Ranking happens in SQL (one window function over the followed set) and the
 * enrichment is a single `IN` over the uuids that survive it, so a page costs
 * two queries however many climbs the groups hold.
 */
async function loadGroupClimbs(
  groups: CrewClimbGroupKey[],
  viewerId: string,
  snapshotAt: string,
  timeZone: string,
): Promise<Map<string, ActivityFeedItem[]>> {
  if (groups.length === 0) return new Map();
  const rankedResult = await withSerialPlan(dbRead, (tx) =>
    tx.execute(buildCrewGroupClimbsQuery({ viewerId, snapshotAt, groups, timeZone, perGroup: CREW_CLIMB_GROUP_LIMIT })),
  );
  const ranked = rowsFromResult<CrewGroupClimbRow>(rankedResult);
  const climbs = await enrichClimbs(new Map(ranked.map((row) => [row.uuid, row.occurredAt])), viewerId);
  const byGroup = new Map<string, ActivityFeedItem[]>();
  // Sort by the SQL rank (newest first within a group) rather than trusting the
  // row order Postgres returned — a parallel plan promises nothing about it, and
  // this order is the card's swipe order.
  for (const row of [...ranked].sort((left, right) => left.rank - right.rank)) {
    const climb = climbs.get(row.uuid);
    if (!climb) continue;
    const key = groupKeyOf(row);
    const existing = byGroup.get(key);
    if (existing) existing.push(climb);
    else byGroup.set(key, [climb]);
  }
  return byGroup;
}

/**
 * The feed cards for a group's climbs.
 *
 * `grouped` is opt-in and OFF by default, because a client that predates
 * `CrewClimbGroupItem` does not merely fail to render one — it dies on it. Its
 * query has no fragment for the member, so the item arrives as a bare
 * `__typename`; its `renderItem` is a two-way branch that falls through to the
 * session card and reads `item.session.socialEntityType`, which throws inside
 * the feed list and takes the whole Home tab down with the route's error
 * boundary. Every store build that has not taken the OTA yet is such a client.
 *
 * So an unasked client gets one `CrewClimbItem` per climb — exactly the shape it
 * already renders. It sees at most the group's ten newest rather than all of
 * them, which is a strictly smaller flood than it gets today; the rest stay
 * reachable from the setter's page.
 */
function toCrewClimbCards(
  id: string,
  occurredAt: string,
  climbs: ActivityFeedItem[],
  climbCount: number,
  grouped: boolean,
): CrewFeedItem[] {
  if (climbs.length === 0) return [];
  if (!grouped) {
    return climbs.map((climb) => ({
      __typename: 'CrewClimbItem',
      id: `climb:${climb.climbUuid}`,
      occurredAt: climb.createdAt,
      climb,
    }));
  }
  if (climbs.length === 1 && climbCount === 1) {
    return [{ __typename: 'CrewClimbItem', id, occurredAt, climb: climbs[0] }];
  }
  // `climbCount` comes from the candidate query and `climbs` from the one after
  // it, so a climb hidden between the two leaves the count high. Never report
  // fewer than we actually loaded.
  return [
    { __typename: 'CrewClimbGroupItem', id, occurredAt, climbs, totalCount: Math.max(climbCount, climbs.length) },
  ];
}

export const crewFeedQueries = {
  crewFeed: async (
    _: unknown,
    { input }: { input?: CrewFeedInput },
    ctx: ConnectionContext,
  ): Promise<CrewFeedResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'crewFeed');
    const { limit, cursor, timeZone, groupClimbs } = inputSchema.parse(input ?? {});
    const viewerId = ctx.userId!;
    // Opt-in: only a client that asked can be handed a CrewClimbGroupItem.
    const grouped = groupClimbs === true;
    const zone = await resolveTimeZone(timeZone);
    const before = decodeCrewCursor(cursor, viewerId);
    const snapshotAt = before?.snapshotAt ?? new Date().toISOString();
    const candidateResult = await withSerialPlan(dbRead, (tx) =>
      tx.execute(buildCrewClimbCandidatesQuery({ viewerId, snapshotAt, before, limit, timeZone: zone })),
    );
    const rows = rowsFromResult<CrewClimbCandidateRow>(candidateResult);
    const groupsById = new Map(rows.map((row) => [row.groupId, row]));
    const climbCandidates: CrewCandidate[] = rows.map((row) => ({
      sourceId: row.groupId,
      occurredAt: row.occurredAt,
      kind: 'climb',
      id: row.groupId,
    }));
    let selection: ReturnType<typeof selectCrewCandidates> = { selected: [], hasMore: false };
    const sessionPage = await getSessionFeed({ followingOnly: true, includeDailyHighlights: true, limit }, ctx, {
      snapshotAt,
      before,
      selectRows: (sessionRows) => {
        selection = selectCrewCandidates(
          [
            ...climbCandidates,
            ...sessionRows.map((row): CrewCandidate => {
              if (!row.candidate_time) throw new Error('Missing Crew session timestamp');
              return {
                id: `session:${row.session_id}`,
                sourceId: row.session_id,
                occurredAt: row.candidate_time,
                kind: 'session',
              };
            }),
          ],
          limit,
        );
        const selectedIds = new Set(
          selection.selected.filter((candidate) => candidate.kind === 'session').map((candidate) => candidate.sourceId),
        );
        return sessionRows.filter((row) => selectedIds.has(row.session_id));
      },
    });
    const selectedGroups = selection.selected.flatMap((candidate) => {
      if (candidate.kind !== 'climb') return [];
      const group = groupsById.get(candidate.sourceId);
      return group ? [group] : [];
    });
    const groupedClimbs = await loadGroupClimbs(selectedGroups, viewerId, snapshotAt, zone);
    const sessions = new Map(sessionPage.sessions.map((session) => [session.sessionId, session]));
    const items: CrewFeedItem[] = [];
    for (const candidate of selection.selected) {
      const { id, occurredAt } = candidate;
      if (candidate.kind === 'climb') {
        const group = groupsById.get(candidate.sourceId);
        if (!group) continue;
        items.push(
          ...toCrewClimbCards(id, occurredAt, groupedClimbs.get(groupKeyOf(group)) ?? [], group.climbCount, grouped),
        );
      } else {
        const session = sessions.get(candidate.sourceId);
        if (session) items.push({ __typename: 'CrewSessionItem', id, occurredAt, session });
      }
    }
    const last = selection.selected.at(-1);
    return {
      items,
      hasMore: selection.hasMore,
      cursor:
        selection.hasMore && last
          ? encodeCrewCursor({
              version: 1,
              viewerId,
              snapshotAt,
              occurredAt: last.occurredAt,
              id: last.id,
            })
          : null,
    };
  },
};
