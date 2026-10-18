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
 * section and the screen reader still have every hold). Until every width is
 * known it keeps the reading it drew last for this kind of board (`lastChoice`,
 * `null` for "no line"), so a swipe or a playback frame does not flash another
 * reading; with nothing drawn yet, the one that is safe to clip: every
 * coordinate with Hand shrinking, or bare counts.
 */
export function chooseActiveHoldsLine({
  hasLabels,
  widths,
  available,
  lastChoice,
}: {
  hasLabels: boolean;
  widths: Partial<Record<ActiveHoldsLineKey, number>>;
  available: number | null;
  lastChoice?: ActiveHoldsLineChoice | null;
}): ActiveHoldsLineChoice | null {
  const keys: readonly ActiveHoldsLineKey[] = hasLabels ? COORDINATE_LINE_KEYS : COUNT_LINE_KEYS;
  const measured = available !== null && keys.every((key) => widths[key] !== undefined);
  if (!measured) {
    if (lastChoice === null) return null;
    // Hand may shrink while the new climb's coordinates are unmeasured: if they fit, nothing shrinks.
    if (lastChoice && keys.includes(lastChoice.key)) {
      return lastChoice.key === 'labels' ? { key: 'labels', handShrinks: true } : lastChoice;
    }
    return hasLabels ? { key: 'labels', handShrinks: true } : { key: 'counts', handShrinks: false };
  }
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

/**
 * What a reading's width depends on: the text size, the chip size and its
 * words, with every digit as 0. The line draws digits with tabular figures, so
 * "Start 2" and "Start 9" are the same width, and nearly every climb on a
 * count board reuses one measurement.
 */
export function activeHoldsLineWidthKey(
  fontScale: number,
  chipSize: number,
  key: ActiveHoldsLineKey,
  segments: readonly ActiveHoldsLineSegment[],
): string {
  return [fontScale, chipSize, key, ...segments.map((segment) => segment.text.replace(/[0-9]/g, '0'))].join('|');
}

// What the line has learnt, kept across climbs and across the section folding
// open and shut (which unmounts the line): widths by reading, the room it last
// had, and the reading it last drew on each kind of board.
const LINE_WIDTHS_KEPT = 64;
const lineWidths = new Map<string, number>();
let lastLineRoom: number | null = null;
const lastLineChoices: { coordinates?: ActiveHoldsLineChoice | null; counts?: ActiveHoldsLineChoice | null } = {};

export function rememberedLineWidth(widthKey: string): number | undefined {
  return lineWidths.get(widthKey);
}

/** Stores a measured width; true when it is new, so the line draws again. */
export function rememberLineWidth(widthKey: string, width: number): boolean {
  if (lineWidths.get(widthKey) === width) return false;
  lineWidths.delete(widthKey);
  lineWidths.set(widthKey, width);
  while (lineWidths.size > LINE_WIDTHS_KEPT) {
    const oldest = lineWidths.keys().next().value;
    if (oldest === undefined) break;
    lineWidths.delete(oldest);
  }
  return true;
}

export function rememberedLineRoom(): number | null {
  return lastLineRoom;
}

export function rememberLineRoom(width: number): void {
  lastLineRoom = width;
}

export function rememberedLineChoice(hasLabels: boolean): ActiveHoldsLineChoice | null | undefined {
  return hasLabels ? lastLineChoices.coordinates : lastLineChoices.counts;
}

export function rememberLineChoice(hasLabels: boolean, choice: ActiveHoldsLineChoice | null): void {
  if (hasLabels) lastLineChoices.coordinates = choice;
  else lastLineChoices.counts = choice;
}

export function _resetActiveHoldsLineMemoryForTests(): void {
  lineWidths.clear();
  lastLineRoom = null;
  delete lastLineChoices.coordinates;
  delete lastLineChoices.counts;
}
