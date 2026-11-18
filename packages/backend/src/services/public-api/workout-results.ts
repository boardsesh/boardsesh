import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  BoardTypeSchema,
  CreateWorkoutSchema,
  WorkoutPlanSchema,
  WorkoutResultsSchema,
  workoutBlockSupport,
  type WorkoutResults,
} from '@boardsesh/public-api';
import {
  deriveWorkoutStages,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
  type SessionWorkoutRepOutcome,
} from '@boardsesh/workout-summary';
import {
  appWorkouts,
  boardSessions,
  boardseshTicks,
  boardClimbAliases,
  sessionWorkouts,
  userBoards,
  boardLayouts,
  boardProductSizes,
} from '@boardsesh/db/schema';
import type { PartnerDatabase } from '../../auth/partner/tables';
import {
  logbookFeedTickColumns,
  logbookFeedAliasJoin,
  logbookVisibleTicksFilter,
  type FeedTransaction,
  type LogbookFeedTick,
} from '../logbook-feed';
import { readLogbookClimbMetadata, serializeLogbookTick, utcTimestamp } from '../logbook-tick-serializer';

/** A repeated climb cannot prove which block produced its tick. */
export function inferWorkoutBlockIndex(
  climbUuid: string,
  plan: ReadonlyArray<{ index: number; climbUuids: readonly string[] }>,
): number | null {
  const matching = plan.filter((block) => block.climbUuids.includes(climbUuid));
  return matching.length === 1 ? matching[0].index : null;
}

/** What placing and scoping a tick reads; `status` is the stored tick status. */
type SessionTick = Pick<
  LogbookFeedTick,
  'uuid' | 'climbUuid' | 'canonicalClimbUuid' | 'angle' | 'isMirror' | 'climbedAt'
> & { status: SessionWorkoutRepOutcome };

/**
 * The workout's ticks and the block each landed on, by the climber's stored
 * session workout: the same plan, tick map and `deriveWorkoutStages` the app's
 * session detail uses. The phone names a partner block's stage
 * `${workoutId}:${blockIndex}`. A tick counts when it was logged since the
 * workout started or the tick map pins it to one of those stages, and only
 * those ticks are placed, so an earlier climb of a block's climb neither
 * counts nor takes the block's slot. A tick on any other stage, or off the
 * plan, is on no block. Null when the session holds no stored plan with one of
 * this workout's blocks (a lost write), so the caller falls back to
 * `plan_snapshot`.
 */
async function placeTicksByStoredTickMap(
  transaction: PartnerDatabase,
  { workoutId, userId, sessionId }: { workoutId: string; userId: string; sessionId: string },
  blockCount: number,
  ticks: ReadonlyArray<SessionTick>,
  workoutStartedAt: Date,
): Promise<{ workoutTickUuids: Set<string>; blockIndexByTick: Map<string, number> } | null> {
  const [stored] = await transaction
    .select({ plan: sessionWorkouts.plan, tickMap: sessionWorkouts.tickMap })
    .from(sessionWorkouts)
    .where(and(eq(sessionWorkouts.sessionId, sessionId), eq(sessionWorkouts.userId, userId)));
  const sessionPlan = parseSessionWorkoutPlan(stored?.plan);
  if (!sessionPlan) return null;
  const stagePrefix = `${workoutId}:`;
  const blockIndexByStage = new Map<string, number>();
  const workoutQueueItems = new Set<string>();
  for (const stage of sessionPlan.stages) {
    if (!stage.id.startsWith(stagePrefix)) continue;
    const blockIndex = Number(stage.id.slice(stagePrefix.length));
    if (Number.isInteger(blockIndex) && blockIndex >= 0 && blockIndex < blockCount) {
      blockIndexByStage.set(stage.id, blockIndex);
      for (const item of stage.items) workoutQueueItems.add(item.queueItemUuid);
    }
  }
  if (blockIndexByStage.size === 0) return null;
  // An unreadable map pins nothing; ticks are then placed by climb.
  const tickMap = parseSessionWorkoutTickMap(stored?.tickMap) ?? [];
  const pinnedTickUuids = new Set(
    tickMap.filter((entry) => workoutQueueItems.has(entry.queueItemUuid)).map((entry) => entry.tickUuid),
  );
  const workoutTicks = ticks.filter((tick) => pinnedTickUuids.has(tick.uuid) || loggedSince(tick, workoutStartedAt));
  const derived = deriveWorkoutStages(
    sessionPlan,
    tickMap,
    workoutTicks.map((tick) => ({
      uuid: tick.uuid,
      climbUuid: tick.climbUuid,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status,
      climbedAt: utcTimestamp(tick.climbedAt),
    })),
  );
  const blockIndexByTick = new Map<string, number>();
  for (const stage of derived.stages) {
    const blockIndex = blockIndexByStage.get(stage.id);
    if (blockIndex === undefined) continue;
    for (const climb of stage.climbs) {
      for (const tickUuid of climb.tickUuids) blockIndexByTick.set(tickUuid, blockIndex);
    }
  }
  return { workoutTickUuids: new Set(workoutTicks.map((tick) => tick.uuid)), blockIndexByTick };
}

/**
 * Today's guess for a session with no stored plan: a block only when exactly
 * one block of `plan_snapshot` queued the tick's climb (aliases followed).
 */
