import { useState, useEffect, useRef, useCallback } from 'react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_MY_GYMS, type GetMyGymsQueryResponse, type GetMyGymsQueryVariables } from '@boardsesh/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';

/**
 * Fetches the gyms the current user owns via GraphQL. Membership-based listing
 * (admin/editor) arrives with the staff-roles PR — today the `myGyms` resolver
 * only returns gyms where `ownerId = userId` (no gym_members join). The role-chip
 * logic already handles admin/editor rows; they become reachable once `myGyms`
 * includes gym_members.
 * Gyms are fetched when `enabled` becomes true and the user is authenticated.
 *
 * Call `loadMore` to fetch the next page; `hasMore` indicates whether more pages exist.
 * Mirrors {@link import('./use-my-boards').useMyBoards} so the My Gyms drawer follows
 * the same load/paginate/error shape as My Boards.
 */
export function useMyGyms(enabled: boolean, limit = 50) {
  const { token, isAuthenticated } = useWsAuthToken();
  const [gyms, setGyms] = useState<Gym[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  // Synchronous guard prevents double-fires from the IntersectionObserver
  const isFetchingMoreRef = useRef(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    if (!enabled || !isAuthenticated || !token) return;

    let cancelled = false;
    if (!hasDataRef.current) {
      setIsLoading(true);
    }
    setError(null);
    offsetRef.current = 0;

    const client = createGraphQLHttpClient(token);
    client
      .request<GetMyGymsQueryResponse, GetMyGymsQueryVariables>(GET_MY_GYMS, { input: { limit, offset: 0 } })
      .then((response) => {
        if (!cancelled) {
          setGyms(response.myGyms.gyms);
          setHasMore(response.myGyms.hasMore);
          offsetRef.current = response.myGyms.gyms.length;
          hasDataRef.current = true;
        }
      })
      .catch((requestError) => {
        console.error('Failed to fetch gyms:', requestError);
        if (!cancelled) setError('Failed to load your gyms');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, isAuthenticated, token, limit]);

  const loadMore = useCallback(() => {
    if (!hasMore || isFetchingMoreRef.current || !token || !isAuthenticated) return;

    isFetchingMoreRef.current = true;
    setIsFetchingMore(true);
    const offset = offsetRef.current;
    const client = createGraphQLHttpClient(token);
    client
      .request<GetMyGymsQueryResponse, GetMyGymsQueryVariables>(GET_MY_GYMS, { input: { limit, offset } })
      .then((response) => {
        setGyms((prev) => [...prev, ...response.myGyms.gyms]);
        setHasMore(response.myGyms.hasMore);
        offsetRef.current = offset + response.myGyms.gyms.length;
      })
      .catch((requestError) => {
        console.error('Failed to load more gyms:', requestError);
      })
      .finally(() => {
        isFetchingMoreRef.current = false;
        setIsFetchingMore(false);
      });
  }, [hasMore, token, isAuthenticated, limit]);

  return { gyms, isLoading, isFetchingMore, hasMore, loadMore, error };
}
