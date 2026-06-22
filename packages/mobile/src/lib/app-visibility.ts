import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

/**
 * Single source of truth for "is the app backgrounded", backed by ONE AppState
 * listener installed at module load. Components subscribe via
 * `useIsAppBackgrounded()` and re-render only when the flag flips — so many
 * climb-image instances can cheaply blank their decoded bitmaps on background
 * (freeing GPU textures + native heap) without each adding its own AppState
 * subscription.
 *
 * On-device profiling (Pixel 8 Pro, Android 16) showed backgrounding with the
 * play drawer open pinned ~104 MB GPU + ~387 MB *live* native heap (board-art
 * bitmaps held by the still-mounted views — RN doesn't unmount on background).
 * Blanking those views on background lets the system reclaim the textures and
 * returns the bitmaps to expo-image's pool, which the cache sweep then frees.
 *
 * Only `background` flips the flag — not `inactive`, which fires on transient
 * iOS interruptions (notification shade, app-switcher peek) where the user is
 * about to return and a blank-then-reload would just be a flash.
 */

let backgrounded = false;
const listeners = new Set<() => void>();

function setBackgrounded(next: boolean): void {
  if (next === backgrounded) return;
  backgrounded = next;
  for (const listener of listeners) listener();
}

// Defensive: unit tests mock `react-native` with a partial surface that often
// omits AppState. Optional-chaining + try/catch keep importing this module from
// throwing there (the flag simply stays at its foreground default).
try {
  AppState?.addEventListener?.('change', (state) => {
    setBackgrounded(state === 'background');
  });
} catch {
  // No AppState in this environment — leave the flag false.
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): boolean {
  return backgrounded;
}

export function useIsAppBackgrounded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
