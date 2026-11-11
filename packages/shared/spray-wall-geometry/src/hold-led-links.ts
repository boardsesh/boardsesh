import type { LedPosition } from './led-layout';
import type { TnutLayout } from './tnut-layout';

/**
 * A hold whose LEDs the climber chose by hand. It replaces the automatic,
 * geometry-based assignment for that hold; an empty list means "no LED".
 * Hold ids belong to the wall version the layout was made for.
 */
export type SprayHoldLedLink = { holdId: number; ledIds: string[] };

/** A wall has at most 1500 holds (MAX_HOLDS_PER_WALL on the server). */
export const MAX_HOLD_LED_LINKS = 1500;
/** More LEDs than any one hold needs, yet bounded. */
export const MAX_LEDS_PER_HOLD_LINK = 64;

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

/**
 * Read stored links without trusting them. Structural garbage rejects the whole
 * layout (null); stale LED ids (an LED since removed) and repeated holds are
 * dropped, so an edited layout never fails to load over an old link.
 */
export function readHoldLedLinks(candidate: unknown, ledPositions: readonly LedPosition[]): SprayHoldLedLink[] | null {
  if (!Array.isArray(candidate) || candidate.length > MAX_HOLD_LED_LINKS) return null;
  const known = new Set(ledPositions.map((led) => led.id));
  const byHold = new Map<number, string[]>();
  for (const link of candidate) {
    if (
      !isRecord(link) ||
      typeof link.holdId !== 'number' ||
      !Number.isSafeInteger(link.holdId) ||
      !Array.isArray(link.ledIds) ||
      link.ledIds.length > MAX_LEDS_PER_HOLD_LINK ||
      !link.ledIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)
    ) {
      return null;
    }
    byHold.set(link.holdId, [...new Set((link.ledIds as string[]).filter((id) => known.has(id)))]);
  }
  return [...byHold].map(([holdId, ledIds]) => ({ holdId, ledIds }));
}

/** Link a hold to exactly these LEDs, replacing any automatic or earlier manual choice. */
export function setHoldLedLink(layout: TnutLayout, holdId: number, ledIds: readonly string[]): TnutLayout {
  const unique = [...new Set(ledIds)].slice(0, MAX_LEDS_PER_HOLD_LINK);
  const others = (layout.holdLeds ?? []).filter((link) => link.holdId !== holdId);
  return { ...layout, holdLeds: [...others, { holdId, ledIds: unique }] };
}

/** Give a hold back to the automatic assignment. */
export function clearHoldLedLink(layout: TnutLayout, holdId: number): TnutLayout {
  const remaining = (layout.holdLeds ?? []).filter((link) => link.holdId !== holdId);
  const { holdLeds: _removed, ...rest } = layout;
  return remaining.length ? { ...rest, holdLeds: remaining } : rest;
}
