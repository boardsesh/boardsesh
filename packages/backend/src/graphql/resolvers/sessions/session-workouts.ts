import { GraphQLError } from 'graphql';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel, resourceAccessCondition } from '@boardsesh/db/queries';
import { resolveRenderBoard } from '@boardsesh/board-config';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type {
  RecordSessionWorkoutInput,
  SessionWorkout,
  SessionWorkoutClimb,
  SessionWorkoutHeadline,
  SessionWorkoutRepOutcome,
  SessionWorkoutStage,
} from '@boardsesh/shared-schema/generated';
import {
  deriveWorkoutStages,
  mainWorkoutStages,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
  restrictDerivedWorkout,
  workoutHeadline,
  type DerivedWorkoutClimb,
  type SessionWorkoutRepOutcome as RepOutcome,
} from '@boardsesh/workout-summary';
import { db } from '../../../db/client';
import { canAccessResource } from '../../../services/privacy';
import { sessionsOwnSurfaceVisibleUserIds, sessionVisibleUserIds } from '../../../services/board-session-privacy';
import { logger } from '../../../utils/logger';
import { scopedClimbCondition, sessionTickVisibleCondition } from '../shared/activity-privacy';
import { applyRateLimit, isDurableSessionMember, requireAuthenticated } from '../shared/helpers';
import { fetchOwnerBoards, toTickBoardCandidate } from '../shared/render-board';
import { sprayTickVisibleSql } from '../shared/spray-tick-visibility';

/**
 * Workout-aware sessions (#6903). One row per climber per session holds the
 * plan their phone followed and which queue item each tick was logged on; what
 * each block came to is derived on read from that climber's ticks with
 * `@boardsesh/workout-summary`, so a tick edited or deleted later is reflected
 * without a rewrite. docs/workout-stages.md, "Workouts on the server".
 *
 * Who a reader shows follows `sessionDetail`: a workout appears only when the
 * session opens for the viewer, its climber is someone the session's own
 * surfaces name to them (`sessionVisibleUserIds`), and at least one of that
 * climber's ticks in the session is one the viewer may see. Inside it, a climb
 * the viewer may not see is left out with all its reps.
 */

/** Feed cards ask for one page of sessions at a time. */
export const MAX_SESSION_WORKOUT_HEADLINE_IDS = 50;
const RATE_LIMIT_RECORD_SESSION_WORKOUT = 60;
const RATE_LIMIT_SESSION_WORKOUT_HEADLINES = 120;
const MAX_REVISION = 2_147_483_647;

const REP_OUTCOME: Record<RepOutcome, SessionWorkoutRepOutcome> = {
  flash: 'FLASH',
  send: 'SEND',
  attempt: 'ATTEMPT',
};

const badInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/** Daily feed cards ("daily:<user>:<day>") are not sessions and never hold a workout. */
const isDailySessionId = (sessionId: string): boolean => sessionId.startsWith('daily:');

/** The board type an explicit session's path starts with ("kilter/1/10/1,2/40"). */
const boardTypeFromPath = (boardPath: string | null): string | null =>
  boardPath?.split('/').find((segment) => segment.length > 0) ?? null;

const gradeName = (difficulty: number | null | undefined, boardType: string | null | undefined): string | null =>
  difficulty == null || !boardType ? null : getGradeLabel(difficulty, boardType) || null;

const logUnreadable = (sessionId: string, userId: string): void => {
  logger.warn(`[sessionWorkouts] Unreadable workout for session ${sessionId}, user ${userId}; skipped.`);
};

/**
 * The session's tick rule plus the spray wall rule, for ticks aliased `t`:
 * exactly the pair the session summary's participant counts use.
 */
const tickVisibleSql = (
  ticks: NonNullable<Parameters<typeof sessionTickVisibleCondition>[1]>,
  viewerUserId: string | null,
) => sql<boolean>`(${sessionTickVisibleCondition(viewerUserId, ticks)} AND ${sprayTickVisibleSql('t', viewerUserId)})`;

type ClimbRow = {
  uuid: string;
  boardType: string;
  name: string | null;
  layoutId: number;
  frames: string | null;
  compatibleSizeIds: number[] | null;
  requiredSetIds: number[] | null;
  visible: boolean;
};

