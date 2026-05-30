/**
 * External store for favorites data, enabling per-UUID subscriptions via
 * `useSyncExternalStore`. This avoids the React Context "all consumers
 * re-render" problem — each component only re-renders when its specific
 * climb's favorited status flips.
 *
 * Pure class with no React or DOM coupling. The `subscribe` signature
 * matches `useSyncExternalStore` so both web and mobile providers can
 * point components straight at the singleton.
 */
export class FavoritesStore {
  private favorites = new Set<string>();
  private isLoadingValue = false;
  private isAuthenticatedValue = false;
  private listeners = new Set<() => void>();

  /** Subscribe to store changes (signature expected by useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Check if a specific UUID is favorited. Returns a primitive boolean
   *  so `Object.is` comparison in useSyncExternalStore works correctly —
   *  components only re-render when their specific value flips. */
  getIsFavorited = (uuid: string): boolean => {
    return this.favorites.has(uuid);
  };

  /** Read loading state. Used via useSyncExternalStore so only components
   *  that actually read this value re-render when it changes. */
  getIsLoading = (): boolean => this.isLoadingValue;

  /** Read auth state. Stable for the lifetime of a session. */
  getIsAuthenticated = (): boolean => this.isAuthenticatedValue;

  /** Bulk-replace the favorites set (called when React Query data changes). */
  setFavorites(next: Set<string>): void {
    // React Query creates new Set instances on each fetch, so reference equality
    // almost never fires. Compare contents instead to avoid spurious notifications.
    if (next.size === this.favorites.size && [...next].every((id) => this.favorites.has(id))) return;
    this.favorites = next;
    this.notify();
  }

  /** Update loading and auth state. Only notifies if values actually changed. */
  setMeta(isLoading: boolean, isAuthenticated: boolean): void {
    if (this.isLoadingValue === isLoading && this.isAuthenticatedValue === isAuthenticated) return;
    this.isLoadingValue = isLoading;
    this.isAuthenticatedValue = isAuthenticated;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const favoritesStore = new FavoritesStore();
