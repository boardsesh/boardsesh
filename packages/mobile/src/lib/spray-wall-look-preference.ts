import { useCallback, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Whether this climber draws spray walls in their OWN board look instead of the
// look each wall's creator picked (More → Board look). Off by default: a spray
// wall is a photograph, and the creator chose the look that reads on it.
//
// Its own key rather than a field on the board-render settings, because applying
// a preset replaces that whole bundle and would silently reset this choice.
//
// Structure mirrors `climb-quick-actions-button-preference.ts`: a module store
// read through `useSyncExternalStore` with a stable snapshot, and a one-time
// load shared by every mounted reader. The render hook reads it on every row, so
// the read is O(1) and the load is kicked once, not once per row.
const STORAGE_KEY = 'sprayWallsUseOwnLook';

let current = false;
let writtenBeforeLoad = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function ensureLoaded(): void {
  if (loadPromise) return;
  loadPromise = getPreference<boolean>(STORAGE_KEY)
    .then((stored) => {
      // A set that raced in while storage answered already wrote the newer value.
      if (writtenBeforeLoad) return;
      if (stored === true && !current) {
        current = true;
        notify();
      }
    })
    .catch(() => {
      // Storage unavailable: let the next reader retry.
      loadPromise = null;
    });
}

// Subscribing is what loads it: every reader goes through `useSyncExternalStore`,
// so the first mounted reader pays the one storage read.
export function subscribeToSprayWallsUseOwnLook(onStoreChange: () => void): () => void {
  ensureLoaded();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getSprayWallsUseOwnLook(): boolean {
  return current;
}

export async function setSprayWallsUseOwnLook(useOwnLook: boolean): Promise<void> {
  writtenBeforeLoad = true;
  if (current !== useOwnLook) {
    current = useOwnLook;
    notify();
  }
  await setPreference(STORAGE_KEY, useOwnLook);
}

/** Whether spray walls draw in the climber's own look. Cheap enough for every row. */
export function useSprayWallsUseOwnLook(): boolean {
  return useSyncExternalStore(subscribeToSprayWallsUseOwnLook, getSprayWallsUseOwnLook, getSprayWallsUseOwnLook);
}

/** The setting and its setter, for the Board look screen's toggle. */
export function useSprayWallsUseOwnLookSetting(): { useOwnLook: boolean; setUseOwnLook: (next: boolean) => void } {
  const useOwnLook = useSprayWallsUseOwnLook();
  const setUseOwnLook = useCallback((next: boolean) => {
    void setSprayWallsUseOwnLook(next);
  }, []);
  return { useOwnLook, setUseOwnLook };
}

/** Test seam: forget the loaded value. */
export function resetSprayWallsUseOwnLookForTests(): void {
  current = false;
  loadPromise = null;
  writtenBeforeLoad = false;
  listeners.clear();
}
