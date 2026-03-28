'use client';

import React, { useMemo } from 'react';
import { createTypedContext } from '@/app/lib/create-typed-context';

interface FavoritesContextValue {
  isFavorited: (uuid: string) => boolean;
  toggleFavorite: (uuid: string) => Promise<boolean>;
  isLoading: boolean;
  isAuthenticated: boolean;
}

const [FavoritesCtx, useFavoritesContext] = createTypedContext<FavoritesContextValue>('Favorites');

export const FavoritesContext = FavoritesCtx;
export { useFavoritesContext };

interface FavoritesProviderProps {
  favorites: Set<string>;
  isFavorited: (uuid: string) => boolean;
  toggleFavorite: (uuid: string) => Promise<boolean>;
  isLoading: boolean;
  error: Error | null;
  isAuthenticated: boolean;
  children: React.ReactNode;
}

export function FavoritesProvider({
  isFavorited,
  toggleFavorite,
  isLoading,
  isAuthenticated,
  children,
}: FavoritesProviderProps) {
  const value = useMemo<FavoritesContextValue>(
    () => ({
      isFavorited,
      toggleFavorite,
      isLoading,
      isAuthenticated,
    }),
    [isFavorited, toggleFavorite, isLoading, isAuthenticated]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

// Re-export for backwards compatibility during migration
export { FavoritesContext as FavoritesBatchContext };
export { FavoritesProvider as FavoritesBatchProvider };
