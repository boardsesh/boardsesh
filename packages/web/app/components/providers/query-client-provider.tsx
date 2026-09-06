'use client';

import React, { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, type Query, useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useSession } from 'next-auth/react';
import { CNC_CONFIGURATOR_DRAFT_KEY } from '@/app/build-plans/configurator/configurator-state';
import { createIdbPersister, PERSIST_MAX_AGE_MS } from '@/app/lib/react-query-idb-persister';
import { removePreference } from '@/app/lib/user-preferences-db';

type QueryClientProviderProps = {
  children: ReactNode;
};

export default function QueryClientProvider({ children }: QueryClientProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [persister] = useState(() => createIdbPersister());
  // Reads useSession(), so this provider must mount inside SessionProviderWrapper.
  // See app/layout.tsx for the nesting order.
  const { data: session } = useSession();
  const sessionUserId = session?.user?.id ?? null;

  // No `buster` here: useSession() returns null on the first render of every
  // page load (status: loading), so any session-derived buster would discard
  // the persisted cache before the session resolves. Per-user isolation comes
  // from the query keys themselves (['profile', userId], etc.) — a different
  // user simply misses the cache because their keys don't exist in it.
  const persistOptions = useMemo(
    () => ({
      persister,
      maxAge: PERSIST_MAX_AGE_MS,
      dehydrateOptions: {
        shouldDehydrateQuery: (query: Query) => query.meta?.persist === true && query.state.status === 'success',
      },
    }),
    [persister],
  );

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <SessionCacheBuster persister={persister} sessionUserId={sessionUserId} />
      {children}
    </PersistQueryClientProvider>
  );
}

type SessionCacheBusterProps = {
  persister: ReturnType<typeof createIdbPersister>;
  sessionUserId: string | null;
};

// Wipe both the in-memory persisted queries and the IDB blob when the user
// transitions from one signed-in identity to another, or signs out — so the
// next render can't show one user a frame of another user's data.
//
// The ref is seeded `undefined` as a sentinel for "no transition observed
// yet", which lets us skip two non-transitions that would otherwise wipe a
// healthy cache on every hard reload:
//   - first effect after mount, no matter the session value
//   - the loading → authenticated transition (lastUserIdRef === null), which
//     fires on every page load while NextAuth resolves the session
export function SessionCacheBuster({ persister, sessionUserId }: SessionCacheBusterProps) {
  const queryClient = useQueryClient();
  const lastUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const previous = lastUserIdRef.current;
    lastUserIdRef.current = sessionUserId;

    if (previous === undefined) return;
    if (previous === sessionUserId) return;
    if (previous === null) return;

    queryClient.removeQueries({ predicate: (query) => query.meta?.persist === true });
    // The persister already swallows IDB errors internally, but log anything
    // that escapes so a failed sign-out wipe is observable instead of silent.
    // removeClient() is typed as Promisable<void>, so wrap to normalise.
    Promise.resolve(persister.removeClient()).catch((error: unknown) => {
      console.error('Failed to clear persisted react-query cache on session change:', error);
    });
    // The in-progress build-plans draft (a buyer's name and email) lives in
    // IndexedDB outside the React Query cache, but it is exactly the same kind
    // of per-user state: it must not survive into the next signed-out visitor
    // or the next account on this browser. `removePreference` swallows its own
    // errors, so this is fire-and-forget like the persister wipe above.
    void removePreference(CNC_CONFIGURATOR_DRAFT_KEY);
  }, [queryClient, persister, sessionUserId]);

  return null;
}
