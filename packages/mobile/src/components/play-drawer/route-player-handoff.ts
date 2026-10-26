import { useEffect, useSyncExternalStore } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

/**
 * What the full-screen `/play` route tells the drawer host when the window grows
 * into the phone split (an iPhone Duo opened into landscape with the player up).
 * The host closes the route there and the split's pane takes over, so it needs
 * three things from the live route:
 *
 * - whether it is busy (a tick being typed, a sheet or sub-drawer up). A busy
 *   route stays until the climber is done; closing it would throw the work away.
 * - the preview it shows right now, after any swipes (not the climb it was opened
 *   with), so the pane lands on the same climb.
 * - its scroll position, which the focused pane restores. Section expansion needs
 *   no carrying: it is already persisted per section (`useSectionExpanded`).
 *
 * The route registers a reader and publishes its busy flag; the host reads and
 * arms the scroll handoff just before it closes the route; the focused pane takes
 * the handoff once its displayed climb matches. A handoff the pane cannot use
 * within `PLAYER_SCROLL_HANDOFF_TTL_MS` is dropped, so a much later mount
 * (another tab visited for the first time) never jumps to a stale offset.
 */

export type RoutePlayerPreview = {
  item: ClimbQueueItem;
  suggestionSource: PlaylistSuggestionSource | null;
  isWallClimb: boolean;
};

export type RoutePlayerSnapshot = {
  /** The climb on screen, or null before one resolves. */
  climbUuid: string | null;
  offsetY: number;
  /** The live preview, or null when the route shows the queue's current climb. */
  preview: RoutePlayerPreview | null;
};

export type PlayerScrollPosition = { climbUuid: string; offsetY: number };
export type PlayerScrollHandoff = PlayerScrollPosition & { armedAt: number };

/** How long an armed handoff waits for the pane to mount and show its climb. */
export const PLAYER_SCROLL_HANDOFF_TTL_MS = 2000;

/**
 * Who reports the route busy: the player itself (its tick composer, sheets and
 * sub-drawers) and the `/play` route around it (its own queue sheet and the
 * Bluetooth device picker it hosts). Busy while either has something open.
 */
export type RoutePlayerBusySource = 'player' | 'route';

let readRoutePlayer: (() => RoutePlayerSnapshot) | null = null;
const busySources = new Set<RoutePlayerBusySource>();
let routePlayerBusy = false;
let pendingHandoff: PlayerScrollHandoff | null = null;
const busyListeners = new Set<() => void>();
const handoffListeners = new Set<() => void>();

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

function subscribeTo(listeners: Set<() => void>) {
  return (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
}

const subscribeBusy = subscribeTo(busyListeners);
const subscribeHandoff = subscribeTo(handoffListeners);
const getBusy = () => routePlayerBusy;
const getHandoff = () => pendingHandoff;
const subscribeNothing = () => () => {};
const getNotBusy = () => false;

/** The route player offers its live state. Returns the unregister. */
export function registerRoutePlayer(reader: () => RoutePlayerSnapshot): () => void {
  readRoutePlayer = reader;
  return () => {
    if (readRoutePlayer === reader) readRoutePlayer = null;
  };
}

/** The route's current state, or null when no route player is mounted. */
export function readRoutePlayerSnapshot(): RoutePlayerSnapshot | null {
  return readRoutePlayer?.() ?? null;
}

/** One source reports something opening or closing on the route. */
export function publishRoutePlayerBusy(source: RoutePlayerBusySource, busy: boolean): void {
  if (busy) busySources.add(source);
  else busySources.delete(source);
  const next = busySources.size > 0;
  if (next === routePlayerBusy) return;
  routePlayerBusy = next;
  notify(busyListeners);
}

/** Report `busy` for `source` while mounted; idle again on unmount. */
export function useReportRoutePlayerBusy(source: RoutePlayerBusySource, busy: boolean, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    publishRoutePlayerBusy(source, busy);
    return () => publishRoutePlayerBusy(source, false);
  }, [source, busy, enabled]);
}

/**
 * True while the route player has work open that a close would lose. Only
 * subscribes while `enabled` (the drawer host passes "a split close is
 * waiting"), so no other device re-renders on every sheet the player opens.
 */
export function useRoutePlayerBusy(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribeBusy : subscribeNothing,
    enabled ? getBusy : getNotBusy,
    enabled ? getBusy : getNotBusy,
  );
}

/** Hand this position to the pane. A player at the top arms nothing. */
export function armPlayerScrollHandoff(position: PlayerScrollPosition | null, now: number = Date.now()): void {
  pendingHandoff = position && position.offsetY > 0 ? { ...position, armedAt: now } : null;
  notify(handoffListeners);
}

/** The offset for this climb, once; null when nothing fresh was armed for it. */
export function takePlayerScrollHandoff(climbUuid: string, now: number = Date.now()): number | null {
  const handoff = pendingHandoff;
  if (!handoff) return null;
  if (now - handoff.armedAt > PLAYER_SCROLL_HANDOFF_TTL_MS) {
    pendingHandoff = null;
    notify(handoffListeners);
    return null;
  }
  if (handoff.climbUuid !== climbUuid) return null;
  pendingHandoff = null;
  notify(handoffListeners);
  return handoff.offsetY;
}

export function usePendingPlayerScrollHandoff(): PlayerScrollHandoff | null {
  return useSyncExternalStore(subscribeHandoff, getHandoff, getHandoff);
}

/** Test-only: back to the launch state. */
export function resetRoutePlayerHandoffForTests(): void {
  readRoutePlayer = null;
  busySources.clear();
  routePlayerBusy = false;
  pendingHandoff = null;
  busyListeners.clear();
  handoffListeners.clear();
}
