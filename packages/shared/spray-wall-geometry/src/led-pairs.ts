import { generateLedPositions, type LedPosition } from './led-layout';
import type { TnutLayout } from './tnut-layout';

/**
 * Two LEDs that sit behind one hold and act as one unit (#7355 item 8): they
 * move together, the cable runs through both, and the editors draw them as
 * interlocking rings. `ledGroups` on a layout lists them; an empty list means
 * every pair was separated on purpose. With no list, a "sides" placement pairs
 * the two LEDs it put behind each hole.
 */
export type SprayLedPair = readonly [string, string];

const holeKey = (point: { x: number; y: number }) => `${point.x}:${point.y}`;

/** Reject malformed pairs; drop pairs whose LEDs are gone and later pairs that reuse an LED. */
export function readLedPairs(candidate: unknown, ledPositions: readonly LedPosition[]): SprayLedPair[] | null {
  if (!Array.isArray(candidate) || candidate.length > ledPositions.length) return null;
  const known = new Set(ledPositions.map((led) => led.id));
  const used = new Set<string>();
  const pairs: SprayLedPair[] = [];
  for (const entry of candidate) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string' ||
      entry[0] === entry[1]
    )
      return null;
    const [first, second] = entry as [string, string];
    if (!known.has(first) || !known.has(second) || used.has(first) || used.has(second)) continue;
    used.add(first);
    used.add(second);
    pairs.push([first, second]);
  }
  return pairs;
}

/** The pairs a layout has now: its saved list, or a "sides" placement's default pairs. */
export function ledPairs(layout: TnutLayout): SprayLedPair[] {
  const leds = layout.ledPositions ?? [];
  if (layout.ledGroups) return readLedPairs(layout.ledGroups, leds) ?? [];
  if (layout.ledPlacement !== 'sides') return [];
  const generatedHoles = new Map(generateLedPositions(layout).map((led) => [led.id, led.hole]));
  const byHole = new Map<string, string[]>();
  for (const led of leds) {
    const hole = led.hole ?? generatedHoles.get(led.id);
    if (!hole) continue;
    const key = holeKey(hole);
    byHole.set(key, [...(byHole.get(key) ?? []), led.id]);
  }
  return [...byHole.values()].filter((ids) => ids.length === 2).map(([first, second]) => [first, second] as const);
}

/** The other LED of `id`'s pair, if it has one. */
export function ledPartner(pairs: readonly SprayLedPair[], id: string): string | null {
  for (const [first, second] of pairs) {
    if (first === id) return second;
    if (second === id) return first;
  }
  return null;
}

/** Split `id`'s pair, so each LED can be moved or deleted on its own. */
export function separateLedPair(layout: TnutLayout, id: string): TnutLayout {
  return { ...layout, ledGroups: ledPairs(layout).filter(([first, second]) => first !== id && second !== id) };
}

/** Make two LEDs one unit, taking each out of any pair it was in. */
export function groupLedPair(layout: TnutLayout, first: string, second: string): TnutLayout {
  if (first === second) return layout;
  const others = ledPairs(layout).filter(([a, b]) => ![first, second].includes(a) && ![first, second].includes(b));
  return { ...layout, ledGroups: [...others, [first, second]] };
}

/** Cable ids with each paired LED followed by its partner, unless the partner is already there or wired. */
export function withLedPartners(ids: readonly string[], pairs: readonly SprayLedPair[], wired: ReadonlySet<string>) {
  const result: string[] = [];
  for (const id of ids) {
    if (!result.includes(id)) result.push(id);
    const partner = ledPartner(pairs, id);
    if (partner && !result.includes(partner) && !wired.has(partner)) result.push(partner);
  }
  return result;
}
