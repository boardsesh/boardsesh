import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { GET_FAVORITES, type FavoritesQueryResponse } from '@boardsesh/graphql/operations/favorites';
import { favoritesStore } from '@boardsesh/climb-actions';
import { getHttpClient } from '../lib/graphql/client';
import { useAuth } from '../providers/auth-provider';

// `FavoritesQueryClimbUuidsSchema` caps the query at 500 uuids; chunk longer
// visible sets rather than eating a validation error.
const CHUNK_SIZE = 500;

type UseClimbListFavoritesArgs = {
  boardName: string;
  // Favourites are keyed by (userId, boardName, climbUuid, angle) on the backend,
  // so the same climb can be favourited at 40° and not at 25°.
  angle: number;
  // Must be a referentially-stable array (memoize at the call site) — the effect
  // depends on it, so a fresh array every render would refetch every render.
  climbUuids: readonly string[];
};

/**
 * Feed the shared `favoritesStore` with the favourited state of the currently
 * visible climbs, so each row's heart can render. This is the batched fetcher
 * the store was built for — the `use-mobile-climb-actions-data` note called it
 * out as the missing piece — and it follows the same "fetch the visible UUIDs,
 * write into the external store" shape as `useClimbListPlaylistMemberships`.
 *
 * No-op while signed out (`favorites` returns an empty list for an anonymous
 * reader anyway). Dedupes via a ref so each climb is requested once; hands the
 * board/angle/auth context to the store, which clears itself when it flips so
 * one board's hearts can't paint another's rows. Deferred past the active fling
 * via `runAfterInteractions`, mirroring the logbook and playlist-tag fetches.
 */
export function useClimbListFavorites({ boardName, angle, climbUuids }: UseClimbListFavoritesArgs): void {
  const { isAuthenticated } = useAuth();

  const fetchedRef = useRef<Set<string>>(new Set());
  const contextKey = `${boardName}:${angle}:${isAuthenticated ? 1 : 0}`;

  // Reset before any fetch when the context changes. Runs in the same render
  // pass via the effect ordering below (this effect is declared first). The
  // store owns the "which context is this data for" check, so it still fires
  // for a board or angle change that happened while the list was unmounted.
  useEffect(() => {
    if (!favoritesStore.applyContext(contextKey)) return;
    fetchedRef.current = new Set();
  }, [contextKey]);

  useEffect(() => {
    if (!isAuthenticated || !boardName || climbUuids.length === 0) return;
    const toFetch = climbUuids.filter((uuid) => !fetchedRef.current.has(uuid));
    if (toFetch.length === 0) return;

    let cancelled = false;
    const handle = InteractionManager.runAfterInteractions(async () => {
      // Mark up-front so an overlapping effect run doesn't double-request the
      // same uuids while this batch is in flight.
      for (const uuid of toFetch) fetchedRef.current.add(uuid);
      try {
        for (let offset = 0; offset < toFetch.length; offset += CHUNK_SIZE) {
          const chunk = toFetch.slice(offset, offset + CHUNK_SIZE);
          const response = await getHttpClient().request<FavoritesQueryResponse>(GET_FAVORITES, {
            boardName,
            climbUuids: chunk,
            angle,
          });
          if (cancelled) return;
          // The query returns only the favourited subset; `mergeFavorites`
          // clears the rest of the chunk so an unfavourite made elsewhere
          // doesn't leave a stale heart behind.
          favoritesStore.mergeFavorites(chunk, response.favorites);
        }
      } catch {
        // A failed batch must not wedge future fetches — drop these uuids so a
        // later scroll or refresh retries them.
        if (!cancelled) for (const uuid of toFetch) fetchedRef.current.delete(uuid);
      }
    });

    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [isAuthenticated, boardName, angle, climbUuids]);
}
