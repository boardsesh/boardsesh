// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { favoritesStore } from '@boardsesh/climb-actions';
import { FavoritesProvider, useFavoritesContext } from '../favorites-provider';

describe('FavoritesProvider', () => {
  beforeEach(() => {
    // Reset the shared store between tests so subscriber state doesn't leak.
    favoritesStore.setFavorites(new Set());
    favoritesStore.setMeta(false, false);
  });

  it('syncs the `favorites` prop into the shared favoritesStore', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider favorites={new Set(['a', 'b'])} isLoading={false} isAuthenticated={true}>
        {children}
      </FavoritesProvider>
    );
    renderHook(() => useFavoritesContext(), { wrapper });

    expect(favoritesStore.getIsFavorited('a')).toBe(true);
    expect(favoritesStore.getIsFavorited('b')).toBe(true);
    expect(favoritesStore.getIsFavorited('c')).toBe(false);
    expect(favoritesStore.getIsAuthenticated()).toBe(true);
    expect(favoritesStore.getIsLoading()).toBe(false);
  });

  it('resets the store on unmount so a stale provider does not leak data', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider favorites={new Set(['a'])} isAuthenticated>
        {children}
      </FavoritesProvider>
    );
    const { unmount } = renderHook(() => useFavoritesContext(), { wrapper });
    expect(favoritesStore.getIsFavorited('a')).toBe(true);

    unmount();
    expect(favoritesStore.getIsFavorited('a')).toBe(false);
    expect(favoritesStore.getIsAuthenticated()).toBe(false);
    expect(favoritesStore.getIsLoading()).toBe(false);
  });

  it('toggleFavorite from context calls the prop function', async () => {
    const toggleFavorite = vi.fn(async (_uuid: string) => true);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider toggleFavorite={toggleFavorite}>{children}</FavoritesProvider>
    );
    const { result } = renderHook(() => useFavoritesContext(), { wrapper });
    await expect(result.current.toggleFavorite('uuid-x')).resolves.toBe(true);
    expect(toggleFavorite).toHaveBeenCalledWith('uuid-x');
  });

  it('default toggleFavorite resolves to `false` when not wired', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FavoritesProvider>{children}</FavoritesProvider>;
    const { result } = renderHook(() => useFavoritesContext(), { wrapper });
    await expect(result.current.toggleFavorite('uuid-x')).resolves.toBe(false);
  });

  it('useFavoritesContext throws when called outside a provider', () => {
    expect(() => renderHook(() => useFavoritesContext())).toThrow(/must be used within a FavoritesProvider/);
  });
});
