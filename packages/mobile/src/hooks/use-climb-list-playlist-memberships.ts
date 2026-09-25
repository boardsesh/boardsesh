import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import {
  GET_PLAYLISTS_FOR_CLIMBS,
  type GetPlaylistsForClimbsQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { playlistMembershipStore } from '@boardsesh/climb-actions';
import { getHttpClient } from '../lib/graphql/client';
import { useAuth } from '../providers/auth-provider';
import { useShowPlaylistTagsPreference } from '../lib/show-playlist-tags-preference';

// The backend caps `climbUuids` per request; chunk longer visible sets.
const CHUNK_SIZE = 500;

type UseClimbListPlaylistMembershipsArgs = {
  boardName: string;
  layoutId: number;
  // Must be a referentially-stable array (memoize at the call site) — the effect
  // depends on it, so a fresh array every render would refetch every render.
  climbUuids: readonly string[];
  /**
   * Fetch even when the "Show playlist tags" setting is off. The rich density
   * tier renders the tag line unconditionally — the tags ARE what that tier
   * adds — so without this the rows would ask for tags the store was never
   * filled with and render an empty line for anyone who left the setting off,
   * which is its default.
   */
  force?: boolean;
};

/**
 * Feed the shared `playlistMembershipStore` with the playlist membership of the
 * currently-visible climbs, so `ClimbPlaylistChips` rows can render tags. The
 * mobile analog of web's incremental `GET_PLAYLISTS_FOR_CLIMBS` fetch, written
 * to the established "fetch the visible UUIDs, write into the external store"
 * pattern (see the favorites note in `use-mobile-climb-actions-data.ts`).
 *
 * No-op unless the user enabled the setting (or a caller passes `force`) AND is
 * signed in. Dedupes via a ref
 * so each climb is requested once; resets the ref and clears the store whenever
 * the board/layout/auth/enabled context flips, so a previous board's memberships
 * can't paint the new board's rows. Deferred past the active fling via
 * `runAfterInteractions`, mirroring the logbook fetch.
 */
export function useClimbListPlaylistMemberships({
  boardName,
  layoutId,
  climbUuids,
  force = false,
}: UseClimbListPlaylistMembershipsArgs): void {
  const { enabled: settingEnabled } = useShowPlaylistTagsPreference();
  const enabled = force || settingEnabled;
  const { isAuthenticated } = useAuth();

  const fetchedRef = useRef<Set<string>>(new Set());
  const contextKey = `${boardName}:${layoutId}:${enabled ? 1 : 0}:${isAuthenticated ? 1 : 0}`;
  const contextKeyRef = useRef(contextKey);

  // Reset before any fetch when the context changes. Runs in the same render
  // pass via the effect ordering below (this effect is declared first).
  useEffect(() => {
    if (contextKeyRef.current === contextKey) return;
    contextKeyRef.current = contextKey;
    fetchedRef.current = new Set();
    playlistMembershipStore.reset();
  }, [contextKey]);

  useEffect(() => {
    if (!enabled || !isAuthenticated || layoutId <= 0 || climbUuids.length === 0) return;
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
          const response = await getHttpClient().request<GetPlaylistsForClimbsQueryResponse>(GET_PLAYLISTS_FOR_CLIMBS, {
            input: { boardType: boardName, layoutId, climbUuids: chunk },
          });
          if (cancelled) return;
          // The backend returns only climbs that ARE in a playlist; the rest stay
          // empty (no chips), which is what we want.
          playlistMembershipStore.setMembershipsFor(response.playlistsForClimbs);
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
  }, [enabled, isAuthenticated, boardName, layoutId, climbUuids]);
}
