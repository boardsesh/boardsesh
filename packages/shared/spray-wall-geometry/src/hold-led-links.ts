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

/**
 * Give a hold back to the automatic assignment. The list stays, even empty, so a
 * save says the links were cleared rather than looking like an app without them.
 */
export function clearHoldLedLink(layout: TnutLayout, holdId: number): TnutLayout {
  return { ...layout, holdLeds: (layout.holdLeds ?? []).filter((link) => link.holdId !== holdId) };
}

/**
 * Keep a wall's hand-made links when an app that predates them saves the setup.
 * Such an app sends no `holdLeds` at all; an explicit list, even empty, replaces
 * them. LEDs the incoming layout no longer has are dropped from the links.
 */
export function keepHoldLedLinksFromOlderApp(
  incoming: TnutLayout,
  incomingHadLinks: boolean,
  stored: TnutLayout | null,
): TnutLayout {
  if (incomingHadLinks || !stored?.holdLeds?.length) return incoming;
  const known = new Set((incoming.ledPositions ?? []).map((led) => led.id));
  // "No LED" links stay; a link whose LEDs all left goes back to the automatic mapping.
  const kept = stored.holdLeds
    .map((link) => ({ holdId: link.holdId, ledIds: link.ledIds.filter((id) => known.has(id)) }))
    .filter((link, index) => link.ledIds.length > 0 || stored.holdLeds![index].ledIds.length === 0);
  return kept.length ? { ...incoming, holdLeds: kept } : incoming;
}
