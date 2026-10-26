import { useSyncExternalStore } from 'react';

/**
 * Carries the full-screen player's scroll position into the persistent pane when
 * the window grows into the phone split (an iPhone Duo opened into landscape
 * with the player up). The drawer host closes the `/play` route there and the
 * pane takes over; without this the climber's place in the logbook or beta
 * would jump back to the board. Section expansion needs no carrying: it is
 * already persisted per section (`useSectionExpanded`).
 *
 * The route registers a reader for its live offset; the host arms a handoff
 * from it just before it closes the route; the focused pane takes it once its
 * displayed climb matches. A handoff the pane cannot use within
 * `PLAYER_SCROLL_HANDOFF_TTL_MS` is dropped, so a much later mount (another tab
 * visited for the first time) never jumps to a stale offset.
 */

export type PlayerScrollPosition = { climbUuid: string; offsetY: number };
export type PlayerScrollHandoff = PlayerScrollPosition & { armedAt: number };

/** How long an armed handoff waits for the pane to mount and show its climb. */
export const PLAYER_SCROLL_HANDOFF_TTL_MS = 2000;

let readRoutePosition: (() => PlayerScrollPosition | null) | null = null;
let pendingHandoff: PlayerScrollHandoff | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PlayerScrollHandoff | null {
  return pendingHandoff;
}

/** The route player offers its live position. Returns the unregister. */
export function registerRoutePlayerScroll(reader: () => PlayerScrollPosition | null): () => void {
  readRoutePosition = reader;
  return () => {
    if (readRoutePosition === reader) readRoutePosition = null;
  };
}

/** Snapshot the route player's position for the pane. A player at the top arms nothing. */
export function armPlayerScrollHandoff(now: number = Date.now()): void {
  const position = readRoutePosition?.() ?? null;
  pendingHandoff = position && position.offsetY > 0 ? { ...position, armedAt: now } : null;
  notify();
}

/** The offset for this climb, once; null when nothing fresh was armed for it. */
export function takePlayerScrollHandoff(climbUuid: string, now: number = Date.now()): number | null {
  const handoff = pendingHandoff;
  if (!handoff) return null;
  if (now - handoff.armedAt > PLAYER_SCROLL_HANDOFF_TTL_MS) {
    pendingHandoff = null;
    notify();
    return null;
  }
  if (handoff.climbUuid !== climbUuid) return null;
  pendingHandoff = null;
  notify();
  return handoff.offsetY;
}

export function usePendingPlayerScrollHandoff(): PlayerScrollHandoff | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: back to the launch state. */
export function resetPlayerScrollHandoffForTests(): void {
  readRoutePosition = null;
  pendingHandoff = null;
  listeners.clear();
}
