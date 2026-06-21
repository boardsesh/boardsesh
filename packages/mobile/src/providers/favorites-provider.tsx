// FavoritesProvider — mirrors web's
// `packages/web/app/components/climb-actions/favorites-batch-context.tsx`.
// The shared `favoritesStore` (now in `@boardsesh/climb-actions`) lets
// components subscribe per-uuid via `useSyncExternalStore`, avoiding the
// React Context "all consumers re-render" cascade.
//
// Mobile has no consumer screens for favorites today, so the provider
// accepts optional `favorites` / `toggleFavorite` / `isLoading` /
// `isAuthenticated` props and falls back to empty defaults. The data
// hook (parallel to web's `useClimbActionsData`) is a follow-up — when a
// mobile screen needs favorites, build `useMobileClimbActionsData` and
// wire its output into this provider's props.

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

const EMPTY_FAVORITES: ReadonlySet<string> = new Set();

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
    favoritesStore.setFavorites(favorites ?? (EMPTY_FAVORITES as Set<string>));
  }, [favorites]);

  useLayoutEffect(() => {
    favoritesStore.setMeta(isLoading, isAuthenticated);
  }, [isLoading, isAuthenticated]);

  const trackedToggleFavorite = useCallback(
    async (uuid: string): Promise<boolean> => {
      const isNowFavorited = await toggleFavorite(uuid);
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
