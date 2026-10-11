import { groupSlotsBySection, type PlannedClimbSlot } from '@boardsesh/playlist-generator';
import type { PreviewItem } from './workout-preview-pool';

export type PreviewSection = PlannedClimbSlot['section'];

/** One FlashList row of the workout preview: a section heading or a climb. */
export type PreviewListRow =
  | { kind: 'section'; key: string; section: PreviewSection; count: number }
  | { kind: 'climb'; key: string; preview: PreviewItem };

/**
 * Interleave section headings ("Warm-up · 4 climbs") with the preview's climbs,
 * so the list reads in the order the session will run it. A plan with a single
 * section (a volume set without a warm-up) gets no heading: one label over the
 * whole list says nothing the workout picker above it doesn't.
 *
 * Sections are consecutive runs (`groupSlotsBySection`), so a pyramid's
 * "increasing" and "decreasing" halves stay apart around the peak.
 */
export function buildPreviewListRows(items: readonly PreviewItem[]): PreviewListRow[] {
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
        key: `section-${groupIndex}-${group.section}`,
        section: group.section,
        count: groupItems.length,
      });
    }
    for (const preview of groupItems) rows.push({ kind: 'climb', key: preview.item.uuid, preview });
  });
  return rows;
}
