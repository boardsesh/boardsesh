// What Start, and "Add to session" mid-session, queue from a workout preview
// (#5380). The preview shows one row per planned slot, and the queue gets every
// row once, in plan order, under the row's own queue item. A 4x4 is no
// exception: each row is one set, one climb the climber does for every rep, so
// its reps are ticks on that one queue item, never copies of it. Pure, so the
// hook, the preview's summary line and the tests all count the same queue.

import {
  buildWorkoutRun,
  estimateWorkoutMinutes,
  type WorkoutPlan,
  type WorkoutRun,
  type WorkoutRunEntry,
  type WorkoutStage,
} from '@boardsesh/playlist-generator';
import { MAX_SYNCED_QUEUE_ITEMS, type ClimbQueueItem } from '@boardsesh/queue';
import type { PreviewItem } from './workout-preview-pool';

export type StagedQueueItems = {
  items: ClimbQueueItem[];
  /** Null when there is nothing to queue. */
  run: WorkoutRun | null;
};

export const EMPTY_STAGED_QUEUE_ITEMS: StagedQueueItems = { items: [], run: null };

/** What the preview's summary line says Start queues. */
export type StartQueueSummary = {
  /** Queued climbs, one per 4x4 set. */
  climbCount: number;
  /** About how long the workout takes. Null for an untimed workout (`estimateWorkoutMinutes`). */
  estimatedMinutes: number | null;
};

export const EMPTY_START_QUEUE_SUMMARY: StartQueueSummary = { climbCount: 0, estimatedMinutes: null };

/**
 * The preview as the queue it starts, plus the run that says which stage every
 * queued climb belongs to. The queue's size cap (`MAX_SYNCED_QUEUE_ITEMS`)
 * applies, and a climb it cuts gets no stage. A row whose stage is unknown is
 * queued with no stage.
 */
export function stagePreviewQueue({
  previews,
  plan,
  stageIdOf,
}: {
  previews: readonly PreviewItem[];
  plan: WorkoutPlan;
  stageIdOf: (preview: PreviewItem) => string | undefined;
}): StagedQueueItems {
  const kept = previews.slice(0, MAX_SYNCED_QUEUE_ITEMS);
  if (kept.length === 0) return EMPTY_STAGED_QUEUE_ITEMS;
  const entries: WorkoutRunEntry[] = [];
  for (const preview of kept) {
    const stageId = stageIdOf(preview);
    if (stageId !== undefined) entries.push({ uuid: preview.item.uuid, stageId });
  }
  return { items: kept.map((preview) => preview.item), run: buildWorkoutRun(entries, plan) };
}

/** The count and time the summary line shows for a preview: the queue Start would hand over. */
export function summarizeStartQueue(
  previews: readonly PreviewItem[],
  stages: readonly WorkoutStage[],
): StartQueueSummary {
  if (previews.length === 0) return EMPTY_START_QUEUE_SUMMARY;
  const { items, run } = stagePreviewQueue({
    previews,
    plan: { stages: [...stages] },
    stageIdOf: (preview) => preview.slot.stageId,
  });
  return { climbCount: items.length, estimatedMinutes: run ? estimateWorkoutMinutes(run) : null };
}
