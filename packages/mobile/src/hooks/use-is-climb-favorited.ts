import { useSyncExternalStore } from 'react';
import { favoritesStore } from '@boardsesh/climb-actions';

/**
 * Subscribe to a single climb's favourited state from the shared
 * `favoritesStore`. Per-UUID subscription: a row only re-renders when its OWN
 * climb's heart flips, never when another row's does. The snapshot is a
 * primitive boolean, so `useSyncExternalStore`'s `Object.is` check holds.
 *
 * Reads whatever the store currently holds — `useClimbListFavorites` fills it
 * for the visible list, and `useToggleFavorite` writes each toggle straight in.
 */
export function useIsClimbFavorited(climbUuid: string): boolean {
  return useSyncExternalStore(
    favoritesStore.subscribe,
    () => favoritesStore.getIsFavorited(climbUuid),
    () => false,
  );
}
