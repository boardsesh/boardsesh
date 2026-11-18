import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  BoardTypeSchema,
  CreateWorkoutSchema,
  WorkoutPlanSchema,
  WorkoutResultsSchema,
  workoutBlockSupport,
  type WorkoutResults,
} from '@boardsesh/public-api';
import { parseSessionWorkoutPlan } from '@boardsesh/workout-summary';
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
} from '../logbook-feed';
import { readLogbookClimbMetadata, serializeLogbookTick } from '../logbook-tick-serializer';

/** A repeated climb cannot prove which block produced its tick. */
export function inferWorkoutBlockIndex(
  climbUuid: string,
  plan: ReadonlyArray<{ index: number; climbUuids: readonly string[] }>,
): number | null {
  const matching = plan.filter((block) => block.climbUuids.includes(climbUuid));
  return matching.length === 1 ? matching[0].index : null;
}

export async function buildWorkoutResults(
  transaction: PartnerDatabase,
  workout: typeof appWorkouts.$inferSelect,
): Promise<WorkoutResults | undefined> {
  if (!workout.sessionId) return undefined;
  const [session] = await transaction.select().from(boardSessions).where(eq(boardSessions.id, workout.sessionId));
  if (!session?.startedAt || !session.endedAt) return undefined;
  const spec = CreateWorkoutSchema.parse(workout.spec);
  const rows = await transaction
    .select(logbookFeedTickColumns)
    .from(boardseshTicks)
    .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
    .where(and(eq(boardseshTicks.sessionId, workout.sessionId), logbookVisibleTicksFilter(workout.userId)))
    .orderBy(asc(boardseshTicks.climbedAt), asc(boardseshTicks.uuid));
  const metadata = await readLogbookClimbMetadata(transaction as unknown as FeedTransaction, workout.userId, rows);
  let plan = WorkoutPlanSchema.safeParse(workout.planSnapshot).data ?? [];
  if (plan.length === 0) {
    const [stored] = await transaction
      .select({ plan: sessionWorkouts.plan })
      .from(sessionWorkouts)
      .where(and(eq(sessionWorkouts.sessionId, workout.sessionId), eq(sessionWorkouts.userId, workout.userId)));
    const sessionPlan = parseSessionWorkoutPlan(stored?.plan);
    plan =
      sessionPlan?.stages.flatMap((stage) => {
        const prefix = `${workout.id}:`;
        if (!stage.id.startsWith(prefix)) return [];
        const index = Number(stage.id.slice(prefix.length));
        return Number.isInteger(index) && index >= 0 && index < spec.blocks.length
          ? [{ index, climbUuids: stage.items.map((item) => item.climbUuid) }]
          : [];
      }) ?? [];
  }
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
  return WorkoutResultsSchema.parse({
    completion: workout.status === 'auto_closed' ? 'auto_closed' : 'ended',
    session: {
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      durationSeconds: Math.max(0, Math.floor((session.endedAt.getTime() - session.startedAt.getTime()) / 1000)),
      timezone: session.timezone,
      notes: session.notes,
      board: {
        type: boardType,
        name: board?.name ?? null,
        layout: board?.layout ?? null,
        size: board?.size ?? null,
        angle,
      },
    },
    ticks: rows.map((tick) => ({
      ...serializeLogbookTick(tick, metadata),
      blockIndex: inferWorkoutBlockIndex(tick.canonicalClimbUuid, canonicalPlan),
    })),
    blocks: spec.blocks.map((block, index) => ({
      index,
      type: block.type,
      support: workoutBlockSupport(block),
      planned: block,
    })),
  });
}