/**
 * The climb rows behind the plan's climb uuids, keyed by the uuid the plan
 * names. A uuid deduplicated into another climb resolves through
 * `board_climb_aliases` to its canonical row, as the session summary does.
 * `visible` is the climb half of the tick rule (`scopedClimbCondition`,
 * `listed`): published and listed, or the viewer's own, and not on a spray
 * wall they can't see. A skipped climb has no tick to carry that rule, so it
 * is checked here.
 */
async function fetchPlanClimbs(
  climbUuids: readonly string[],
  viewerUserId: string | null,
): Promise<Map<string, ClimbRow>> {
  const byPlanUuid = new Map<string, ClimbRow>();
  if (climbUuids.length === 0) return byPlanUuid;
  const aliasRows = await db
    .select({
      aliasUuid: dbSchema.boardClimbAliases.aliasUuid,
      canonicalUuid: dbSchema.boardClimbAliases.canonicalUuid,
    })
    .from(dbSchema.boardClimbAliases)
    .where(inArray(dbSchema.boardClimbAliases.aliasUuid, [...climbUuids]));
  const canonicalByAlias = new Map(aliasRows.map((row) => [row.aliasUuid, row.canonicalUuid]));
  const lookupUuids = Array.from(new Set([...climbUuids, ...canonicalByAlias.values()]));
  const climbRows = await db
    .select({
      uuid: dbSchema.boardClimbs.uuid,
      boardType: dbSchema.boardClimbs.boardType,
      name: dbSchema.boardClimbs.name,
      layoutId: dbSchema.boardClimbs.layoutId,
      frames: dbSchema.boardClimbs.frames,
      compatibleSizeIds: dbSchema.boardClimbs.compatibleSizeIds,
      requiredSetIds: dbSchema.boardClimbs.requiredSetIds,
      visible: sql<boolean>`${scopedClimbCondition(dbSchema.boardClimbs, viewerUserId, 'listed')}`,
    })
    .from(dbSchema.boardClimbs)
    .where(inArray(dbSchema.boardClimbs.uuid, lookupUuids));
  const byUuid = new Map(climbRows.map((row) => [row.uuid, row]));
  for (const climbUuid of climbUuids) {
    const row = byUuid.get(canonicalByAlias.get(climbUuid) ?? climbUuid) ?? byUuid.get(climbUuid);
    if (row) byPlanUuid.set(climbUuid, row);
  }
  return byPlanUuid;
}

/** Consensus display difficulty per `${boardType}:${climbUuid}:${angle}`, for climbs nobody logged a grade on. */
async function fetchConsensusDifficulty(
  climbs: ReadonlyArray<{ boardType: string; climbUuid: string; angle: number }>,
): Promise<Map<string, number>> {
  const byKey = new Map<string, number>();
  if (climbs.length === 0) return byKey;
  const rows = await db
    .select({
      boardType: dbSchema.boardClimbStats.boardType,
      climbUuid: dbSchema.boardClimbStats.climbUuid,
      angle: dbSchema.boardClimbStats.angle,
      displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
    })
    .from(dbSchema.boardClimbStats)
    .where(
      and(
        inArray(dbSchema.boardClimbStats.climbUuid, Array.from(new Set(climbs.map((climb) => climb.climbUuid)))),
        inArray(dbSchema.boardClimbStats.angle, Array.from(new Set(climbs.map((climb) => climb.angle)))),
      ),
    );
  for (const row of rows) {
    if (row.displayDifficulty == null) continue;
    byKey.set(`${row.boardType}:${row.climbUuid}:${row.angle}`, Math.round(row.displayDifficulty));
  }
  return byKey;
}

