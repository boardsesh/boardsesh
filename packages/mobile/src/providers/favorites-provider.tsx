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

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { favoritesStore } from '@boardsesh/climb-actions';

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
  useLayoutEffect(() => {
    favoritesStore.setFavorites(favorites ?? (EMPTY_FAVORITES as Set<string>));
    // Reset on unmount so a remount or a conditionally-mounted second
    // provider doesn't see stale data from the previous instance. Today the
    // provider sits at the root and never unmounts; this is a guard for
    // future repositioning, not a current bug.
    return () => {
      favoritesStore.setFavorites(EMPTY_FAVORITES as Set<string>);
    };
  }, [favorites]);

  useLayoutEffect(() => {
    favoritesStore.setMeta(isLoading, isAuthenticated);
    return () => {
      favoritesStore.setMeta(false, false);
    };
  }, [isLoading, isAuthenticated]);

  const value = useMemo<FavoritesContextValue>(() => ({ toggleFavorite }), [toggleFavorite]);

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavoritesContext(): FavoritesContextValue {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavoritesContext must be used within a FavoritesProvider');
  return ctx;
}
