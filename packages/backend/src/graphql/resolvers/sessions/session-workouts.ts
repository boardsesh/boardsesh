import { GraphQLError } from 'graphql';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel, sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
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
  type SessionWorkoutPlan,
  type SessionWorkoutRepOutcome as RepOutcome,
  type SessionWorkoutTickMapEntry,
} from '@boardsesh/workout-summary';
import { db } from '../../../db/client';
import { canAccessResource } from '../../../services/privacy';
import { sessionAnonymousUserIds } from '../../../services/board-session-privacy';
import { logger } from '../../../utils/logger';
import { sessionTickVisibleCondition } from '../shared/activity-privacy';
import { applyRateLimit, isDurableSessionMember, requireAuthenticated } from '../shared/helpers';
import { fetchOwnerBoards, toTickBoardCandidate } from '../shared/render-board';
import { sprayTickVisibleSql } from '../shared/spray-tick-visibility';

/**
 * Workout-aware sessions (#6903). One row per climber per session holds the
 * plan their phone followed and which queue item each tick was logged on; what
 * each block came to is derived on read from that climber's ticks with
 * `@boardsesh/workout-summary`, so a tick edited or deleted later is reflected
 * without a rewrite. docs/workout-stages.md, "Workouts on the server".
 */

/** Feed cards ask for one page of sessions at a time. */
export const MAX_SESSION_WORKOUT_HEADLINE_IDS = 50;
const RATE_LIMIT_RECORD_SESSION_WORKOUT = 60;
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

/** Plan + tick map from a stored row, or null when it no longer parses. */
function readStoredWorkout(row: {
  sessionId: string;
  userId: string;
  plan: unknown;
  tickMap: unknown;
}): { plan: SessionWorkoutPlan; tickMap: SessionWorkoutTickMapEntry[] } | null {
  const plan = parseSessionWorkoutPlan(row.plan);
  const tickMap = parseSessionWorkoutTickMap(row.tickMap);
  if (!plan || !tickMap) {
    logger.warn(`[sessionWorkouts] Unreadable workout for session ${row.sessionId}, user ${row.userId}; skipped.`);
    return null;
  }
  return { plan, tickMap };
}

/**
 * Who may write a workout for a session: its creator, anyone who ever joined it
 * (`board_session_participants`, written on join and never deleted), or anyone
 * who logged a tick in it. Reads the primary so a fresh join is never missed.
 */
