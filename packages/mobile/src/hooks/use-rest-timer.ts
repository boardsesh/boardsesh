// React bindings for the rest-timer store (#5378). Kept out of
// `lib/rest-timer-store.ts` so that module stays React-free and node-testable.

import { useSyncExternalStore } from 'react';
import { getRestTimerState, subscribeRestTimer, type RestTimerState } from '../lib/rest-timer-store';

/**
 * The whole runtime state. The store hands back the SAME object between writes,
 * so this is reference-stable and safe as a `getSnapshot`.
 */
export function useRestTimerState(): RestTimerState {
  return useSyncExternalStore(subscribeRestTimer, getRestTimerState, getRestTimerState);
}

/**
 * Just "is the timer on". The cheap read for anything structural — the bar's
 * geometry, the runtime gate — so it never re-renders on an anchor change.
 */
export function useRestTimerArmed(): boolean {
  return useSyncExternalStore(
    subscribeRestTimer,
    () => getRestTimerState().armed,
    () => false,
  );
}
