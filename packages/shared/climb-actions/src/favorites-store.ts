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
  private contextKeyValue: string | null = null;
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
   *  components only re-render when their specific value flips.
   *
   *  Callers wire as `useSyncExternalStore(store.subscribe, () => store.getIsFavorited(uuid))`.
   *  The arrow closure is rebuilt every render — that's fine and does NOT
   *  need useMemo. React's docs guarantee snapshot-fn identity doesn't
   *  matter as long as the returned value is Object.is-stable, which
   *  primitives always are. Defensive memoization just adds noise here. */
  getIsFavorited = (uuid: string): boolean => {
    return this.favorites.has(uuid);
  };

  /** Read loading state. Used via useSyncExternalStore so only components
   *  that actually read this value re-render when it changes. */
  getIsLoading = (): boolean => this.isLoadingValue;

  /** Read auth state. Stable for the lifetime of a session. */
  getIsAuthenticated = (): boolean => this.isAuthenticatedValue;

  /**
   * Merge one batched lookup into the set. `knownUuids` is every climb the
   * lookup asked about; `favoritedUuids` is the subset that came back favorited.
   * Climbs in `knownUuids` but absent from `favoritedUuids` are cleared, so a
   * favourite removed on another device stops showing a heart once its row is
   * re-fetched. Climbs outside `knownUuids` are left alone — batches cover a
   * scroll window, not the whole list, so they must not wipe earlier pages.
   */
  mergeFavorites(knownUuids: readonly string[], favoritedUuids: readonly string[]): void {
    const favoritedSet = new Set(favoritedUuids);
    let changed = false;
    const next = new Set(this.favorites);
    for (const uuid of knownUuids) {
      if (favoritedSet.has(uuid)) {
        if (!next.has(uuid)) {
          next.add(uuid);
          changed = true;
        }
      } else if (next.delete(uuid)) {
        changed = true;
      }
    }
    if (!changed) return;
    this.favorites = next;
    this.notify();
  }

  /** Set one climb's favorited state (a toggle's optimistic write / server truth). */
  setIsFavorited(uuid: string, favorited: boolean): void {
    if (this.favorites.has(uuid) === favorited) return;
    const next = new Set(this.favorites);
    if (favorited) next.add(uuid);
    else next.delete(uuid);
    this.favorites = next;
    this.notify();
  }

  /**
   * Scope the set to a context — mobile passes board + angle + auth. Clears
   * everything when it differs from the context the current data was fetched
   * for, since favorites are keyed by (board, climb, angle) on the backend and
   * a previous context's hearts must not paint the new one's rows. Returns
   * whether the context changed, so a caller can drop its own fetched-uuid
   * bookkeeping in the same step.
   *
   * Lives on the store rather than in the calling hook because the store
   * outlives any one hook instance: remounting the climb list must still notice
   * a board or angle change that happened while it was unmounted.
   */
  applyContext(contextKey: string): boolean {
    if (this.contextKeyValue === contextKey) return false;
    this.reset();
    this.contextKeyValue = contextKey;
    return true;
  }

  /** Drop everything, including the context the data was fetched for. */
  reset(): void {
    this.contextKeyValue = null;
    if (this.favorites.size === 0) return;
    this.favorites = new Set();
    this.notify();
  }

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
