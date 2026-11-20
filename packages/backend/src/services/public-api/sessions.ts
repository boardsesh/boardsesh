import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import {
  BoardTypeSchema,
  CreateWorkoutSchema,
  PartnerSessionSchema,
  WorkoutPlanSchema,
  type PartnerSession,
  type SessionWorkout,
  type WorkoutBlock,
} from '@boardsesh/public-api';
import {
  deriveWorkoutStages,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
  type SessionWorkoutPacing,
  type SessionWorkoutPlan,
} from '@boardsesh/workout-summary';
import {
  appWorkouts,
  boardClimbAliases,
  boardClimbs,
  boardLayouts,
  boardProductSizes,
  boardSessionParticipants,
  boardSessions,
  boardseshTicks,
  sessionWorkouts,
  userBoards,
} from '@boardsesh/db/schema';
import {
  logbookFeedAliasJoin,
  logbookFeedTickColumns,
  logbookVisibleTicksFilter,
  type FeedTransaction,
  type LogbookFeedTick,
} from '../logbook-feed';
import {
  logbookGrade,
  readLogbookClimbMetadata,
  utcTimestamp,
  type LogbookClimbMetadata,
} from '../logbook-tick-serializer';

/** A tick may name an arbitrary session; only ownership or durable joining proves access. */
export function eligiblePartnerSessionCondition(userId: string): SQL {
  return and(
    eq(boardSessions.status, 'ended'),
    eq(boardSessions.isPermanent, false),
    or(
      eq(boardSessions.createdByUserId, userId),
      sql`EXISTS (SELECT 1 FROM ${boardSessionParticipants}
        WHERE ${boardSessionParticipants.sessionId} = ${boardSessions.id}
          AND ${boardSessionParticipants.userId} = ${userId})`,
    ),
  ) as SQL;
}

/** Missing and reversed legacy bounds are unknown; tick spans are never substituted. */
export function recordedSessionDuration(startedAt: Date | null, endedAt: Date | null): number | null {
  if (!startedAt || !endedAt) return null;
  const elapsed = endedAt.getTime() - startedAt.getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed / 1000) : null;
}

const MAX_WORKOUT_TICKS_PER_READ = 100_000;
export const PARTNER_SESSION_TOO_LARGE_MESSAGE =
  'This page contains more than 100000 workout ticks. Retry with a smaller limit. A single session supports at most 100000 workout ticks; contact Boardsesh support if limit=1 still fails.';

/** A finite source bound; never silently omit workout reps or their attribution. */
export class PartnerSessionReadTooLarge extends Error {
  constructor() {
    super('The session workouts exceed the bounded read size');
    this.name = 'PartnerSessionReadTooLarge';
  }
}

/** Use the stored board entity for named paths, whose slug contains no board type. */
function sessionBoardContext(boardPath: string | null, boardType: string | null, boardAngle: number | null) {
  const namedPath = parseNamedBoardPath(boardPath ?? '');
  const tuplePath = namedPath ? null : parseBoardPath(boardPath ?? '');
  const pathAngle = namedPath?.angle ?? tuplePath?.angle;
  return {
    type: BoardTypeSchema.safeParse(tuplePath?.boardName).data ?? BoardTypeSchema.safeParse(boardType).data ?? null,
    angle:
      pathAngle !== null &&
      pathAngle !== undefined &&
      Number.isInteger(pathAngle) &&
      pathAngle >= -90 &&
      pathAngle <= 90
        ? pathAngle
        : boardAngle,
  };
}

function blockPacing(block: WorkoutBlock): SessionWorkoutPacing | undefined {
  if (block.type === 'onTheMinute') return { mode: 'onTheMinute', restSeconds: block.intervalSeconds };
  if ('restSeconds' in block && block.restSeconds !== undefined)
    return { mode: 'afterTick', restSeconds: block.restSeconds };
  return undefined;
}

