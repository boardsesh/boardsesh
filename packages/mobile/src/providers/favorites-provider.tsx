// FavoritesProvider — mirrors web's
// `packages/web/app/components/climb-actions/favorites-batch-context.tsx`.
// The shared `favoritesStore` (now in `@boardsesh/climb-actions`) lets
// components subscribe per-uuid via `useSyncExternalStore`, avoiding the
// React Context "all consumers re-render" cascade.
//
// On mobile the store is filled incrementally rather than in one shot:
// `useClimbListFavorites` fetches the visible climb list's UUIDs and
// `useToggleFavorite` writes each toggle straight in. So the `favorites`
// prop is OPTIONAL here and, when omitted, this provider never writes the
// set at all — handing it an empty Set each render would wipe whatever the
// list just fetched. Web still passes a full set and keeps the old
// bulk-replace behaviour.

import { createContext, useContext, useCallback, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { favoritesStore } from '@boardsesh/climb-actions';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';

type FavoritesContextValue = {
  toggleFavorite: (uuid: string) => Promise<boolean>;
};

const FavoritesContext = createContext<FavoritesContextValue | undefined>(undefined);

const noopToggleFavorite = async (_uuid: string): Promise<boolean> => false;

type FavoritesProviderProps = {
  favorites?: Set<string>;
  toggleFavorite?: (uuid: string) => Promise<boolean>;
  isLoading?: boolean;
  isAuthenticated?: boolean;
  children: ReactNode;
};

export function FavoritesProvider({
  favorites,
  toggleFavorite = noopToggleFavorite,
  isLoading = false,
  isAuthenticated = false,
  children,
}: FavoritesProviderProps) {
  // No unmount cleanup: an unconditional `setFavorites(EMPTY)` on unmount
  // races a sibling provider that just mounted (e.g., during a parent
  // re-render that briefly mounts two FavoritesProviders). The new instance's
  // mount runs first, writes its data; the old instance's cleanup runs next
  // and wipes it. Without a per-instance ownership token in the store we
  // can't safely scope the cleanup, and the only stale-data window this
  // guards is "provider unmounts with no replacement" — in which case no
  // subscriber is in the tree to observe the leftover data either. A future
  // remount will overwrite via `setFavorites` on its own mount.
  useLayoutEffect(() => {
    if (!favorites) return;
    favoritesStore.setFavorites(favorites);
  }, [favorites]);

  useLayoutEffect(() => {
    favoritesStore.setMeta(isLoading, isAuthenticated);
  }, [isLoading, isAuthenticated]);

  const trackedToggleFavorite = useCallback(
    async (uuid: string): Promise<boolean> => {
      const isNowFavorited = await toggleFavorite(uuid);
      // Reflect the result in the store so a heart flips wherever it's rendered.
      // The wired-up `toggleFavorite` writes this too; doing it here as well
      // keeps the provider correct for any other implementation of the prop,
      // and the store no-ops a write that doesn't change the value.
      favoritesStore.setIsFavorited(uuid, isNowFavorited);
      track(SHARED_EVENTS.FavoriteToggle, {
        action: isNowFavorited ? 'added' : 'removed',
        climbUuid: uuid,
        source: 'mobile',
      });
      return isNowFavorited;
    },
    [toggleFavorite],
  );

  const value = useMemo<FavoritesContextValue>(
    () => ({ toggleFavorite: trackedToggleFavorite }),
    [trackedToggleFavorite],
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavoritesContext(): FavoritesContextValue {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavoritesContext must be used within a FavoritesProvider');
  return ctx;
}