export const sessionWorkoutMutations = {
  /**
   * Upserts the caller's own workout for a session. Only the session's creator
   * and people who joined it (`board_session_participants`) may write: logging
   * a tick is not enough, since `saveTick` accepts any existing session id.
   * Written only when the revision is higher than the stored one; an equal or
   * lower revision is a no-op that still answers true, so an outbox replay is
   * idempotent. Tick-map entries naming anything but the caller's own ticks in
   * the session are dropped.
   */
  recordSessionWorkout: async (
    _: unknown,
    { input }: { input: RecordSessionWorkoutInput },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_RECORD_SESSION_WORKOUT, 'recordSessionWorkout');
    const userId = ctx.userId!;

    const { sessionId, revision } = input;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw badInput('Invalid session id');
    }
    if (!Number.isInteger(revision) || revision < 0 || revision > MAX_REVISION) {
      throw badInput('Invalid workout revision');
    }
    const plan = parseSessionWorkoutPlan({ version: 1, stages: input.stages });
    if (!plan) throw badInput('Invalid workout');
    const tickMap = parseSessionWorkoutTickMap(input.ticks);
    if (!tickMap) throw badInput('Invalid workout tick map');

    // The primary throughout, so a session or join written a moment ago is seen.
    const [session] = await db
      .select({ createdByUserId: dbSchema.boardSessions.createdByUserId })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, sessionId))
      .limit(1);
    // BAD_USER_INPUT rather than NOT_FOUND: the outbox reads it as permanent,
    // so a replay for a deleted session never blocks the writes behind it.
    if (!session) throw badInput('Session not found');
    if (session.createdByUserId !== userId && !(await isDurableSessionMember(userId, sessionId))) {
      throw new GraphQLError('Not a participant of this session', { extensions: { code: 'FORBIDDEN' } });
    }

    const ownTickUuids =
      tickMap.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db
                .select({ uuid: dbSchema.boardseshTicks.uuid })
                .from(dbSchema.boardseshTicks)
                .where(
                  and(
                    eq(dbSchema.boardseshTicks.sessionId, sessionId),
                    eq(dbSchema.boardseshTicks.userId, userId),
                    inArray(
                      dbSchema.boardseshTicks.uuid,
                      tickMap.map((entry) => entry.tickUuid),
                    ),
                  ),
                )
            ).map((tick) => tick.uuid),
          );
    const ownTickMap = tickMap.filter((entry) => ownTickUuids.has(entry.tickUuid));

    const now = new Date();
    await db
      .insert(dbSchema.sessionWorkouts)
      .values({ sessionId, userId, plan, tickMap: ownTickMap, revision, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [dbSchema.sessionWorkouts.sessionId, dbSchema.sessionWorkouts.userId],
        set: {
          plan: sql`excluded.plan`,
          tickMap: sql`excluded.tick_map`,
          revision: sql`excluded.revision`,
          updatedAt: now,
        },
        setWhere: sql`${dbSchema.sessionWorkouts.revision} < excluded.revision`,
      });
    return true;
  },
};

