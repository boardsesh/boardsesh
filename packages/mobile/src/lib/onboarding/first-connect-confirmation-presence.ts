// Whether the one-time "Connected to {{board}}" confirmation (#5654) is about to
// show or is on screen, for the Climbs list's board-reveal and quick-actions
// tips and the player's preview-first card to wait on: one prompt at a time
// (the `quick-actions-tip.ts` rule). The confirmation goes first: it comes once
// per phone and has to reach every first connect, while the others can come
// back once the dialog is closed.
//
// The host turns it on BEFORE it records the connect. Recording it hides the
// Climbs list's first-connect card, which those three were waiting behind, so
// they see the confirmation coming without a moment in between to claim the
// slot.
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

/** From the moment the host sees the connect it will confirm until the dialog is closed. */
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
