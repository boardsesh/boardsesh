import { and, asc, eq, inArray } from 'drizzle-orm';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import {
  BoardTypeSchema,
  CreateWorkoutSchema,
  WorkoutPlanSchema,
  WorkoutResultsSchema,
  workoutBlockSupport,
  type WorkoutResults,
  type WorkoutBlock,
  type WorkoutBlockProgress,
} from '@boardsesh/public-api';
import {
  deriveWorkoutStages,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
  type SessionWorkoutRepOutcome,
  type SessionWorkoutPlanStage,
  type SessionWorkoutTickMapEntry,
} from '@boardsesh/workout-summary';
import {
  appWorkouts,
  boardSessions,
  boardseshTicks,
  boardClimbAliases,
  boardClimbs,
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

/** A workout started this long after its session was added to a session already running. */
const ATTACHED_TO_RUNNING_SESSION_MS = 5_000;

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

type WorkoutTickPosition = { roundIndex: number; climbIndex: number };
type StoredWorkoutPlacement = {
  workoutTickUuids: Set<string>;
  blockIndexByTick: Map<string, number>;
  positionByTick: Map<string, WorkoutTickPosition>;
  progressByBlock: Map<number, WorkoutBlockProgress | null>;
};

/** Exact visit progress requires the recorded occurrence, never a guess from a repeated climb. */
export function derivePartnerRoundProgress(
  block: Extract<WorkoutBlock, { type: 'fourByFour' }>,
  stage: SessionWorkoutPlanStage | undefined,
  ticks: ReadonlyArray<Pick<SessionTick, 'uuid' | 'status' | 'climbUuid' | 'angle' | 'isMirror'>>,
  tickMap: ReadonlyArray<SessionWorkoutTickMapEntry>,
): { progress: WorkoutBlockProgress | null; positionByTick: Map<string, WorkoutTickPosition> } {
  const positionByTick = new Map<string, WorkoutTickPosition>();
  const unknown = { progress: null, positionByTick };
  const pacing = stage?.pacing;
  if (
    !stage ||
    stage.kind !== 'fourByFour' ||
    pacing?.advanceOn !== 'round' ||
    pacing.roundCount !== block.rounds ||
    pacing.climbsPerRound !== block.climbCount
  )
    return unknown;
  const plannedVisits = block.rounds * block.climbCount;
  const itemsByUuid = new Map(stage.items.map((item) => [item.queueItemUuid, item]));
  const positions = new Set<number>();
  for (const item of stage.items) {
    if (
      item.position === undefined ||
      item.position < 0 ||
      item.position >= plannedVisits ||
      positions.has(item.position)
    )
      return unknown;
    positions.add(item.position);
  }
  const itemByTick = new Map(tickMap.map((entry) => [entry.tickUuid, entry.queueItemUuid]));
  const occupied = new Set<number>();
  let sends = 0;
  let falls = 0;
  let ambiguous = false;
  for (const tick of ticks) {
    const itemUuid = itemByTick.get(tick.uuid);
    const item = itemUuid === undefined ? undefined : itemsByUuid.get(itemUuid);
    if (
      !item ||
      item.position === undefined ||
      item.climbUuid !== tick.climbUuid ||
      item.angle !== tick.angle ||
      (item.isMirror !== undefined && tick.isMirror != null && item.isMirror !== tick.isMirror)
    ) {
      ambiguous = true;
      continue;
    }
    occupied.add(item.position);
    positionByTick.set(tick.uuid, {
      roundIndex: Math.floor(item.position / block.climbCount),
      climbIndex: item.position % block.climbCount,
    });
    if (tick.status === 'attempt') falls += 1;
    else sends += 1;
  }
  if (ambiguous) return unknown;
  let completedRounds = 0;
  for (let roundIndex = 0; roundIndex < block.rounds; roundIndex++) {
    if (
      Array.from({ length: block.climbCount }, (_, climbIndex) => roundIndex * block.climbCount + climbIndex).every(
        (position) => occupied.has(position),
      )
    )
      completedRounds += 1;
  }
  return {
    positionByTick,
    progress: {
      status: completedRounds === block.rounds ? 'completed' : ticks.length > 0 ? 'partial' : 'not_started',
      completedRounds,
      plannedRounds: block.rounds,
      sends,
      falls,
    },
  };
}

/**
 * The workout's ticks and the block each landed on, by the climber's stored
 * session workout: the same plan, tick map and `deriveWorkoutStages` the app's
 * session detail uses. The phone names a partner block's stage
 * `${workoutId}:${blockIndex}`. A tick counts when it was logged during the
 * workout or the tick map pins it to one of those stages, and only
 * those ticks are placed, so an earlier climb of a block's climb neither
 * counts nor takes the block's slot. A tick on any other stage, or off the
 * plan, is on no block. Null when the session holds no stored plan with one of
 * this workout's blocks (a lost write), so the caller falls back to
 * `plan_snapshot`.
 */
async function placeTicksByStoredTickMap(
  transaction: PartnerDatabase,
  { workoutId, userId, sessionId }: { workoutId: string; userId: string; sessionId: string },
  blocks: ReadonlyArray<WorkoutBlock>,
  ticks: ReadonlyArray<SessionTick>,
  loggedDuringWorkout: (tick: SessionTick) => boolean,
): Promise<StoredWorkoutPlacement | null> {
  const [stored] = await transaction
    .select({ plan: sessionWorkouts.plan, tickMap: sessionWorkouts.tickMap })
    .from(sessionWorkouts)
    .where(and(eq(sessionWorkouts.sessionId, sessionId), eq(sessionWorkouts.userId, userId)));
  const recordedPlan = parseSessionWorkoutPlan(stored?.plan);
  if (!recordedPlan) return null;
  // Catalog merges can leave an old alias in the saved plan while tick reads
  // already expose the surviving id. Resolve both in this same read snapshot.
  // A plan item has no board type: use its original catalog row when present,
  // otherwise only follow a single unambiguous board-specific alias.
  const plannedIds = [...new Set(recordedPlan.stages.flatMap((stage) => stage.items.map((item) => item.climbUuid)))];
  const aliases = plannedIds.length
    ? await transaction
        .select({
          aliasUuid: boardClimbAliases.aliasUuid,
          canonicalUuid: boardClimbAliases.canonicalUuid,
          boardType: boardClimbAliases.boardType,
        })
        .from(boardClimbAliases)
        .where(inArray(boardClimbAliases.aliasUuid, plannedIds))
    : [];
  const catalogRows = aliases.length
    ? await transaction
        .select({
          uuid: boardClimbs.uuid,
          boardType: boardClimbs.boardType,
        })
        .from(boardClimbs)
        .where(inArray(boardClimbs.uuid, plannedIds))
    : [];
  const boardByStoredId = new Map(catalogRows.map((row) => [row.uuid, row.boardType]));
  const canonicalByStoredId = new Map<string, string>();
  for (const climbUuid of plannedIds) {
    const boardType = boardByStoredId.get(climbUuid);
    const candidates = aliases.filter(
      (alias) => alias.aliasUuid === climbUuid && (boardType === undefined || alias.boardType === boardType),
    );
    if (candidates.length === 1) canonicalByStoredId.set(climbUuid, candidates[0].canonicalUuid);
  }
  const sessionPlan = {
    ...recordedPlan,
    stages: recordedPlan.stages.map((stage) => ({
      ...stage,
      items: stage.items.map((item) => ({
        ...item,
        climbUuid: canonicalByStoredId.get(item.climbUuid) ?? item.climbUuid,
      })),
    })),
  };
  const stagePrefix = `${workoutId}:`;
  const blockIndexByStage = new Map<string, number>();
  const workoutQueueItems = new Set<string>();
  for (const stage of sessionPlan.stages) {
    if (!stage.id.startsWith(stagePrefix)) continue;
    const blockIndexText = stage.id.slice(stagePrefix.length);
    const blockIndex = Number(blockIndexText);
    if (/^\d+$/.test(blockIndexText) && blockIndex < blocks.length) {
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
  const workoutTicks = ticks.filter((tick) => pinnedTickUuids.has(tick.uuid) || loggedDuringWorkout(tick));
  const derived = deriveWorkoutStages(
    sessionPlan,
    tickMap,
    workoutTicks.map((tick) => ({
      uuid: tick.uuid,
      climbUuid: tick.canonicalClimbUuid,
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
  const positionByTick = new Map<string, WorkoutTickPosition>();
  const progressByBlock = new Map<number, WorkoutBlockProgress | null>();
  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'fourByFour') continue;
    const stage = sessionPlan.stages.find((candidate) => candidate.id === `${stagePrefix}${index}`);
    const roundResults = derivePartnerRoundProgress(
      block,
      stage,
      workoutTicks
        .filter((tick) => blockIndexByTick.get(tick.uuid) === index)
        .map((tick) => ({ ...tick, climbUuid: tick.canonicalClimbUuid })),
      tickMap,
    );
    progressByBlock.set(index, roundResults.progress);
    for (const [tickUuid, position] of roundResults.positionByTick) positionByTick.set(tickUuid, position);
  }
  return {
    workoutTickUuids: new Set(workoutTicks.map((tick) => tick.uuid)),
    blockIndexByTick,
    positionByTick,
    progressByBlock,
  };
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
  // Start creates a session and attaches the workout in one transaction, a few
  // ms apart, so the session holds nothing from before the workout. Only a
  // workout added to a session already running has earlier ticks to leave out;
  // a new session keeps every tick, whatever the phone's clock said.
  const attachedToRunningSession =
    workout.startedAt !== null &&
    workout.startedAt.getTime() - session.startedAt.getTime() > ATTACHED_TO_RUNNING_SESSION_MS;
  const workoutStartedAt = attachedToRunningSession && workout.startedAt ? workout.startedAt : session.startedAt;
  const loggedDuringWorkout = (tick: SessionTick) => !attachedToRunningSession || loggedSince(tick, workoutStartedAt);
  const sessionTicks = await transaction
    .select(logbookFeedTickColumns)
    .from(boardseshTicks)
    .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
    .where(and(eq(boardseshTicks.sessionId, sessionId), logbookVisibleTicksFilter(workout.userId)))
    .orderBy(asc(boardseshTicks.climbedAt), asc(boardseshTicks.uuid));
  const storedPlacement = await placeTicksByStoredTickMap(
    transaction,
    { workoutId: workout.id, userId: workout.userId, sessionId },
    spec.blocks,
    sessionTicks,
    loggedDuringWorkout,
  );
  const rows = sessionTicks.filter((tick) =>
    storedPlacement ? storedPlacement.workoutTickUuids.has(tick.uuid) : loggedDuringWorkout(tick),
  );
  const blockIndexOf = storedPlacement
    ? (tick: SessionTick) => storedPlacement.blockIndexByTick.get(tick.uuid) ?? null
    : await blockIndexBySnapshotClimb(transaction, workout.planSnapshot);
  const metadata = await readLogbookClimbMetadata(transaction as unknown as FeedTransaction, workout.userId, rows);
  const namedPath = parseNamedBoardPath(session.boardPath ?? '');
  const tuplePath = namedPath ? null : parseBoardPath(session.boardPath ?? '');
  const pathType = BoardTypeSchema.safeParse(tuplePath?.boardName).data;
  const pathLayoutId = tuplePath?.layoutId ?? null;
  const pathSizeId = tuplePath?.sizeId ?? null;
  const requestedAngle = namedPath?.angle ?? tuplePath?.angle;
  const pathAngle =
    requestedAngle != null && Number.isInteger(requestedAngle) && requestedAngle >= -90 && requestedAngle <= 90
      ? requestedAngle
      : null;
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
      ...(storedPlacement?.positionByTick.has(tick.uuid)
        ? { position: storedPlacement.positionByTick.get(tick.uuid) }
        : {}),
    })),
    blocks: spec.blocks.map((block, index) => ({
      index,
      type: block.type,
      support: workoutBlockSupport(block),
      planned: block,
      ...(block.externalRef === undefined ? {} : { externalRef: block.externalRef }),
      ...(block.type === 'fourByFour' ? { progress: storedPlacement?.progressByBlock.get(index) ?? null } : {}),
    })),
  });
}
