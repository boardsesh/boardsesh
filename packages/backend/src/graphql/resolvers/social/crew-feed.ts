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
});

/**
 * The viewer's zone, or UTC.
 *
 * This value reaches `AT TIME ZONE`, and Postgres raises on a name it does not
 * know — so an unrecognised or malformed zone degrades to UTC rather than
 * failing the whole feed over one odd client.
 */
function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
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
    rows.map(({ climb, angle, difficultyName, actorDisplayName, actorAvatarUrl }) => [
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
 * One feed card for a group's climbs.
 *
 * A lone climb stays a `CrewClimbItem` so a client that predates
 * `CrewClimbGroupItem` keeps rendering single new climbs rather than dropping
 * them on a union member it cannot match.
 */
function toCrewClimbCard(
  id: string,
  occurredAt: string,
  climbs: ActivityFeedItem[],
  climbCount: number,
): CrewFeedItem | null {
  if (climbs.length === 0) return null;
  if (climbs.length === 1 && climbCount === 1) {
    return { __typename: 'CrewClimbItem', id, occurredAt, climb: climbs[0] };
  }
  // `climbCount` comes from the candidate query and `climbs` from the one after
  // it, so a climb hidden between the two leaves the count high. Never report
  // fewer than we actually loaded.
  return { __typename: 'CrewClimbGroupItem', id, occurredAt, climbs, totalCount: Math.max(climbCount, climbs.length) };
}

export const crewFeedQueries = {
  crewFeed: async (
    _: unknown,
    { input }: { input?: CrewFeedInput },
    ctx: ConnectionContext,
  ): Promise<CrewFeedResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'crewFeed');
    const { limit, cursor, timeZone } = inputSchema.parse(input ?? {});
    const viewerId = ctx.userId!;
    const zone = resolveTimeZone(timeZone);
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
    const groupClimbs = await loadGroupClimbs(selectedGroups, viewerId, snapshotAt, zone);
    const sessions = new Map(sessionPage.sessions.map((session) => [session.sessionId, session]));
    const items: CrewFeedItem[] = [];
    for (const candidate of selection.selected) {
      const { id, occurredAt } = candidate;
      if (candidate.kind === 'climb') {
        const group = groupsById.get(candidate.sourceId);
        if (!group) continue;
        const card = toCrewClimbCard(id, occurredAt, groupClimbs.get(groupKeyOf(group)) ?? [], group.climbCount);
        if (card) items.push(card);
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
