// The climbs a partner app's workout queues (#5399). Its blocks fill through the
// app's own preview pipeline (`buildPreview`): the same pools, the same nearby
// grades for a grade that runs short (#6759), the same top-ups taken last and
// the same climbs passed over while the session's queue already holds them. The
// card only shows the counts and hands the result to Start or "Add to this session".

import type { CreateWorkout } from '@boardsesh/public-api';
import {
  buildWorkoutRun,
  type GeneratorGradeScale,
  type WorkoutPlan,
  type WorkoutRun,
  type WorkoutStagePacing,
} from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { PartnerSlot } from './partner-workout-plan';
import { MAX_SESSION_WORKOUT_ITEMS } from '@boardsesh/workout-summary';
import {
  buildPreview,
  selectItemsFromPools,
  type BuiltPreview,
  type FetchGradePool,
  type PreviewFetchContext,
  type PreviewItem,
} from '../components/session-screen/pre-session/workout-preview-pool';

export type PartnerWorkoutPreview = {
  /** The queue items the workout adds, in plan order. */
  items: ClimbQueueItem[];
  /** Which partner block each item belongs to, with the partner's rests. */
  run: WorkoutRun;
  /** How many slots the climbs were picked for: the plan, capped at what a session workout can hold. */
  selectionSlots: number;
  /** The slots and pools behind the rows, for `reselectPartnerWorkoutPreview`. */
  slots: readonly PartnerSlot[];
  built: BuiltPreview;
};

type PartnerPlan = { plan: WorkoutPlan; slots: readonly PartnerSlot[] };

/**
 * The pacing a partner block's `restSeconds` gives its stage (workoutbash1 D4).
 * Volume, pyramid, ladder and grade focus can ask for a rest the app's own
 * builder does not offer yet. As on limit bouldering, a fall starts that rest
 * and keeps the climb up; only a flash or a send moves the wall on once it runs
 * out. A rest of 0 (or none) leaves the stage unpaced, so the climber's own
 * rest-timer settings apply instead of a 10 s changeover after every tick.
 */
function partnerBlockPacing(block: CreateWorkout['blocks'][number] | undefined): WorkoutStagePacing | undefined {
  if (!block || !('restSeconds' in block) || !block.restSeconds) return undefined;
  return { mode: 'afterTick', restSeconds: block.restSeconds, advanceOn: 'send' };
}

/** The run for `rows`, each stage paced by its partner block's rest. */
function partnerRunFor(rows: readonly PreviewItem[], spec: CreateWorkout, plan: WorkoutPlan): WorkoutRun {
  const run = buildWorkoutRun(
    rows.map((row) => ({ uuid: row.item.uuid, stageId: row.slot.stageId! })),
    plan,
  );
  for (const stage of run.stages) {
    const pacing = partnerBlockPacing(spec.blocks[Number(stage.id.split(':').at(-1))]);
    if (pacing) stage.pacing = pacing;
  }
  return run;
}

function toPartnerPreview(
  slots: readonly PartnerSlot[],
  built: BuiltPreview,
  spec: CreateWorkout,
  plan: WorkoutPlan,
): PartnerWorkoutPreview {
  return {
    items: built.items.map((row) => row.item),
    run: partnerRunFor(built.items, spec, plan),
    selectionSlots: slots.length,
    slots,
    built,
  };
}

/**
 * Fills a partner workout's planned slots (`buildPartnerWorkoutPlan`) on the
 * board in `ctx`. `getAvoidedClimbUuids` names the climbs to pass over: the live
 * queue when the workout is added to a running session.
 */
export async function buildPartnerWorkoutPreview({
  spec,
  partnerPlan,
  grades,
  ctx,
  fetchPool,
  getAvoidedClimbUuids,
}: {
  spec: CreateWorkout;
  partnerPlan: PartnerPlan;
  grades: GeneratorGradeScale;
  ctx: PreviewFetchContext;
  fetchPool: FetchGradePool;
  getAvoidedClimbUuids?: () => ReadonlySet<string>;
}): Promise<PartnerWorkoutPreview> {
  const slots = partnerPlan.slots.slice(0, MAX_SESSION_WORKOUT_ITEMS);
  const built = await buildPreview(slots, ctx, fetchPool, grades, { getAvoidedClimbUuids });
  return toPartnerPreview(slots, built, spec, partnerPlan.plan);
}

/**
 * The preview again, from the pools it already fetched, passing over
 * `avoidClimbUuids`: the queue as it is when the climber adds the workout. It
 * re-picks every row whose climb is in the queue now, where the pools have
 * another; a row whose climb is not keeps its queue item. No request goes out.
 * A crewmate's add that reaches the server between this read and the append
 * can still double a climb: the same race "Add a block" has
 * (`docs/workout-stages.md`).
 */
export function reselectPartnerWorkoutPreview(
  preview: PartnerWorkoutPreview,
  spec: CreateWorkout,
  plan: WorkoutPlan,
  avoidClimbUuids: ReadonlySet<string>,
): PartnerWorkoutPreview {
  const { slots, built } = preview;
  const rowBySlotIndex = new Map(built.items.map((row) => [row.slot.index, row.item]));
  const keptItems = slots.map((slot) => rowBySlotIndex.get(slot.index));
  const { items, usedUuids } = selectItemsFromPools(
    slots,
    built.pools,
    avoidClimbUuids,
    keptItems,
    built.poolTopUpTiers,
    built.borrowScale,
  );
  return toPartnerPreview(slots, { ...built, items, usedUuids }, spec, plan);
}