async function canRecordWorkout(userId: string, sessionId: string, createdByUserId: string | null): Promise<boolean> {
  if (createdByUserId === userId) return true;
  if (await isDurableSessionMember(userId, sessionId)) return true;
  const [tick] = await db
    .select({ uuid: dbSchema.boardseshTicks.uuid })
    .from(dbSchema.boardseshTicks)
    .where(and(eq(dbSchema.boardseshTicks.sessionId, sessionId), eq(dbSchema.boardseshTicks.userId, userId)))
    .limit(1);
  return tick !== undefined;
}

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
 * `visible` is the spray wall rule for this viewer.
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
      visible: sql<boolean>`${sprayClimbVisibilityCondition(
        { boardType: dbSchema.boardClimbs.boardType, layoutId: dbSchema.boardClimbs.layoutId },
        viewerUserId,
      )}`,
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
   * Upserts the caller's own workout for a session. Written only when the
   * revision is higher than the stored one; an equal or lower revision is a
   * no-op that still answers true, so an outbox replay is idempotent.
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

    const [session] = await db
      .select({ createdByUserId: dbSchema.boardSessions.createdByUserId })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, sessionId))
      .limit(1);
    // BAD_USER_INPUT rather than NOT_FOUND: the outbox reads it as permanent,
    // so a replay for a deleted session never blocks the writes behind it.
    if (!session) throw badInput('Session not found');
    if (!(await canRecordWorkout(userId, sessionId, session.createdByUserId))) {
      throw new GraphQLError('Not a participant of this session', { extensions: { code: 'FORBIDDEN' } });
    }

    const now = new Date();
    await db
      .insert(dbSchema.sessionWorkouts)
      .values({ sessionId, userId, plan, tickMap, revision, createdAt: now, updatedAt: now })
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
   * Every workout followed in a session, with what each block came to.
   * Visible wherever the session is (`sessionDetail`'s rule). A climb the
   * viewer may not see (a spray wall they can't open, a tick they may not
   * read) is left out with all its reps.
   */
  sessionWorkouts: async (
    _: unknown,
    { sessionId }: { sessionId: string },
    ctx?: ConnectionContext,
  ): Promise<SessionWorkout[]> => {
    if (!sessionId || isDailySessionId(sessionId)) return [];
    const viewerUserId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;
    if (!(await canAccessResource('session', sessionId, ctx?.userId))) return [];

    const workoutRows = await db
      .select({
        sessionId: dbSchema.sessionWorkouts.sessionId,
        userId: dbSchema.sessionWorkouts.userId,
        plan: dbSchema.sessionWorkouts.plan,
        tickMap: dbSchema.sessionWorkouts.tickMap,
        updatedAt: dbSchema.sessionWorkouts.updatedAt,
        displayName: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.sessionWorkouts)
      .leftJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.sessionWorkouts.userId))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.sessionWorkouts.userId))
      .where(eq(dbSchema.sessionWorkouts.sessionId, sessionId))
      .orderBy(asc(dbSchema.sessionWorkouts.createdAt), asc(dbSchema.sessionWorkouts.userId));
    const workouts = workoutRows.flatMap((row) => {
      const stored = readStoredWorkout(row);
      return stored ? [{ row, ...stored }] : [];
    });
    if (workouts.length === 0) return [];
    const ownerIds = workouts.map(({ row }) => row.userId);

    // The owners' ticks in the session, each with this viewer's verdict on it:
    // the session's own tick rule plus the spray wall rule, exactly the pair
    // the session summary's participant counts use.
    const ticks = alias(dbSchema.boardseshTicks, 't');
    const tickBoards = alias(dbSchema.userBoards, 'tick_board');
    const [tickRows, [session]] = await Promise.all([
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
          visible: sql<boolean>`(${sessionTickVisibleCondition(viewerUserId, ticks)} AND ${sprayTickVisibleSql('t', viewerUserId)})`,
        })
        .from(ticks)
        .leftJoin(tickBoards, eq(ticks.boardId, tickBoards.id))
        .where(and(eq(ticks.sessionId, sessionId), inArray(ticks.userId, ownerIds))),
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
    ]);
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
    const [climbByPlanUuid, ownerBoardsByUserId, anonymous] = await Promise.all([
      fetchPlanClimbs(planClimbUuids, viewerUserId),
      fetchOwnerBoards(ownerIds),
      sessionAnonymousUserIds(ownerIds, viewerUserId, sessionId),
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

      const hidden = anonymous.has(row.userId);
      return {
        userId: hidden ? null : row.userId,
        displayName: hidden ? null : row.displayName,
        avatarUrl: hidden ? null : row.avatarUrl,
        stages,
        offPlan: visible.offPlan,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  },

  /**
   * One headline per workout for a page of feed cards (≤ 50 sessions). A
   * session the viewer may not open, or with no workout, is left out. Built
   * from the plan alone: no ticks are read, so the line carries only block
   * kinds, the main block's grade and counts.
   */
  sessionWorkoutHeadlines: async (
    _: unknown,
    { sessionIds }: { sessionIds: string[] },
    ctx?: ConnectionContext,
  ): Promise<SessionWorkoutHeadline[]> => {
    if (sessionIds.length > MAX_SESSION_WORKOUT_HEADLINE_IDS) {
      throw badInput(`At most ${MAX_SESSION_WORKOUT_HEADLINE_IDS} sessions per request`);
    }
    const requestedIds = Array.from(new Set(sessionIds.filter((id) => id && !isDailySessionId(id))));
    if (requestedIds.length === 0) return [];
    const viewerUserId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;

    const rows = await db
      .select({
        sessionId: dbSchema.sessionWorkouts.sessionId,
        userId: dbSchema.sessionWorkouts.userId,
        plan: dbSchema.sessionWorkouts.plan,
        tickMap: dbSchema.sessionWorkouts.tickMap,
        boardPath: dbSchema.boardSessions.boardPath,
      })
      .from(dbSchema.sessionWorkouts)
      .innerJoin(dbSchema.boardSessions, eq(dbSchema.boardSessions.id, dbSchema.sessionWorkouts.sessionId))
      .where(inArray(dbSchema.sessionWorkouts.sessionId, requestedIds))
      .orderBy(asc(dbSchema.sessionWorkouts.createdAt), asc(dbSchema.sessionWorkouts.userId));
    if (rows.length === 0) return [];

    const sessionsWithRows = Array.from(new Set(rows.map((row) => row.sessionId)));
    const accessible = await Promise.all(
      sessionsWithRows.map(async (sessionId) => {
        if (!(await canAccessResource('session', sessionId, ctx?.userId))) return null;
        const owners = rows.filter((row) => row.sessionId === sessionId).map((row) => row.userId);
        return [sessionId, await sessionAnonymousUserIds(owners, viewerUserId, sessionId)] as const;
      }),
    );
    const anonymousBySession = new Map(accessible.flatMap((entry) => (entry ? [entry] : [])));

    const headlines = rows.flatMap((row) => {
      const anonymous = anonymousBySession.get(row.sessionId);
      if (!anonymous) return [];
      const stored = readStoredWorkout(row);
      if (!stored) return [];
      const headline = workoutHeadline(stored.plan.stages);
      const [mainStage] = mainWorkoutStages(stored.plan.stages);
      return [{ row, headline, mainClimbUuid: mainStage?.items[0]?.climbUuid, anonymous }];
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
      .map(({ row, headline, mainClimbUuid, anonymous }) => {
        const boardType = (mainClimbUuid && boardTypeByClimb.get(mainClimbUuid)) || boardTypeFromPath(row.boardPath);
        return {
          sessionId: row.sessionId,
          userId: anonymous.has(row.userId) ? null : row.userId,
          mainKind: headline.mainKind ?? null,
          mainTargetGrade: gradeName(headline.mainTargetGrade, boardType),
          secondMainKind: headline.secondMainKind ?? null,
          blockCount: headline.blockCount,
          extraMainBlocks: headline.extraMainBlocks,
        };
      });
  },
};
