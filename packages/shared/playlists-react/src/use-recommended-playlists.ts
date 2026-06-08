import { useEffect, useRef, useState } from 'react';
import {
  RECOMMENDED_PLAYLISTS,
  type DiscoverablePlaylist,
  type RecommendedPlaylistsInput,
  type RecommendedPlaylistsQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

export type UseRecommendedPlaylistsOptions = {
  /** Active board config. The hook only fetches once all four are defined. */
  boardType?: string;
  layoutId?: number;
  sizeId?: number;
  angle?: number;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UseRecommendedPlaylistsResult = {
  /** The 0–3 cohort playlists (Crowd Favorites / Hidden Gems / Fresh) for the
   *  board, in display order. Empty when the config isn't a generated cohort. */
  playlists: DiscoverablePlaylist[];
  isLoading: boolean;
  hasError: boolean;
  refetch: () => void;
};

/**
 * Fetches the public per-board recommendation cohort playlists for an exact
 * board config (boardType + layoutId + sizeId + angle). Returns [] when the
 * config has no generated cohort, so Home can fall back to a popularity sort.
 *
 * A single, fixed-size request (no pagination): the resolver returns at most
 * three rows. Changing any board field resets and refetches.
 */
export function useRecommendedPlaylists({
  boardType,
  layoutId,
  sizeId,
  angle,
  executeGraphQL: executeGraphQLOverride,
}: UseRecommendedPlaylistsOptions): UseRecommendedPlaylistsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;

  const ready = boardType !== undefined && layoutId !== undefined && sizeId !== undefined && angle !== undefined;

  const [playlists, setPlaylists] = useState<DiscoverablePlaylist[]>([]);
  const [isLoading, setIsLoading] = useState(ready);
  const [hasError, setHasError] = useState(false);

  // Bumping this triggers a refetch without changing the board inputs.
  const [reloadToken, setReloadToken] = useState(0);

  // Guard against a stale in-flight response overwriting a newer board's data.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!ready) {
      setPlaylists([]);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(true);
    setHasError(false);

    const input: RecommendedPlaylistsInput = { boardType, layoutId, sizeId, angle };
    executeGraphQL<RecommendedPlaylistsQueryResponse, { input: RecommendedPlaylistsInput }>(RECOMMENDED_PLAYLISTS, {
      input,
    })
      .then((response) => {
        if (requestId !== requestIdRef.current) return;
        setPlaylists(response.recommendedPlaylists ?? []);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        console.error('Failed to fetch recommended playlists:', err);
        setPlaylists([]);
        setHasError(true);
        setIsLoading(false);
      });
  }, [ready, boardType, layoutId, sizeId, angle, executeGraphQL, reloadToken]);

  return {
    playlists,
    isLoading,
    hasError,
    refetch: () => setReloadToken((token) => token + 1),
  };
}
