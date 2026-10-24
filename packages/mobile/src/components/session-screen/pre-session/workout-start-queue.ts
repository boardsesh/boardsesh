// What Start, and "Add to session" mid-session, queue from a workout preview
// (#5380). The preview shows one row per planned slot; the queue gets every row
// once, in plan order, except in a stage with rounds (a 4x4), whose rows repeat
// round-major: A B C D, A B C D, and so on. Round 1 keeps the rows' own queue
// items, and every later round gets a copy under a fresh queue-item uuid, so the
// run can store each copy's round. Pure, so the hook, the preview's summary line
// and the tests all count the same queue.

import {
  buildWorkoutRun,
  estimateWorkoutMinutes,
  expandRounds,
  isWarmUpStage,
  roundsForOptions,
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
  /** The planned slot each queued climb fills, by queue-item uuid. A round's copies share their row's slot. */
  slotIndexByUuid: ReadonlyMap<string, number>;
  /**
   * Planned slots with a queued climb, each counted once however many rounds
   * it runs: the `SessionQueueGenerated.failedCount` delta.
   */
  filledSlotCount: number;
};

export const EMPTY_STAGED_QUEUE_ITEMS: StagedQueueItems = {
  items: [],
  run: null,
  slotIndexByUuid: new Map(),
  filledSlotCount: 0,
};

/** What the preview's summary line says Start queues. */
export type StartQueueSummary = {
  /** Queued climbs, a 4x4's round copies included. */
  climbCount: number;
  /** About how long the workout takes. Null for an untimed workout (`estimateWorkoutMinutes`). */
  estimatedMinutes: number | null;
};

export const EMPTY_START_QUEUE_SUMMARY: StartQueueSummary = { climbCount: 0, estimatedMinutes: null };

/** The rounds a planned stage queues its rows for: a 4x4's. Undefined for a stage that queues each row once. */
export function plannedStageRounds(stage: WorkoutStage): number | undefined {
  return isWarmUpStage(stage) ? undefined : roundsForOptions(stage.options);
}

/** How many planned slots the queue items `uuids` fill, each slot once. */
export function countFilledSlots(slotIndexByUuid: ReadonlyMap<string, number>, uuids: Iterable<string>): number {
  const filledSlots = new Set<number>();
  for (const uuid of uuids) {
    const slotIndex = slotIndexByUuid.get(uuid);
    if (slotIndex !== undefined) filledSlots.add(slotIndex);
  }
  return filledSlots.size;
}

/**
 * The staged climbs minus every slot that already has a climb in the queue
 * (`queuedUuids`). Only round 1 keeps the preview row's uuid, and each hand-over
 * mints fresh copies, so a uuid match finds round 1 alone: dropping the whole
 * slot keeps a second add of the same 4x4 from queueing rounds 2 onward again.
 */
export function withoutQueuedSlots(
  items: readonly ClimbQueueItem[],
  slotIndexByUuid: ReadonlyMap<string, number>,
  queuedUuids: ReadonlySet<string>,
): ClimbQueueItem[] {
  const queuedSlots = new Set<number>();
  for (const { uuid } of items) {
    const slotIndex = queuedUuids.has(uuid) ? slotIndexByUuid.get(uuid) : undefined;
    if (slotIndex !== undefined) queuedSlots.add(slotIndex);
  }
  return items.filter(({ uuid }) => {
    if (queuedUuids.has(uuid)) return false;
    const slotIndex = slotIndexByUuid.get(uuid);
    return slotIndex === undefined || !queuedSlots.has(slotIndex);
  });
}

type QueuedRow = {
  /** The queue item's uuid, for `expandRounds`. */
  uuid: string;
  item: ClimbQueueItem;
  slotIndex: number;
  stageId: string | undefined;
  round?: number;
};

/**
 * The preview as the queue it starts, plus the run that says which stage, and
 * which round, every queued climb belongs to. Rows come in plan order, so each
 * stage is one consecutive run of them. The queue's size cap
 * (`MAX_SYNCED_QUEUE_ITEMS`) applies after the rounds are expanded, and a climb
 * it cuts gets no stage. A row whose stage is unknown is queued with no stage.
 * `mintUuid` names every round copy past round 1.
 */
export function stagePreviewQueue({
  previews,
  plan,
  stageIdOf,
  mintUuid,
}: {
  previews: readonly PreviewItem[];
  plan: WorkoutPlan;
  stageIdOf: (preview: PreviewItem) => string | undefined;
  mintUuid: () => string;
}): StagedQueueItems {
  const roundsByStageId = new Map<string, number>();
  for (const stage of plan.stages) {
    const rounds = plannedStageRounds(stage);
    if (rounds !== undefined) roundsByStageId.set(stage.id, rounds);
  }
  const copyForRound = (row: QueuedRow): QueuedRow => {
    const uuid = mintUuid();
    return { ...row, uuid, item: { ...row.item, uuid } };
  };

  const queued: QueuedRow[] = [];
  let groupStart = 0;
  while (groupStart < previews.length) {
    const stageId = stageIdOf(previews[groupStart]);
    let groupEnd = groupStart + 1;
    while (groupEnd < previews.length && stageIdOf(previews[groupEnd]) === stageId) groupEnd++;
    const rows = previews.slice(groupStart, groupEnd).map((preview): QueuedRow => ({
      uuid: preview.item.uuid,
      item: preview.item,
      slotIndex: preview.slot.index,
      stageId,
    }));
    const rounds = stageId === undefined ? undefined : roundsByStageId.get(stageId);
    if (rounds === undefined) {
      queued.push(...rows);
    } else {
      for (const { item: row, round } of expandRounds(rows, rounds, copyForRound)) queued.push({ ...row, round });
    }
    groupStart = groupEnd;
  }

  const kept = queued.slice(0, MAX_SYNCED_QUEUE_ITEMS);
  if (kept.length === 0) return EMPTY_STAGED_QUEUE_ITEMS;
  const entries: WorkoutRunEntry[] = [];
  for (const { item, stageId, round } of kept) {
    if (stageId === undefined) continue;
    entries.push(round === undefined ? { uuid: item.uuid, stageId } : { uuid: item.uuid, stageId, round });
  }
  const slotIndexByUuid = new Map(kept.map(({ item, slotIndex }) => [item.uuid, slotIndex]));
  return {
    items: kept.map(({ item }) => item),
    run: buildWorkoutRun(entries, plan),
    slotIndexByUuid,
    filledSlotCount: countFilledSlots(slotIndexByUuid, slotIndexByUuid.keys()),
  };
}

/**
 * The count and time the summary line shows for a preview: the queue Start
 * would hand over, worked out without minting real uuids (the copies only need
 * to be distinct from each other here).
 */
export function summarizeStartQueue(
  previews: readonly PreviewItem[],
  stages: readonly WorkoutStage[],
): StartQueueSummary {
  if (previews.length === 0) return EMPTY_START_QUEUE_SUMMARY;
  let copyCount = 0;
  const { items, run } = stagePreviewQueue({
    previews,
    plan: { stages: [...stages] },
    stageIdOf: (preview) => preview.slot.stageId,
    mintUuid: () => `summary-copy-${copyCount++}`,
  });
  return { climbCount: items.length, estimatedMinutes: run ? estimateWorkoutMinutes(run) : null };
}
