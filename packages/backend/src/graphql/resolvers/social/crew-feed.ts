import { and, eq, inArray, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ConnectionContext,
  CrewFeedInput,
  CrewFeedItem,
  CrewFeedResult,
  ActivityFeedItem,
} from '@boardsesh/shared-schema';
import { followedAuthorCondition, sprayClimbVisibilityCondition, withSerialPlan } from '@boardsesh/db/queries';
import { boardClimbs, boardClimbStats, boardDifficultyGrades, users, userProfiles } from '@boardsesh/db/schema';
import { dbRead } from '../../../db/client';
import { requireAuthenticated, applyRateLimit, resolveClimbNoMatch } from '../shared/helpers';
import { climbStatsJoinConditions, resolvedClimbAngleSql } from '../../../db/queries/util/climb-stats-join';
import { getSessionFeed } from './session-feed';
import { decodeCrewCursor, encodeCrewCursor, selectCrewCandidates, type CrewCandidate } from './crew-feed-pagination';

const inputSchema = z.object({
  cursor: z.string().max(2048).nullish(),
  limit: z.number().int().min(1).max(50).default(20),
});
const publicationText = sql`COALESCE(NULLIF(${boardClimbs.publishedAt}, ''), NULLIF(${boardClimbs.createdAt}, ''))`;
// Imports contain both naive UTC timestamps and ISO timestamps with offsets.
// Invalid legacy dates are omitted, never treated as newly published on import.
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

function visibleClimbs(viewerId: string) {
  return [
    eq(boardClimbs.isListed, true),
    eq(boardClimbs.isDraft, false),
    eq(boardClimbs.isHidden, false),
    sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId),
    followedAuthorCondition(viewerId),
  ];
}

async function enrichClimbs(candidates: CrewCandidate[], viewerId: string): Promise<Map<string, ActivityFeedItem>> {
  if (candidates.length === 0) return new Map();
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
    .where(
      and(
        inArray(
          boardClimbs.uuid,
          candidates.map((candidate) => candidate.sourceId),
        ),
        ...visibleClimbs(viewerId),
      ),
    );
  const timeById = new Map(candidates.map((candidate) => [candidate.sourceId, candidate.occurredAt]));
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

export const crewFeedQueries = {
  crewFeed: async (
    _: unknown,
    { input }: { input?: CrewFeedInput },
    ctx: ConnectionContext,
  ): Promise<CrewFeedResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'crewFeed');
    const { limit, cursor } = inputSchema.parse(input ?? {});
    const viewerId = ctx.userId!;
    const before = decodeCrewCursor(cursor, viewerId);
    const snapshotAt = before?.snapshotAt ?? new Date().toISOString();
    const rows = await withSerialPlan(dbRead, (tx) =>
      tx
        .select({
          sourceId: boardClimbs.uuid,
          occurredAt: sql<string>`to_char(${crewPublicationTime} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(boardClimbs)
        .where(
          and(
            ...visibleClimbs(viewerId),
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
        .limit(limit + 1),
    );
    const climbCandidates: CrewCandidate[] = rows.map((row) => ({
      ...row,
      kind: 'climb',
      id: `climb:${row.sourceId}`,
    }));
    let selection: ReturnType<typeof selectCrewCandidates> = { selected: [], hasMore: false };
    const sessionPage = await getSessionFeed({ followingOnly: true, includeDailyHighlights: true, limit }, ctx, {
      snapshotAt,
      before,
      selectRows: (sessionRows) => {
        selection = selectCrewCandidates(
          [
            ...climbCandidates,
            ...sessionRows.map((row): CrewCandidate => ({
              id: `session:${row.session_id}`,
              sourceId: row.session_id,
              occurredAt: row.candidate_time!,
              kind: 'session',
            })),
          ],
          limit,
        );
        const selectedIds = new Set(
          selection.selected.filter((candidate) => candidate.kind === 'session').map((candidate) => candidate.sourceId),
        );
        return sessionRows.filter((row) => selectedIds.has(row.session_id));
      },
    });
    const climbs = await enrichClimbs(
      selection.selected.filter((candidate) => candidate.kind === 'climb'),
      viewerId,
    );
    const sessions = new Map(sessionPage.sessions.map((session) => [session.sessionId, session]));
    const items: CrewFeedItem[] = [];
    for (const candidate of selection.selected) {
      const { id, occurredAt } = candidate;
      if (candidate.kind === 'climb') {
        const climb = climbs.get(candidate.sourceId);
        if (climb) items.push({ __typename: 'CrewClimbItem', id, occurredAt, climb });
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
