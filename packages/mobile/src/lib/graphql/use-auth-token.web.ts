import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  captureAuthCredentialGeneration,
  captureConfirmedWebAuthIdentity,
  getAuthToken,
  hasConfirmedAnonymousWebSession,
  subscribeAuthTokenChanges,
  synchronizeWebSession,
} from '../auth-store.web';

export const AUTH_TOKEN_QUERY_KEY = ['authToken'] as const;

/** The signed-in login and credential generation: who a request goes out as. */
function readBrowserSession(): string {
  const identity = captureConfirmedWebAuthIdentity();
  return JSON.stringify([captureAuthCredentialGeneration(), identity?.userId ?? null, identity?.authSessionId ?? null]);
}

/**
 * Expo web's useAuthToken. Callers use the result only as an `enabled` gate and
 * a query-key segment (see use-auth-token.ts), so the browser hands them a label
 * for the signed-in login instead of the backend JWE. The credential stays out
 * of React Query data and of the playlists-react query keys, and a new login,
 * a sign-out or a credential rotation gives callers a new key (#7596).
 */
export function useAuthToken() {
  const session = useSyncExternalStore(subscribeAuthTokenChanges, readBrowserSession, readBrowserSession);
  return useQuery({
    queryKey: [...AUTH_TOKEN_QUERY_KEY, 'browser-session', session],
    queryFn: async (): Promise<string | null> => {
      let token = await getAuthToken();
      if (!token && !hasConfirmedAnonymousWebSession()) {
        // A cold page, or one between two reads of its login: read the session
        // instead of caching "signed out" for a page that may have a login.
        const read = await synchronizeWebSession();
        if (read.status !== 'authenticated' && read.status !== 'anonymous')
          throw new Error('The browser session could not be read');
        token = await getAuthToken();
      }
      return token && captureConfirmedWebAuthIdentity() ? readBrowserSession() : null;
    },
    staleTime: 5 * 60 * 1000,
    // A failed session read is not repeated on a timer; the next mount or
    // session change asks again.
    retry: false,
  });
}