/** A lost native-plan write can still leave the partner's queued-climb snapshot. */
function fallbackPlan(workout: typeof appWorkouts.$inferSelect | undefined, angle: number): SessionWorkoutPlan | null {
  if (!workout) return null;
  const spec = CreateWorkoutSchema.safeParse(workout.spec).data;
  const snapshot = WorkoutPlanSchema.safeParse(workout.planSnapshot).data;
  if (!spec || !snapshot) return null;
  return {
    version: 1,
    stages: spec.blocks.map((block, index) => ({
      id: `block-${index}`,
      kind: block.type,
      pacing: blockPacing(block),
      items: (snapshot.find((entry) => entry.index === index)?.climbUuids ?? []).map((climbUuid, climbIndex) => ({
        queueItemUuid: `${index}:${climbIndex}`,
        climbUuid,
        angle,
      })),
    })),
  };
}

function publicWorkout(
  plan: SessionWorkoutPlan | null,
  storedTickMap: unknown,
  partnerWorkout: typeof appWorkouts.$inferSelect | undefined,
  ticks: readonly LogbookFeedTick[],
  boardTypes: ReadonlyMap<string, string>,
  metadata: LogbookClimbMetadata,
): SessionWorkout | null {
  const partnerSpec = partnerWorkout ? CreateWorkoutSchema.safeParse(partnerWorkout.spec).data : undefined;
  if (!plan && !partnerSpec) return null;
  const usablePlan = plan ?? { version: 1 as const, stages: [] };
  const derived = deriveWorkoutStages(
    usablePlan,
    parseSessionWorkoutTickMap(storedTickMap) ?? [],
    ticks.map((tick) => ({
      uuid: tick.uuid,
      climbUuid: tick.canonicalClimbUuid,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status === 'flash' || tick.status === 'send' ? tick.status : 'attempt',
      climbedAt: utcTimestamp(tick.climbedAt),
    })),
  );
  return {
    source: partnerWorkout ? 'partner' : 'boardsesh',
    title: partnerSpec?.title ?? null,
    notes: partnerSpec?.notes ?? null,
    plannedBlocks:
      partnerSpec?.blocks.map((block) => {
        const publicBlock = { ...block };
        delete publicBlock.externalRef;
        return publicBlock;
      }) ?? [],
    stages: derived.stages.map((stage, index) => {
      const storedStage = usablePlan.stages[index];
      const originalPositionByItem = new Map(storedStage.items.map((item) => [item.queueItemUuid, item.position]));
      const stageBoardTypes = new Set(storedStage.items.map((item) => boardTypes.get(item.climbUuid)).filter(Boolean));
      const soleBoardType = stageBoardTypes.size === 1 ? [...stageBoardTypes][0] : undefined;
      return {
        index,
        kind: stage.kind,
        isCoolDown: stage.isCoolDown,
        targetGrade:
          soleBoardType && storedStage.targetGrade !== undefined
            ? logbookGrade(soleBoardType, storedStage.targetGrade)
            : null,
        pacing: storedStage.pacing ?? null,
        tally: stage.tally,
        climbs: stage.climbs.map((climb, climbIndex) => {
          const boardType = boardTypes.get(climb.climbUuid);
          const climbMetadata = boardType ? metadata.climbs.get(`${boardType}\u0000${climb.climbUuid}`) : undefined;
          return {
            index: climbIndex,
            ...(originalPositionByItem.get(climb.queueItemUuid) === undefined
              ? {}
              : { position: originalPositionByItem.get(climb.queueItemUuid) }),
            climbId: climb.climbUuid,
            name: climbMetadata?.namesVisible ? climbMetadata.name : null,
            boardType: BoardTypeSchema.safeParse(boardType).data ?? null,
            grade: boardType
              ? logbookGrade(
                  boardType,
                  metadata.communityDifficulty.get(`${boardType}\u0000${climb.climbUuid}\u0000${climb.angle}`) ?? null,
                )
              : null,
            angle: climb.angle,
            mirrored: climb.isMirror ?? false,
            reps: climb.reps,
            tickIds: climb.tickUuids,
            skipped: climb.skipped,
          };
        }),
      };
    }),
    offPlanTickIds: derived.offPlanTickUuids,
  };
}

/**
 * Batch all session, workout, tick and climb reads for a page. The caller owns
 * the read-only REPEATABLE READ transaction and rechecks the OAuth connection.
 * Raw session, user, stage, queue and partner identifiers stay inside this function.
 */
