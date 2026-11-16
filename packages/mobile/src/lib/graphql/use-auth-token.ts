// Reactive read of the stored auth token, exposed through React Query so the
// shared `@boardsesh/playlists-react` hooks (which gate `enabled` on a non-null
// token and key their caches by it) can react to sign-in/out.
//
// Mobile's `getHttpClient()` already attaches the bearer via `authenticatedFetch`,
// so the token here is *only* used as an `enabled` gate + query-key segment, not
// to authorize the request itself. The query is invalidated on sign-out because
// the auth provider calls `queryClient.clear()`.

import { useQuery } from '@tanstack/react-query';
import { getAuthToken } from '../auth-store';

export const AUTH_TOKEN_QUERY_KEY = ['authToken'] as const;

/** Returns the current bearer token (or null when signed out). */
export function useAuthToken() {
  return useQuery({
    queryKey: AUTH_TOKEN_QUERY_KEY,
    queryFn: () => getAuthToken(),
    // The token rarely changes within a session; the auth provider clears the
    // whole query cache on sign-out, so background refetching adds no value.
    staleTime: 5 * 60 * 1000,
  });
}