async function blockIndexBySnapshotClimb(
  transaction: PartnerDatabase,
  planSnapshot: unknown,
): Promise<(tick: SessionTick) => number | null> {
  const plan = WorkoutPlanSchema.safeParse(planSnapshot).data ?? [];
  const aliasUuids = [...new Set(plan.flatMap((block) => block.climbUuids))];
  const aliases = aliasUuids.length
    ? await transaction
        .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
        .from(boardClimbAliases)
        .where(inArray(boardClimbAliases.aliasUuid, aliasUuids))
    : [];
  const canonicalByAlias = new Map(aliases.map((alias) => [alias.aliasUuid, alias.canonicalUuid]));
  const canonicalPlan = plan.map((block) => ({
    ...block,
    climbUuids: block.climbUuids.map((uuid) => canonicalByAlias.get(uuid) ?? uuid),
  }));
  return (tick) => inferWorkoutBlockIndex(tick.canonicalClimbUuid, canonicalPlan);
}

/**
 * Logged once the workout was running, by the time the climber logged it
 * (`climbedAt`), not the time it reached the server: ticks logged offline
 * before the workout and synced after it started stay out.
 */
function loggedSince(tick: SessionTick, workoutStartedAt: Date): boolean {
  return Date.parse(utcTimestamp(tick.climbedAt)) >= workoutStartedAt.getTime();
}

/**
 * The workout's results: only that workout's own ticks. A tick counts when it
 * was logged after the workout started or the stored tick map pins it to one
 * of the workout's blocks, so "Add to this session" never hands the app the
 * climbs from before it. The session's times start at the workout.
 */
export async function buildWorkoutResults(
  transaction: PartnerDatabase,
  workout: typeof appWorkouts.$inferSelect,
): Promise<WorkoutResults | undefined> {
  const { sessionId } = workout;
  if (!sessionId) return undefined;
  const [session] = await transaction.select().from(boardSessions).where(eq(boardSessions.id, sessionId));
  if (!session?.startedAt || !session.endedAt) return undefined;
  const spec = CreateWorkoutSchema.parse(workout.spec);
  const workoutStartedAt =
    workout.startedAt && workout.startedAt > session.startedAt ? workout.startedAt : session.startedAt;
  const sessionTicks = await transaction
    .select(logbookFeedTickColumns)
    .from(boardseshTicks)
    .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
    .where(and(eq(boardseshTicks.sessionId, sessionId), logbookVisibleTicksFilter(workout.userId)))
    .orderBy(asc(boardseshTicks.climbedAt), asc(boardseshTicks.uuid));
  const storedPlacement = await placeTicksByStoredTickMap(
    transaction,
    { workoutId: workout.id, userId: workout.userId, sessionId },
    spec.blocks.length,
    sessionTicks,
    workoutStartedAt,
  );
  const rows = sessionTicks.filter((tick) =>
    storedPlacement ? storedPlacement.workoutTickUuids.has(tick.uuid) : loggedSince(tick, workoutStartedAt),
  );
  const blockIndexOf = storedPlacement
    ? (tick: SessionTick) => storedPlacement.blockIndexByTick.get(tick.uuid) ?? null
    : await blockIndexBySnapshotClimb(transaction, workout.planSnapshot);
  const metadata = await readLogbookClimbMetadata(transaction as unknown as FeedTransaction, workout.userId, rows);
  const pathParts = session.boardPath?.split('/') ?? [];
  const pathType = BoardTypeSchema.safeParse(pathParts[0]).data;
  const pathLayoutId = pathParts[1] && /^\d+$/.test(pathParts[1]) ? Number(pathParts[1]) : null;
  const pathSizeId = pathParts[2] && /^\d+$/.test(pathParts[2]) ? Number(pathParts[2]) : null;
  const pathAngle = pathParts[4] && Number.isFinite(Number(pathParts[4])) ? Number(pathParts[4]) : null;
  const [board] = session.boardId
    ? await transaction
        .select({
          type: userBoards.boardType,
          name: userBoards.name,
          layout: boardLayouts.name,
          size: boardProductSizes.name,
          angle: userBoards.angle,
        })
        .from(userBoards)
        .leftJoin(
          boardLayouts,
          and(
            eq(boardLayouts.boardType, pathType ?? userBoards.boardType),
            eq(boardLayouts.id, pathLayoutId ?? userBoards.layoutId),
          ),
        )
        .leftJoin(
          boardProductSizes,
          and(
            eq(boardProductSizes.boardType, pathType ?? userBoards.boardType),
            eq(boardProductSizes.id, pathSizeId ?? userBoards.sizeId),
          ),
        )
        .where(eq(userBoards.id, session.boardId))
    : [];
  const boardType = BoardTypeSchema.parse(pathType ?? board?.type ?? rows[0]?.boardType ?? 'kilter');
  const angle = pathAngle ?? board?.angle ?? null;
  const ownsSession = session.createdByUserId === workout.userId;
  return WorkoutResultsSchema.parse({
    completion: workout.status === 'auto_closed' ? 'auto_closed' : 'ended',
    session: {
      startedAt: workoutStartedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      durationSeconds: Math.max(0, Math.floor((session.endedAt.getTime() - workoutStartedAt.getTime()) / 1000)),
      timezone: ownsSession ? session.timezone : null,
      notes: ownsSession ? session.notes : null,
      board: {
        type: boardType,
        name: ownsSession ? (board?.name ?? null) : null,
        layout: board?.layout ?? null,
        size: board?.size ?? null,
        angle,
      },
    },
    ticks: rows.map((tick) => ({
      ...serializeLogbookTick(tick, metadata),
      blockIndex: blockIndexOf(tick),
    })),
    blocks: spec.blocks.map((block, index) => ({
      index,
      type: block.type,
      support: workoutBlockSupport(block),
      planned: block,
    })),
  });
}
