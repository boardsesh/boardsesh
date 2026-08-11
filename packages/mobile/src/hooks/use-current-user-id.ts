import { useQuery } from '@tanstack/react-query';
import { getAuthToken } from '../lib/auth-store';
import { userIdFromJwt } from '../lib/jwt-user-id';

export const STORED_USER_ID_QUERY_KEY = ['storedJwtUserId'] as const;

/**
 * The signed-in user's id, read from the JWT already sitting in SecureStore.
 *
 * `useProfile` is a plain network query, so with no signal it never answers and
 * every screen keyed on the profile id (My Boards' owned-vs-followed split) has
 * to degrade. The id is on the device regardless: the backend signs the native
 * JWT with `sub: userId`, the same id compared against `board.ownerId`. This
 * reads it back so a cold start with no connection can still tell "your boards"
 * from the ones you follow.
 *
 * Display-only — see `userIdFromJwt`'s warning; the decode is unverified.
 *
 * Nothing new has to be cleared at sign-out: the id lives in the JWT that
 * `clearTokens()` deletes, and this query's cached copy goes with
 * `queryClient.clear()` in `runSignedOutCleanup`. That's the whole reason it
 * derives the id instead of persisting a second identity field — one less thing
 * that can outlive an account on a shared device.
 */
export function useStoredUserId(enabled: boolean): string | undefined {
  const { data } = useQuery({
    queryKey: STORED_USER_ID_QUERY_KEY,
    // `?? null` because React Query rejects an undefined resolution as a
    // programming error ("Query data cannot be undefined"); "no id" is a real,
    // cacheable answer here.
    queryFn: async () => userIdFromJwt(await getAuthToken()) ?? null,
    enabled,
    // The keychain read is cheap but the answer only changes across a sign-in /
    // sign-out, both of which clear the cache anyway.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? undefined;
}
