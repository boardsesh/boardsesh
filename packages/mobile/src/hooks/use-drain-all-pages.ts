import { useEffect } from 'react';

export type UseDrainAllPagesOptions = {
  /** Whether another page is available to load. */
  hasMore: boolean;
  /** True while the initial page is loading. */
  isLoading: boolean;
  /** True while a subsequent page is loading. */
  isLoadingMore: boolean;
  /** Loads the next page. */
  loadMore: () => void;
};

/**
 * Eagerly loads every remaining page of an offset-paginated list. Each completed
 * page flips `isLoadingMore` back to false (and `hasMore` to false once the list
 * is exhausted), which re-runs this effect to fetch the next page until there's
 * nothing left.
 *
 * Gated on `isLoading` so it waits for the initial page, and on `isLoadingMore`
 * so only one fetch is in flight at a time. When the underlying list resets (e.g.
 * a board switch re-fetches page 0), `hasMore` flips back to true and draining
 * resumes automatically.
 *
 * Use when a screen needs the full set up front — to sort or filter across every
 * item rather than just the loaded prefix.
 */
export function useDrainAllPages({ hasMore, isLoading, isLoadingMore, loadMore }: UseDrainAllPagesOptions): void {
  useEffect(() => {
    if (hasMore && !isLoading && !isLoadingMore) loadMore();
  }, [hasMore, isLoading, isLoadingMore, loadMore]);
}
