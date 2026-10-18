import type { ActiveHoldRole, ActiveHoldsGroup } from '@boardsesh/play-view';

/** One role's part of the collapsed line: what follows its marker. */
export type ActiveHoldsLineSegment = { role: ActiveHoldRole; text: string };

/**
 * The ways the collapsed line can read, richest first.
 * - Boards with wall coordinates: every coordinate (`labels`); the same with
 *   Hand cut to its first coordinate (`handFirst`, only measured, to know how
 *   short Hand may get); Hand as a count (`handCount`).
 * - Boards with counts: role words (`words`, "Start 2"); bare counts (`counts`).
 */
export type ActiveHoldsLineKey = 'labels' | 'handFirst' | 'handCount' | 'words' | 'counts';

export const COORDINATE_LINE_KEYS = [
  'labels',
  'handFirst',
  'handCount',
] as const satisfies readonly ActiveHoldsLineKey[];
export const COUNT_LINE_KEYS = ['words', 'counts'] as const satisfies readonly ActiveHoldsLineKey[];

/** What the line draws: which reading, and whether Hand may be cut short with an ellipsis to fit. */
export type ActiveHoldsLineChoice = { key: ActiveHoldsLineKey; handShrinks: boolean };

type LineGroup = Pick<ActiveHoldsGroup, 'role' | 'count' | 'labels'>;

/** Every reading of the line for these groups. `countWords` turns a group into "Start 2". */
export function activeHoldsLineCandidates(
  groups: readonly LineGroup[],
  countWords: (group: LineGroup) => string,
): Record<ActiveHoldsLineKey, ActiveHoldsLineSegment[]> {
  const segment = (pick: (group: LineGroup) => string) =>
    groups.map((group) => ({ role: group.role, text: pick(group) }));
  const allLabels = (group: LineGroup) => group.labels?.join(' ') ?? String(group.count);
  return {
    labels: segment(allLabels),
    handFirst: segment((group) =>
      group.role === 'HAND' && group.labels && group.labels.length > 1 ? `${group.labels[0]}…` : allLabels(group),
    ),
    handCount: segment((group) => (group.role === 'HAND' ? String(group.count) : allLabels(group))),
    words: segment(countWords),
    counts: segment((group) => String(group.count)),
  };
}

// Measured widths come from layout and can disagree with the slot by a fraction of a point.
const FIT_TOLERANCE = 0.5;

/**
 * The richest reading that fits the room the header leaves, from each reading's
 * measured width. Start and Finish are never cut: only Hand shrinks, and only
 * as far as its first coordinate. When even that does not fit, Hand becomes a
 * count, and when that does not fit either, there is no line (the expanded
 * section and the screen reader still have every hold). Before anything is
 * measured, it draws the reading that is safe to clip: every coordinate with
 * Hand shrinking, or bare counts.
 */
export function chooseActiveHoldsLine({
  hasLabels,
  widths,
  available,
}: {
  hasLabels: boolean;
  widths: Partial<Record<ActiveHoldsLineKey, number>>;
  available: number | null;
}): ActiveHoldsLineChoice | null {
  const keys: readonly ActiveHoldsLineKey[] = hasLabels ? COORDINATE_LINE_KEYS : COUNT_LINE_KEYS;
  const measured = available !== null && keys.every((key) => widths[key] !== undefined);
  if (!measured) return hasLabels ? { key: 'labels', handShrinks: true } : { key: 'counts', handShrinks: false };
  const fits = (key: ActiveHoldsLineKey) => (widths[key] ?? Infinity) <= available + FIT_TOLERANCE;
  if (hasLabels) {
    if (fits('labels')) return { key: 'labels', handShrinks: false };
    if (fits('handFirst')) return { key: 'labels', handShrinks: true };
    if (fits('handCount')) return { key: 'handCount', handShrinks: false };
    return null;
  }
  if (fits('words')) return { key: 'words', handShrinks: false };
  if (fits('counts')) return { key: 'counts', handShrinks: false };
  return null;
}
