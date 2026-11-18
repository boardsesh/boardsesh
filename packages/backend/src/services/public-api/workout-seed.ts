import { z } from 'zod';
import { CreateWorkoutSchema, WorkoutPlanSchema } from '@boardsesh/public-api';
import { parseSessionWorkoutPlan, type SessionWorkoutPlan } from '@boardsesh/workout-summary';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { normaliseOrphanCurrent } from '@boardsesh/queue';
import { boardSessionQueues, sessionWorkouts, appWorkouts } from '@boardsesh/db/schema';
import { eq } from 'drizzle-orm';
import { ClimbQueueItemSchema } from '../../validation/schemas/climbs';
import type { PartnerDatabase } from '../../auth/partner/tables';
import { AppWorkoutError, canonicalWorkoutPlan, type AppWorkoutRow } from './workouts';

const SeedSchema = z.object({
  queue: z.array(ClimbQueueItemSchema).max(500),
  currentClimbQueueItem: ClimbQueueItemSchema.nullable(),
  historyCount: z.number().int().min(0).max(500).optional(),
  plan: WorkoutPlanSchema,
  sessionPlan: z.unknown(),
});
export type InitialAppWorkoutSeed = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount?: number;
  plan: z.infer<typeof WorkoutPlanSchema>;
  sessionPlan: SessionWorkoutPlan;
};

export function parseAppWorkoutSeed(input: unknown): InitialAppWorkoutSeed {
  if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > 2 * 1024 * 1024)
    throw new AppWorkoutError(422, 'invalid_block', 'The initial workout queue is too large.');
  const parsed = SeedSchema.safeParse(input);
  if (!parsed.success) throw new AppWorkoutError(422, 'invalid_block', 'Invalid initial workout queue.');
  const sessionPlan = parseSessionWorkoutPlan(parsed.data.sessionPlan);
  if (!sessionPlan) throw new AppWorkoutError(422, 'invalid_block', 'Invalid initial workout stages.');
  const allItems = [
    ...parsed.data.queue,
    ...(parsed.data.currentClimbQueueItem ? [parsed.data.currentClimbQueueItem] : []),
  ];
  if (
    new Set(parsed.data.queue.map((item) => item.uuid)).size !== parsed.data.queue.length ||
    new Set(allItems.map((item) => item.uuid)).size > 500
  )
    throw new AppWorkoutError(422, 'invalid_block', 'Queue item identifiers must be unique.');
  const current = parsed.data.currentClimbQueueItem;
  const queuedCurrent = current ? parsed.data.queue.find((item) => item.uuid === current.uuid) : undefined;
  if (
    current &&
    queuedCurrent &&
    (current.climb.uuid !== queuedCurrent.climb.uuid ||
      current.climb.angle !== queuedCurrent.climb.angle ||
      Boolean(current.climb.mirrored) !== Boolean(queuedCurrent.climb.mirrored))
  )
    throw new AppWorkoutError(422, 'invalid_block', 'The current climb must match its queue item.');
  const normalized = normaliseOrphanCurrent(parsed.data);
  return {
    ...parsed.data,
    queue: normalized.queue as ClimbQueueItem[],
    currentClimbQueueItem: normalized.currentClimbQueueItem as ClimbQueueItem | null,
    historyCount: normalized.historyCount,
    sessionPlan,
  };
}

/** New session only: no other queue writer can know this server-generated id before commit. */
export async function persistInitialAppWorkoutSeed(
  transaction: PartnerDatabase,
  workout: AppWorkoutRow,
  sessionId: string,
  seed: InitialAppWorkoutSeed,
): Promise<void> {
  const spec = CreateWorkoutSchema.parse(workout.spec);
  const plan = canonicalWorkoutPlan(spec, seed.plan);
  const byQueueUuid = new Map(
    [...seed.queue, ...(seed.currentClimbQueueItem ? [seed.currentClimbQueueItem] : [])].map((item) => [
      item.uuid,
      item,
    ]),
  );
  const stagesByIndex = new Map<number, string[]>();
  for (const stage of seed.sessionPlan.stages) {
    const prefix = `${workout.id}:`;
    const index = stage.id.startsWith(prefix) ? Number(stage.id.slice(prefix.length)) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= spec.blocks.length || stage.id !== `${prefix}${index}`)
      throw new AppWorkoutError(422, 'invalid_block', 'Stage does not belong to this workout.');
    for (const item of stage.items) {
      const queued = byQueueUuid.get(item.queueItemUuid);
      if (
        !queued ||
        queued.climb.uuid !== item.climbUuid ||
        queued.climb.angle !== item.angle ||
        Boolean(queued.climb.mirrored) !== Boolean(item.isMirror) ||
        seed.queue.findIndex((queuedItem) => queuedItem.uuid === item.queueItemUuid) < (seed.historyCount ?? 0)
      )
        throw new AppWorkoutError(422, 'invalid_block', 'Stage climbs must match the initial queue.');
    }
    stagesByIndex.set(
      index,
      stage.items.map((item) => item.climbUuid),
    );
  }
  const stagedPlan = canonicalWorkoutPlan(
    spec,
    [...stagesByIndex].map(([index, climbUuids]) => ({ index, climbUuids })),
  );
  if (JSON.stringify(plan) !== JSON.stringify(stagedPlan))
    throw new AppWorkoutError(422, 'invalid_block', 'The initial queue and block plan do not match.');
  await transaction.insert(boardSessionQueues).values({
    sessionId,
    queue: seed.queue,
    currentClimbQueueItem: seed.currentClimbQueueItem,
    version: 1,
    sequence: 1,
    initialHistoryCount: seed.historyCount ?? 0,
  });
  await transaction
    .insert(sessionWorkouts)
    .values({ sessionId, userId: workout.userId, plan: seed.sessionPlan, tickMap: [], revision: 0 });
  await transaction.update(appWorkouts).set({ planSnapshot: plan }).where(eq(appWorkouts.id, workout.id));
}
