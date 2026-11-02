// Whether the one-time "Connected to {{board}}" confirmation (#5654) is about to
// show or is on screen, for the player's preview-first card to wait on: both
// explain what Put on board keeps lighting, so they never stack (one prompt at
// a time, the `quick-actions-tip.ts` rule). The confirmation goes first: it
// comes once per phone and has to reach every first connect, while the card
// can come back once the dialog is closed.
//
// `FirstConnectHost` publishes rather than the player asking the first-connect
// store, so the player's module graph stays free of that store and its storage.

import { useSyncExternalStore } from 'react';

let showing = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** From the moment the host decides to confirm until the dialog is closed. */
export function setFirstConnectConfirmationShowing(on: boolean): void {
  if (showing === on) return;
  showing = on;
  for (const listener of listeners) listener();
}

export function isFirstConnectConfirmationShowing(): boolean {
  return showing;
}

/** The same, for a render. */
export function useFirstConnectConfirmationShowing(): boolean {
  return useSyncExternalStore(subscribe, isFirstConnectConfirmationShowing, isFirstConnectConfirmationShowing);
}

/** Test-only. */
export function _resetFirstConnectConfirmationPresenceForTests(): void {
  showing = false;
  listeners.clear();
}
