import { useQuery } from '@tanstack/react-query';
import { readLocalUserId } from '../lib/local-user-id';

/**
 * Historical key name: on web the id no longer comes from a JWT (see below). It
 * stays as-is because the string is internal to React Query, and renaming it
 * would churn every consumer and mock for nothing.
 */
export const STORED_USER_ID_QUERY_KEY = ['storedJwtUserId'] as const;

export type StoredUserId = {
  userId: string | undefined;
  /** The local read is still in flight — not yet "there is no id". */
  isLoading: boolean;
};

/**
 * The signed-in user's id, from whatever this device can answer without the
 * network — `readLocalUserId`, the platform-forked source.
 *
 * `useProfile` is a plain network query, so with no signal it never answers and
 * every screen keyed on the profile id (My Boards' owned-vs-followed split) has
 * to degrade. The id is on the device regardless, it just lives somewhere
 * different per platform: native decodes the `sub` claim of the JWT in
 * SecureStore, web reads the identity the browser session already confirmed
 * (its token is an encrypted JWE with nothing to decode — #4321). Either way
 * it's the same id compared against `board.ownerId`, so a start with no
 * connection can still tell "your boards" from the ones you follow.
 *
 * Display-only — the native decode is unverified (see `userIdFromJwt`) and the
 * web read reports what a past session confirmed, not what the server says now.
 *
 * Nothing new has to be cleared at sign-out: on native the id lives in the JWT
 * that `clearTokens()` deletes, on web in the module-level identity a sign-out
 * resets, and this query's cached copy goes with `queryClient.clear()` in
 * `runSignedOutCleanup`. That's the whole reason it derives the id instead of
 * persisting a second identity field — one less thing that can outlive an
 * account on a shared device.
 */
export function useStoredUserId(enabled: boolean): StoredUserId {
  const { data, isLoading } = useQuery({
    queryKey: STORED_USER_ID_QUERY_KEY,
    // `?? null` because React Query rejects an undefined resolution as a
    // programming error ("Query data cannot be undefined"); "no id" is a real,
    // cacheable answer here.
    queryFn: async () => (await readLocalUserId()) ?? null,
    enabled,
    // The local read is cheap but the answer only changes across a sign-in /
    // sign-out, both of which clear the cache anyway. `gcTime: Infinity` is safe
    // for the same reason: `runSignedOutCleanup`'s `queryClient.clear()` drops
    // the entry, so it can't outlive the account that produced it.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  // `isLoading` (not `isPending`) so a disabled query never reads as in-flight —
  // callers gate their loading state on this and would otherwise spin forever.
  return { userId: data ?? undefined, isLoading };
}