export const sessionWorkoutQueries = {
  /**
   * Every workout followed in a session that the viewer may see, with what
   * each block came to. See the module comment for who appears.
   */
  sessionWorkouts: async (
    _: unknown,
    { sessionId }: { sessionId: string },
    ctx?: ConnectionContext,
  ): Promise<SessionWorkout[]> => {
    if (!sessionId || isDailySessionId(sessionId)) return [];
    const viewerUserId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;
    if (!(await canAccessResource('session', sessionId, viewerUserId))) return [];

    const workoutRows = await db
      .select({
        userId: dbSchema.sessionWorkouts.userId,
        plan: dbSchema.sessionWorkouts.plan,
        tickMap: dbSchema.sessionWorkouts.tickMap,
        updatedAt: dbSchema.sessionWorkouts.updatedAt,
        displayName: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
        avatarUrl: sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`,
      })
      .from(dbSchema.sessionWorkouts)
      .leftJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.sessionWorkouts.userId))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.sessionWorkouts.userId))
      .where(eq(dbSchema.sessionWorkouts.sessionId, sessionId))
      .orderBy(asc(dbSchema.sessionWorkouts.createdAt), asc(dbSchema.sessionWorkouts.userId));
    if (workoutRows.length === 0) return [];

    // The owners' ticks in the session, each with this viewer's verdict on it.
    const ticks = alias(dbSchema.boardseshTicks, 't');
    const tickBoards = alias(dbSchema.userBoards, 'tick_board');
    const [tickRows, [session], visibleOwners] = await Promise.all([
      db
        .select({
          uuid: ticks.uuid,
          userId: ticks.userId,
          climbUuid: ticks.climbUuid,
          angle: ticks.angle,
          isMirror: ticks.isMirror,
          status: ticks.status,
          climbedAt: ticks.climbedAt,
          difficulty: ticks.difficulty,
          boardType: ticks.boardType,
          boardLayoutId: tickBoards.layoutId,
          boardSizeId: tickBoards.sizeId,
          boardSetIds: tickBoards.setIds,
          visible: tickVisibleSql(ticks, viewerUserId),
        })
        .from(ticks)
        .leftJoin(tickBoards, eq(ticks.boardId, tickBoards.id))
        .where(
          and(
            eq(ticks.sessionId, sessionId),
            inArray(
              ticks.userId,
              workoutRows.map((row) => row.userId),
            ),
          ),
        ),
      db
        .select({
          boardPath: dbSchema.boardSessions.boardPath,
          boardType: dbSchema.userBoards.boardType,
          layoutId: dbSchema.userBoards.layoutId,
          sizeId: dbSchema.userBoards.sizeId,
          setIds: dbSchema.userBoards.setIds,
        })
        .from(dbSchema.boardSessions)
        .leftJoin(dbSchema.userBoards, eq(dbSchema.boardSessions.boardId, dbSchema.userBoards.id))
        .where(eq(dbSchema.boardSessions.id, sessionId))
        .limit(1),
      sessionVisibleUserIds(
        workoutRows.map((row) => row.userId),
        viewerUserId,
        sessionId,
      ),
    ]);

    // sessionDetail's rule: a climber is shown when the session's own surfaces
    // name them to this viewer and the viewer may see at least one of their
    // ticks in it.
    const ownersWithVisibleTick = new Set(tickRows.filter((tick) => tick.visible).map((tick) => tick.userId));
    const workouts = workoutRows.flatMap((row) => {
      if (!visibleOwners.has(row.userId) || !ownersWithVisibleTick.has(row.userId)) return [];
      const plan = parseSessionWorkoutPlan(row.plan);
      const tickMap = parseSessionWorkoutTickMap(row.tickMap);
      if (!plan || !tickMap) {
        logUnreadable(sessionId, row.userId);
        return [];
      }
      return [{ row, plan, tickMap }];
    });
    if (workouts.length === 0) return [];

    const tickByUuid = new Map(tickRows.map((row) => [row.uuid, row]));
    const sessionBoardType = session?.boardType ?? boardTypeFromPath(session?.boardPath ?? null);
    const sessionBoard = session
      ? toTickBoardCandidate({
          boardType: session.boardType,
          layoutId: session.layoutId,
          sizeId: session.sizeId,
          setIds: session.setIds,
        })
      : null;

    const planClimbUuids = Array.from(
      new Set(
        workouts.flatMap(({ plan }) => plan.stages.flatMap((stage) => stage.items.map((item) => item.climbUuid))),
      ),
    );
    const [climbByPlanUuid, ownerBoardsByUserId] = await Promise.all([
      fetchPlanClimbs(planClimbUuids, viewerUserId),
      fetchOwnerBoards(workouts.map(({ row }) => row.userId)),
    ]);
    const consensusByKey = await fetchConsensusDifficulty(
      workouts.flatMap(({ plan }) =>
        plan.stages.flatMap((stage) =>
          stage.items.flatMap((item) => {
            const climb = climbByPlanUuid.get(item.climbUuid);
            return climb ? [{ boardType: climb.boardType, climbUuid: climb.uuid, angle: item.angle }] : [];
          }),
        ),
      ),
    );

    return workouts.map(({ row, plan, tickMap }) => {
      const ownerTicks = tickRows.filter((tick) => tick.userId === row.userId);
      const derived = deriveWorkoutStages(plan, tickMap, ownerTicks);
      const isOwner = viewerUserId === row.userId;
      const visible = restrictDerivedWorkout(
        derived,
        (climb) => {
          const climbRow = climbByPlanUuid.get(climb.climbUuid);
          if (climbRow) return climbRow.visible;
          // No climb row: fail closed for everyone but the owner, unless the
          // owner's ticks say it is not a spray climb (an Aurora climb can
          // arrive after its ticks). The ticks' own rule still applies.
          if (isOwner) return true;
          return (
            climb.tickUuids.length > 0 &&
            climb.tickUuids.every((tickUuid) => tickByUuid.get(tickUuid)?.boardType !== 'spray')
          );
        },
        (tickUuid) => tickByUuid.get(tickUuid)?.visible === true,
      );

      const toClimb = (climb: DerivedWorkoutClimb): SessionWorkoutClimb => {
        const climbRow = climbByPlanUuid.get(climb.climbUuid);
        const matchedTicks = climb.tickUuids.flatMap((tickUuid) => tickByUuid.get(tickUuid) ?? []);
        const boardType = climbRow?.boardType ?? matchedTicks[0]?.boardType ?? sessionBoardType;
        const ownGrade = matchedTicks.find((tick) => tick.status !== 'attempt' && tick.difficulty != null)?.difficulty;
        const consensus = climbRow
          ? consensusByKey.get(`${climbRow.boardType}:${climbRow.uuid}:${climb.angle}`)
          : undefined;
        const tickBoard = matchedTicks[0]
          ? toTickBoardCandidate({
              boardType: matchedTicks[0].boardType,
              layoutId: matchedTicks[0].boardLayoutId,
              sizeId: matchedTicks[0].boardSizeId,
              setIds: matchedTicks[0].boardSetIds,
            })
          : sessionBoard;
        return {
          queueItemUuid: climb.queueItemUuid,
          climbUuid: climb.climbUuid,
          angle: climb.angle,
          isMirror: climb.isMirror ?? null,
          name: climbRow?.name ?? null,
          grade: gradeName(ownGrade ?? consensus, boardType),
          boardType: boardType ?? null,
          layoutId: climbRow?.layoutId ?? null,
          frames: climbRow?.frames ?? null,
          renderBoard: climbRow
            ? resolveRenderBoard({
                boardType: climbRow.boardType,
                climbLayoutId: climbRow.layoutId,
                compatibleSizeIds: climbRow.compatibleSizeIds,
                requiredSetIds: climbRow.requiredSetIds,
                tickBoard,
                ownerBoards: ownerBoardsByUserId.get(row.userId) ?? [],
              })
            : null,
          reps: climb.reps.map((rep) => REP_OUTCOME[rep]),
          // Every tick here passed keepTick in restrictDerivedWorkout.
          tickUuids: climb.tickUuids,
          skipped: climb.skipped,
        };
      };

      const stages: SessionWorkoutStage[] = visible.stages.map((stage) => {
        const stageBoardType =
          stage.climbs.map((climb) => climbByPlanUuid.get(climb.climbUuid)?.boardType).find(Boolean) ??
          sessionBoardType;
        return {
          id: stage.id,
          kind: stage.kind,
          isCoolDown: stage.isCoolDown,
          targetGrade: gradeName(stage.targetGrade, stageBoardType),
          repsPerSet: stage.repsPerSet ?? null,
          sets: stage.sets ?? null,
          intervalSeconds: stage.intervalSeconds ?? null,
          restSeconds: stage.restSeconds ?? null,
          climbs: stage.climbs.map(toClimb),
          tally: stage.tally,
        };
      });

      return {
        userId: row.userId,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        stages,
        offPlan: visible.offPlan,
        offPlanTickUuids: visible.offPlanTickUuids,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  },

  /**
   * One headline per workout for a page of feed cards (≤ 50 sessions), under
   * the same rule as `sessionWorkouts` for who appears. A session the viewer
   * may not open, or with no workout, is left out. Built from the plan alone,
   * so the line carries only block kinds, the main block's grade and counts.
   * One query for the rows and their access, one for the visible ticks, and
   * one batched name check.
   */
  sessionWorkoutHeadlines: async (
    _: unknown,
    { sessionIds }: { sessionIds: string[] },
    ctx: ConnectionContext,
  ): Promise<SessionWorkoutHeadline[]> => {
    await applyRateLimit(ctx, RATE_LIMIT_SESSION_WORKOUT_HEADLINES, 'sessionWorkoutHeadlines');
    if (sessionIds.length > MAX_SESSION_WORKOUT_HEADLINE_IDS) {
      throw badInput(`At most ${MAX_SESSION_WORKOUT_HEADLINE_IDS} sessions per request`);
    }
    const requestedIds = Array.from(new Set(sessionIds.filter((id) => id && !isDailySessionId(id))));
    if (requestedIds.length === 0) return [];
    const viewerUserId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;

    // The session access check (`canAccessResource`'s rule) sits in the WHERE.
    const rows = await db
      .select({
        sessionId: dbSchema.sessionWorkouts.sessionId,
        userId: dbSchema.sessionWorkouts.userId,
        plan: dbSchema.sessionWorkouts.plan,
        boardPath: dbSchema.boardSessions.boardPath,
        boardId: dbSchema.boardSessions.boardId,
        createdByUserId: dbSchema.boardSessions.createdByUserId,
      })
      .from(dbSchema.sessionWorkouts)
      .innerJoin(dbSchema.boardSessions, eq(dbSchema.boardSessions.id, dbSchema.sessionWorkouts.sessionId))
      .where(
        and(
          inArray(dbSchema.sessionWorkouts.sessionId, requestedIds),
          resourceAccessCondition('session', dbSchema.sessionWorkouts.sessionId, viewerUserId),
        ),
      )
      .orderBy(asc(dbSchema.sessionWorkouts.createdAt), asc(dbSchema.sessionWorkouts.userId));
    if (rows.length === 0) return [];

    const ticks = alias(dbSchema.boardseshTicks, 't');
    const sessionsWithRows = Array.from(new Set(rows.map((row) => row.sessionId)));
    const [visibleTickOwners, visibleOwnersBySession] = await Promise.all([
      db
        .selectDistinct({ sessionId: ticks.sessionId, userId: ticks.userId })
        .from(ticks)
        .where(
          and(
            inArray(ticks.sessionId, sessionsWithRows),
            inArray(ticks.userId, Array.from(new Set(rows.map((row) => row.userId)))),
            tickVisibleSql(ticks, viewerUserId),
          ),
        ),
      sessionsOwnSurfaceVisibleUserIds(
        sessionsWithRows.map((sessionId) => {
          const first = rows.find((row) => row.sessionId === sessionId)!;
          return {
            session: {
              id: sessionId,
              boardId: first.boardId,
              boardPath: first.boardPath,
              createdByUserId: first.createdByUserId,
            },
            userIds: rows.filter((row) => row.sessionId === sessionId).map((row) => row.userId),
          };
        }),
        viewerUserId,
      ),
    ]);
    const shownKey = (sessionId: string | null, userId: string) => `${sessionId}\u0000${userId}`;
    const withVisibleTick = new Set(visibleTickOwners.map((tick) => shownKey(tick.sessionId, tick.userId)));
    const visibleOwners = new Map(
      sessionsWithRows.map((sessionId, index) => [sessionId, visibleOwnersBySession[index]]),
    );

    const headlines = rows.flatMap((row) => {
      if (!visibleOwners.get(row.sessionId)?.has(row.userId)) return [];
      if (!withVisibleTick.has(shownKey(row.sessionId, row.userId))) return [];
      const plan = parseSessionWorkoutPlan(row.plan);
      if (!plan) {
        logUnreadable(row.sessionId, row.userId);
        return [];
      }
      const [mainStage] = mainWorkoutStages(plan.stages);
      return [{ row, headline: workoutHeadline(plan.stages), mainClimbUuid: mainStage?.items[0]?.climbUuid }];
    });

    // The main block's grade is named on its own climbs' board, falling back to
    // the session's board.
    const mainClimbUuids = Array.from(
      new Set(headlines.flatMap(({ mainClimbUuid }) => (mainClimbUuid ? [mainClimbUuid] : []))),
    );
    const boardTypeByClimb = new Map(
      mainClimbUuids.length === 0
        ? []
        : (
            await db
              .select({ uuid: dbSchema.boardClimbs.uuid, boardType: dbSchema.boardClimbs.boardType })
              .from(dbSchema.boardClimbs)
              .where(inArray(dbSchema.boardClimbs.uuid, mainClimbUuids))
          ).map((climb) => [climb.uuid, climb.boardType]),
    );

    const order = new Map(requestedIds.map((sessionId, position) => [sessionId, position]));
    return headlines
      .sort((left, right) => (order.get(left.row.sessionId) ?? 0) - (order.get(right.row.sessionId) ?? 0))
      .map(({ row, headline, mainClimbUuid }) => {
        const boardType = (mainClimbUuid && boardTypeByClimb.get(mainClimbUuid)) || boardTypeFromPath(row.boardPath);
        return {
          sessionId: row.sessionId,
          userId: row.userId,
          mainKind: headline.mainKind ?? null,
          mainTargetGrade: gradeName(headline.mainTargetGrade, boardType),
          secondMainKind: headline.secondMainKind ?? null,
          blockCount: headline.blockCount,
          extraMainBlocks: headline.extraMainBlocks,
        };
      });
  },
};
