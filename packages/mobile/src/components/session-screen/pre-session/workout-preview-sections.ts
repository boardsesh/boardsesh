import {
  groupSlotsBySection,
  isWarmUpStage,
  pacingForOptions,
  type PlannedClimbSlot,
  type WorkoutStage,
  type WorkoutStageKind,
} from '@boardsesh/playlist-generator';
import type { PreviewItem } from './workout-preview-pool';

export type PreviewSection = PlannedClimbSlot['section'];

/**
 * One FlashList row of the workout preview: a stage heading, a section heading
 * or a climb. A stage heading's `repsPerSet` is set on a 4x4, whose every row
 * is a set done that many times.
 */
export type PreviewListRow =
  | {
      kind: 'stage';
      key: string;
      stageKind: WorkoutStageKind;
      count: number;
      /** Set only on a warm-up stage planned after the last workout block, which steps back down. */
      isCoolDown?: true;
      /** Set on a 4x4: how many reps each of its climbs (one per set) takes. */
      repsPerSet?: number;
    }
  | { kind: 'section'; key: string; section: PreviewSection; count: number }
  | { kind: 'climb'; key: string; preview: PreviewItem };

/** The reps each climb of a planned 4x4 stage takes, as its pacing runs them. Undefined for every other stage. */
function plannedRepsPerSet(stage: WorkoutStage): number | undefined {
  if (isWarmUpStage(stage)) return undefined;
  const pacing = pacingForOptions(stage.options);
  return pacing?.mode === 'afterTick' ? pacing.sets?.repsPerSet : undefined;
}

/**
 * Interleave headings with the preview's climbs, so the list reads in the order
 * the session will run it.
 *
 * One workout block (with or without a warm-up) gets section headings only
 * ("Warm-up · 4 climbs"), and none at all for a single section (a volume set
 * without a warm-up): one label over the whole list says nothing the workout
 * picker above it doesn't.
 *
 * Two or more blocks get a stage heading over each stage ("Pyramid · 9 climbs"),
 * then that stage's section headings when it has more than one section, so a
 * pyramid still shows its way up and down and a volume block shows none. A
 * warm-up after the last block is headed as the cool-down it plans.
 *
 * Sections are consecutive runs (`groupSlotsBySection`), so a pyramid's
 * "increasing" and "decreasing" halves stay apart around the peak.
 *
 * A 4x4 always gets its heading, alone or not ("4x4 · 4 reps × 4 sets"): each
 * row is one climb, and the heading is where the preview says it is done for
 * every rep of its set.
 */
export function buildPreviewListRows(
  items: readonly PreviewItem[],
  stages: readonly WorkoutStage[] = [],
): PreviewListRow[] {
  const workoutBlockCount = stages.filter((stage) => !isWarmUpStage(stage)).length;
  const repsPerSetByStageId = new Map<string, number>();
  for (const stage of stages) {
    const repsPerSet = plannedRepsPerSet(stage);
    if (repsPerSet !== undefined) repsPerSetByStageId.set(stage.id, repsPerSet);
  }
  if (workoutBlockCount < 2 && repsPerSetByStageId.size === 0) return buildSectionRows(items, 'section');

  const kindByStageId = new Map(stages.map((stage) => [stage.id, stage.kind]));
  const rows: PreviewListRow[] = [];
  // Items are in plan order, so each stage is one consecutive run.
  let groupStart = 0;
  while (groupStart < items.length) {
    const stageId = items[groupStart].slot.stageId;
    let groupEnd = groupStart + 1;
    while (groupEnd < items.length && items[groupEnd].slot.stageId === stageId) groupEnd++;
    const stageItems = items.slice(groupStart, groupEnd);
    const stageKind = stageId === undefined ? undefined : kindByStageId.get(stageId);
    const repsPerSet = stageId === undefined ? undefined : repsPerSetByStageId.get(stageId);
    if (stageKind !== undefined) {
      const stageRow: Extract<PreviewListRow, { kind: 'stage' }> = {
        kind: 'stage',
        key: `stage-${stageId}`,
        stageKind,
        count: stageItems.length,
      };
      if (stageItems[0].slot.section === 'coolDown') stageRow.isCoolDown = true;
      if (repsPerSet !== undefined) stageRow.repsPerSet = repsPerSet;
      rows.push(stageRow);
    }
    rows.push(...buildSectionRows(stageItems, `section-${stageId ?? groupStart}`));
    groupStart = groupEnd;
  }
  return rows;
}

/** Section headings plus climbs for one run of items. A lone section gets no heading. */
function buildSectionRows(items: readonly PreviewItem[], keyPrefix: string): PreviewListRow[] {
  const groups = groupSlotsBySection(items.map((preview) => preview.slot));
  const showHeadings = groups.length > 1;
  const rows: PreviewListRow[] = [];
  let offset = 0;
  groups.forEach((group, groupIndex) => {
    const groupItems = items.slice(offset, offset + group.slots.length);
    offset += group.slots.length;
    if (showHeadings) {
      rows.push({
        kind: 'section',
        key: `${keyPrefix}-${groupIndex}-${group.section}`,
        section: group.section,
        count: groupItems.length,
      });
    }
    for (const preview of groupItems) rows.push({ kind: 'climb', key: preview.item.uuid, preview });
  });
  return rows;
}
