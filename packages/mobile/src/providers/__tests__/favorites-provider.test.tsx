// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { favoritesStore } from '@boardsesh/climb-actions';

// The provider imports `../lib/analytics`. Replace that module with a spy so we
// can assert the instrumentation fires (the `posthog-react-native` native dep is
// separately stubbed via the vite.config alias). `vi.hoisted` is required: bare
// `vi.mock` factories are hoisted above top-level `const`s, so the spy must be
// created inside a hoisted block to be in scope when the factory runs.
const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

import { FavoritesProvider, useFavoritesContext } from '../favorites-provider';

describe('FavoritesProvider', () => {
  beforeEach(() => {
    // Reset the shared store between tests so subscriber state doesn't leak.
    favoritesStore.setFavorites(new Set());
    favoritesStore.setMeta(false, false);
    trackMock.mockClear();
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

  it('does not wipe the store on unmount (a sibling mount writing first would lose data)', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider favorites={new Set(['a'])} isAuthenticated>
        {children}
      </FavoritesProvider>
    );
    const { unmount } = renderHook(() => useFavoritesContext(), { wrapper });
    expect(favoritesStore.getIsFavorited('a')).toBe(true);

    // Unmount intentionally does NOT clear the store — a future remount will
    // overwrite via its own setFavorites. See the no-cleanup comment in
    // favorites-provider.tsx for why we don't unconditionally wipe.
    unmount();
    expect(favoritesStore.getIsFavorited('a')).toBe(true);
    expect(favoritesStore.getIsAuthenticated()).toBe(true);
  });

  it('a new provider mount cleanly overwrites the previous instance’s data', () => {
    const first = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider favorites={new Set(['a'])}>{children}</FavoritesProvider>
    );
    const { unmount } = renderHook(() => useFavoritesContext(), { wrapper: first });
    expect(favoritesStore.getIsFavorited('a')).toBe(true);
    unmount();

    const second = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider favorites={new Set(['b'])} isAuthenticated>
        {children}
      </FavoritesProvider>
    );
    renderHook(() => useFavoritesContext(), { wrapper: second });
    expect(favoritesStore.getIsFavorited('a')).toBe(false);
    expect(favoritesStore.getIsFavorited('b')).toBe(true);
    expect(favoritesStore.getIsAuthenticated()).toBe(true);
  });

  it('toggleFavorite from context calls the prop function and tracks `added` once', async () => {
    const toggleFavorite = vi.fn(async (_uuid: string) => true);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider toggleFavorite={toggleFavorite}>{children}</FavoritesProvider>
    );
    const { result } = renderHook(() => useFavoritesContext(), { wrapper });
    await expect(result.current.toggleFavorite('uuid-x')).resolves.toBe(true);
    expect(toggleFavorite).toHaveBeenCalledWith('uuid-x');
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Favorite Toggle', {
      action: 'added',
      climbUuid: 'uuid-x',
      source: 'mobile',
    });
  });

  it('toggleFavorite tracks `removed` when the toggle resolves to false', async () => {
    const toggleFavorite = vi.fn(async (_uuid: string) => false);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FavoritesProvider toggleFavorite={toggleFavorite}>{children}</FavoritesProvider>
    );
    const { result } = renderHook(() => useFavoritesContext(), { wrapper });
    await expect(result.current.toggleFavorite('uuid-y')).resolves.toBe(false);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Favorite Toggle', {
      action: 'removed',
      climbUuid: 'uuid-y',
      source: 'mobile',
    });
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
