import type { ActiveHoldRole, ActiveHoldsGroup } from '@boardsesh/play-view';

/** One role's part of the collapsed line: what follows its marker. */
export type ActiveHoldsLineSegment = { role: ActiveHoldRole; text: string };

/**
 * The ways the collapsed line can read, richest first: every coordinate
 * (`labels`); the same with Hand cut to its first coordinate (`handFirst`, only
 * measured, to know how short Hand may get); Hand as a count (`handCount`).
 */
export const ACTIVE_HOLDS_LINE_KEYS = ['labels', 'handFirst', 'handCount'] as const;
export type ActiveHoldsLineKey = (typeof ACTIVE_HOLDS_LINE_KEYS)[number];

/** What the line draws: which reading, and whether Hand may be cut short with an ellipsis to fit. */
export type ActiveHoldsLineChoice = { key: ActiveHoldsLineKey; handShrinks: boolean };

type LineGroup = Pick<ActiveHoldsGroup, 'role' | 'count' | 'labels'>;

/** Every reading of the line for these MoonBoard groups. */
export function activeHoldsLineCandidates(
  groups: readonly LineGroup[],
): Record<ActiveHoldsLineKey, ActiveHoldsLineSegment[]> {
  const segment = (pick: (group: LineGroup) => string) =>
    groups.map((group) => ({ role: group.role, text: pick(group) }));
  const allLabels = (group: LineGroup) => group.labels?.join(' ') ?? '';
  return {
    labels: segment(allLabels),
    handFirst: segment((group) =>
      group.role === 'HAND' && group.labels && group.labels.length > 1 ? `${group.labels[0]}…` : allLabels(group),
    ),
    handCount: segment((group) => (group.role === 'HAND' ? String(group.count) : allLabels(group))),
  };
}

// Measured widths come from layout and can disagree with the slot by a fraction of a point.
const FIT_TOLERANCE = 0.5;

/**
 * The richest reading that fits the room the header leaves, from each reading's
 * measured width. Start and Finish are never cut: only Hand shrinks, and only
 * as far as its first coordinate. When even that does not fit, Hand becomes a
 * count, and when that does not fit either, there is no line (the section's
 * title stands in; the expanded section and the screen reader still have every
 * hold). Until every width is known it keeps the reading it drew last
 * (`lastChoice`, `null` for "no line"), so a swipe or a playback frame does not
 * flash another reading; with nothing drawn yet, every coordinate with Hand
 * shrinking, which is safe to clip.
 */
export function chooseActiveHoldsLine({
  widths,
  available,
  lastChoice,
}: {
  widths: Partial<Record<ActiveHoldsLineKey, number>>;
  available: number | null;
  lastChoice?: ActiveHoldsLineChoice | null;
}): ActiveHoldsLineChoice | null {
  const measured = available !== null && ACTIVE_HOLDS_LINE_KEYS.every((key) => widths[key] !== undefined);
  if (!measured) {
    if (lastChoice === null) return null;
    // Hand may shrink while the new climb's coordinates are unmeasured: if they fit, nothing shrinks.
    if (lastChoice && lastChoice.key !== 'labels') return lastChoice;
    return { key: 'labels', handShrinks: true };
  }
  const fits = (key: ActiveHoldsLineKey) => (widths[key] ?? Infinity) <= available + FIT_TOLERANCE;
  if (fits('labels')) return { key: 'labels', handShrinks: false };
  if (fits('handFirst')) return { key: 'labels', handShrinks: true };
  if (fits('handCount')) return { key: 'handCount', handShrinks: false };
  return null;
}

/**
 * What a reading's width depends on: the text size, the chip size and its
 * words, with every digit as 0. The line draws digits with tabular figures, so
 * "F8" and "F9" are the same width and a climb with the same letters reuses a
 * measurement.
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
// had, and the reading it last drew (`undefined` before it has drawn one).
const LINE_WIDTHS_KEPT = 64;
const lineWidths = new Map<string, number>();
let lastLineRoom: number | null = null;
let lastLineChoice: ActiveHoldsLineChoice | null | undefined;

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

export function rememberedLineChoice(): ActiveHoldsLineChoice | null | undefined {
  return lastLineChoice;
}

export function rememberLineChoice(choice: ActiveHoldsLineChoice | null): void {
  lastLineChoice = choice;
}

export function _resetActiveHoldsLineMemoryForTests(): void {
  lineWidths.clear();
  lastLineRoom = null;
  lastLineChoice = undefined;
}
