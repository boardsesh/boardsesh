import {
  groupSlotsBySection,
  isWarmUpStage,
  type PlannedClimbSlot,
  type WorkoutStage,
  type WorkoutStageKind,
} from '@boardsesh/playlist-generator';
import type { PreviewItem } from './workout-preview-pool';

export type PreviewSection = PlannedClimbSlot['section'];

/** One FlashList row of the workout preview: a stage heading, a section heading or a climb. */
export type PreviewListRow =
  | { kind: 'stage'; key: string; stageKind: WorkoutStageKind; count: number }
  | { kind: 'section'; key: string; section: PreviewSection; count: number }
  | { kind: 'climb'; key: string; preview: PreviewItem };

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
 * pyramid still shows its way up and down and a volume block shows none.
 *
 * Sections are consecutive runs (`groupSlotsBySection`), so a pyramid's
 * "increasing" and "decreasing" halves stay apart around the peak.
 */
export function buildPreviewListRows(
  items: readonly PreviewItem[],
  stages: readonly WorkoutStage[] = [],
): PreviewListRow[] {
  const workoutBlockCount = stages.filter((stage) => !isWarmUpStage(stage)).length;
  if (workoutBlockCount < 2) return buildSectionRows(items, 'section');

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
    if (stageKind !== undefined) {
      rows.push({ kind: 'stage', key: `stage-${stageId}`, stageKind, count: stageItems.length });
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