export async function readPartnerSessions(
  transaction: FeedTransaction,
  userId: string,
  exportIds: readonly string[],
): Promise<Map<string, PartnerSession>> {
  const presented = new Map<string, PartnerSession>();
  if (exportIds.length === 0) return presented;
  const sessions = await transaction
    .select({
      session: boardSessions,
      boardType: userBoards.boardType,
      boardName: userBoards.name,
      boardAngle: userBoards.angle,
      boardOwnerId: userBoards.ownerId,
      layout: boardLayouts.name,
      size: boardProductSizes.name,
    })
    .from(boardSessions)
    .leftJoin(userBoards, eq(userBoards.id, boardSessions.boardId))
    .leftJoin(
      boardLayouts,
      and(eq(boardLayouts.boardType, userBoards.boardType), eq(boardLayouts.id, userBoards.layoutId)),
    )
    .leftJoin(
      boardProductSizes,
      and(eq(boardProductSizes.boardType, userBoards.boardType), eq(boardProductSizes.id, userBoards.sizeId)),
    )
    .where(and(inArray(boardSessions.exportId, [...exportIds]), eligiblePartnerSessionCondition(userId)));
  if (sessions.length === 0) return presented;
  const sessionIds = sessions.map(({ session }) => session.id);
  const storedWorkouts = await transaction
    .select()
    .from(sessionWorkouts)
    .where(and(eq(sessionWorkouts.userId, userId), inArray(sessionWorkouts.sessionId, sessionIds)));
  const partnerWorkouts = await transaction
    .select()
    .from(appWorkouts)
    .where(and(eq(appWorkouts.userId, userId), inArray(appWorkouts.sessionId, sessionIds)));
  const storedBySession = new Map(storedWorkouts.map((workout) => [workout.sessionId, workout]));
  const partnerBySession = new Map(partnerWorkouts.map((workout) => [workout.sessionId, workout]));
  const plans = new Map<string, SessionWorkoutPlan | null>();
  for (const { session, boardType, boardAngle } of sessions) {
    const context = sessionBoardContext(session.boardPath, boardType, boardAngle);
    plans.set(
      session.id,
      parseSessionWorkoutPlan(storedBySession.get(session.id)?.plan) ??
        fallbackPlan(partnerBySession.get(session.id), context.angle ?? 0),
    );
  }
  const workoutSessionIds = sessionIds.filter((sessionId) => plans.get(sessionId) || partnerBySession.has(sessionId));
  const ticks =
    workoutSessionIds.length === 0
      ? []
      : await transaction
          .select({ ...logbookFeedTickColumns, sessionId: boardseshTicks.sessionId })
          .from(boardseshTicks)
          .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
          .where(and(logbookVisibleTicksFilter(userId), inArray(boardseshTicks.sessionId, workoutSessionIds)))
          .orderBy(asc(boardseshTicks.sessionId), asc(boardseshTicks.climbedAt), asc(boardseshTicks.uuid))
          .limit(MAX_WORKOUT_TICKS_PER_READ + 1);
  if (ticks.length > MAX_WORKOUT_TICKS_PER_READ) throw new PartnerSessionReadTooLarge();
  const ticksBySession = new Map<string, LogbookFeedTick[]>();
  for (const tick of ticks) {
    if (!tick.sessionId) continue;
    const ownTicks = ticksBySession.get(tick.sessionId) ?? [];
    ownTicks.push(tick);
    ticksBySession.set(tick.sessionId, ownTicks);
  }
  const plannedClimbIds = [
    ...new Set(
      [...plans.values()].flatMap(
        (plan) => plan?.stages.flatMap((stage) => stage.items.map((item) => item.climbUuid)) ?? [],
      ),
    ),
  ];
  // Plans capture the original climb ids. A catalog merge can remove that
  // climb row while ticks already expose its surviving canonical id. Resolve
  // both before deriving results, preserving queue-item pins and plan order.
  const aliases: Array<{ aliasUuid: string; canonicalUuid: string; boardType: string }> = [];
  for (let offset = 0; offset < plannedClimbIds.length; offset += 1000) {
    aliases.push(
      ...(await transaction
        .select({
          aliasUuid: boardClimbAliases.aliasUuid,
          canonicalUuid: boardClimbAliases.canonicalUuid,
          boardType: boardClimbAliases.boardType,
        })
        .from(boardClimbAliases)
        .where(inArray(boardClimbAliases.aliasUuid, plannedClimbIds.slice(offset, offset + 1000)))),
    );
  }
  const catalogIds = [...new Set([...plannedClimbIds, ...aliases.map((alias) => alias.canonicalUuid)])];
  const plannedClimbs: Array<{ id: string; boardType: string }> = [];
  for (let offset = 0; offset < catalogIds.length; offset += 1000) {
    plannedClimbs.push(
      ...(await transaction
        .select({ id: boardClimbs.uuid, boardType: boardClimbs.boardType })
        .from(boardClimbs)
        .where(inArray(boardClimbs.uuid, catalogIds.slice(offset, offset + 1000)))),
    );
  }
  const boardTypes = new Map(plannedClimbs.map((climb) => [climb.id, climb.boardType]));
  const aliasesByStoredId = new Map<string, typeof aliases>();
  for (const alias of aliases) {
    const candidates = aliasesByStoredId.get(alias.aliasUuid) ?? [];
    candidates.push(alias);
    aliasesByStoredId.set(alias.aliasUuid, candidates);
  }
  const canonicalByStoredId = new Map<string, string>();
  for (const climbId of plannedClimbIds) {
    const storedBoardType = boardTypes.get(climbId);
    const candidates = (aliasesByStoredId.get(climbId) ?? []).filter(
      (alias) => storedBoardType === undefined || alias.boardType === storedBoardType,
    );
    // Native plans have no board type per item. If the original catalog row
    // disappeared and several board-specific aliases conflict, do not guess.
    if (candidates.length === 1) canonicalByStoredId.set(climbId, candidates[0].canonicalUuid);
  }
  for (const [sessionId, plan] of plans) {
    if (!plan) continue;
    plans.set(sessionId, {
      ...plan,
      stages: plan.stages.map((stage) => ({
        ...stage,
        items: stage.items.map((item) => ({
          ...item,
          climbUuid: canonicalByStoredId.get(item.climbUuid) ?? item.climbUuid,
        })),
      })),
    });
  }
  const plannedMetadata = [...plans.values()].flatMap(
    (plan) =>
      plan?.stages.flatMap((stage) =>
        stage.items.flatMap((item) => {
          const boardType = boardTypes.get(item.climbUuid);
          return boardType ? [{ uuid: '', boardType, canonicalClimbUuid: item.climbUuid, angle: item.angle }] : [];
        }),
      ) ?? [],
  );
  const metadata = await readLogbookClimbMetadata(transaction, userId, plannedMetadata);
  for (const { session, boardType, boardName, boardAngle, boardOwnerId, layout, size } of sessions) {
    const ownsSession = session.createdByUserId === userId;
    const context = sessionBoardContext(session.boardPath, boardType, boardAngle);
    // A board's legacy public flag is not the spray wall's current audience.
    // Until the session record has a wall-level visibility projection, only
    // its owner can share the wall's identity with a partner.
    const withholdSprayIdentity = (context.type === 'spray' || boardType === 'spray') && boardOwnerId !== userId;
    presented.set(
      session.exportId,
      PartnerSessionSchema.parse({
        id: session.exportId,
        title: ownsSession ? session.name : null,
        notes: ownsSession ? session.notes : null,
        goal: ownsSession ? session.goal : null,
        origin: session.origin,
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        durationSeconds: recordedSessionDuration(session.startedAt, session.endedAt),
        timezone: ownsSession ? session.timezone : null,
        board: {
          type: context.type,
          name: ownsSession && !withholdSprayIdentity ? boardName : null,
          layout: withholdSprayIdentity ? null : layout,
          size: withholdSprayIdentity ? null : size,
          angle: context.angle,
        },
        url: `https://www.boardsesh.com/history/session/${session.exportId}`,
        appUrl: `com.boardsesh.app://history/session/${session.exportId}`,
        workout: publicWorkout(
          plans.get(session.id) ?? null,
          storedBySession.get(session.id)?.tickMap,
          partnerBySession.get(session.id),
          ticksBySession.get(session.id) ?? [],
          boardTypes,
          metadata,
        ),
      }),
    );
  }
  return presented;
}
