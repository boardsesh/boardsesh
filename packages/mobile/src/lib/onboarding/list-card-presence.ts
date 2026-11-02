// Which of the Climbs list's one-shot cards is on screen right now, for the
// player's preview-first card to wait on (one card at a time, the
// `quick-actions-tip.ts` rule): the first-connect card, the board-reveal tip and
// the quick-actions tip.
//
// On a phone the player covers the list, and the list loses focus while it is
// up, so it publishes nothing then. Beside a tablet's player pane (or the open
// iPhone Duo) both are on screen at once, which is where the wait matters.
//
// The list publishes rather than the player asking each card's own store, so
// the player's module graph stays free of the cards and what they import.

import { useSyncExternalStore } from 'react';

export type ListCard = 'firstConnect' | 'boardReveal' | 'quickActions';

const showing = new Set<ListCard>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The Climbs list says whether one of its cards is on screen (focused and drawn). */
export function setListCardShowing(card: ListCard, on: boolean): void {
  if (showing.has(card) === on) return;
  if (on) showing.add(card);
  else showing.delete(card);
  for (const listener of listeners) listener();
}

/** Whether this card is on the Climbs list's screen right now. */
export function isListCardShowing(card: ListCard): boolean {
  return showing.has(card);
}

/** The same, for a render. */
export function useListCardShowing(card: ListCard): boolean {
  const read = () => isListCardShowing(card);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test-only. */
export function _resetListCardPresenceForTests(): void {
  showing.clear();
  listeners.clear();
}
