'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { hydrate, QueryClient, type Query, useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useSession } from 'next-auth/react';
import { revokeWebPrivacySnapshots } from '@/app/lib/privacy-client';
import { CNC_CONFIGURATOR_DRAFT_KEY } from '@/app/build-plans/configurator/draft-key';
import { createIdbPersister, PERSIST_MAX_AGE_MS } from '@/app/lib/react-query-idb-persister';
import { removePreference } from '@/app/lib/user-preferences-db';
import { browserSessionGuard, shouldRetryQuery } from '@/app/lib/auth/session-guard';

type QueryClientProviderProps = {
  children: ReactNode;
};

// The persisted blob is tagged with the account that wrote it
// (react-query-idb-persister.ts), so the buster stays constant.
const PERSIST_BUSTER = '';

export default function QueryClientProvider({ children }: QueryClientProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
            // A request superseded by an account change is tried once more, not three times.
            retry: shouldRetryQuery,
          },
        },
      }),
  );

  const [persister] = useState(() =>
    createIdbPersister({
      // The checks persistQueryClientRestore makes before it hydrates.
      restoreLate: (persisted) => {
        if (!persisted.timestamp || Date.now() - persisted.timestamp > PERSIST_MAX_AGE_MS) return;
        if (persisted.buster !== PERSIST_BUSTER) return;
        hydrate(queryClient, persisted.clientState);
      },
    }),
  );
  // A page retiring after another tab's account change wipes before it reloads.
  useEffect(
    () => browserSessionGuard().registerCleanup(() => clearViewerState(queryClient, persister)),
    [queryClient, persister],
  );
  // Reads useSession(), so this provider must mount inside SessionProviderWrapper.
  // See app/layout.tsx for the nesting order.
  const { data: session } = useSession();
  const sessionUserId = session?.user?.id ?? null;

  const [persistOptions] = useState(() => ({
    persister,
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions: {
      shouldDehydrateQuery: (query: Query) => query.meta?.persist === true && query.state.status === 'success',
    },
  }));

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <SessionCacheBuster persister={persister} sessionUserId={sessionUserId} />
      {children}
    </PersistQueryClientProvider>
  );
}

type IdbPersister = ReturnType<typeof createIdbPersister>;

/** Every query, the persisted blob and the build-plans draft belong to one account. */
function clearViewerState(queryClient: QueryClient, persister: IdbPersister): Promise<unknown> {
  // Every query may contain viewer-specific authorization, even when it is
  // not persisted. Cancel before clearing to reject old-account responses.
  const memory = queryClient.cancelQueries().then(() => {
    void revokeWebPrivacySnapshots(queryClient);
    queryClient.clear();
  });
  // The persister already swallows IDB errors internally, but log anything
  // that escapes so a failed wipe is observable instead of silent.
  // removeClient() is typed as Promisable<void>, so wrap to normalise.
  const persisted = Promise.resolve(persister.removeClient()).catch((error: unknown) => {
    console.error('Failed to clear persisted react-query cache on session change:', error);
  });
  // The in-progress build-plans draft (a buyer's name and email) lives in
  // IndexedDB outside the React Query cache, but it is exactly the same kind
  // of per-user state: it must not survive into the next signed-out visitor
  // or the next account on this browser. `removePreference` swallows its own
  // errors.
  return Promise.all([memory, persisted, removePreference(CNC_CONFIGURATOR_DRAFT_KEY)]);
}

type SessionCacheBusterProps = {
  persister: IdbPersister;
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

    void clearViewerState(queryClient, persister);
  }, [queryClient, persister, sessionUserId]);

  return null;
}
