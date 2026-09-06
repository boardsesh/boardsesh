import { useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { QueryCache, QueryClient, QueryClientProvider, MutationCache, focusManager } from '@tanstack/react-query';
import { reportHandledError } from '../lib/error-reporting';
import { isBackendUnavailableError } from '../lib/connectivity/backend-unavailable-error';
import { startConnectivityStore } from '../lib/connectivity/start-connectivity';
import { isGraphqlRateLimitedError } from '../lib/graphql/extract-error-message';
// From the leaf module, not `graphql/client`: the client statically imports the
// auth interceptor and the whole secure-store chain behind it, which has no
// business in the query provider's graph for a one-line predicate.
import { isGraphqlRequestTimeoutError } from '../lib/graphql/request-timeout';

// React Query keys `refetchOnReconnect` / `refetchOnWindowFocus` off a browser's
// `navigator.onLine` and window-focus events, neither of which exists on React
// Native — so without these bridges it treats the app as permanently online and
// focused and neither refetch ever fires. Both `onlineManager` and
// `focusManager` are process-wide singletons, wired once here at module load
// (the canonical Expo offline-support pattern). A single root QueryProvider
// lives for the whole app, so there's nothing to tear down.
//
// `onlineManager` is no longer wired to NetInfo from here. It sits DOWNSTREAM of
// the connectivity store now (issue #4862), which separates the three facts the
// old single `isConnected` boolean conflated — a network being attached, that
// network reaching the internet, and OUR backend answering — and writes the
// resulting one-bit answer into `onlineManager` from one place. That is what
// stops a backend outage reading as "online" and looking like a broken app.
// NetInfo, AppState and the onlineManager bridge are wired inside
// `startConnectivityStore()`.
//
// NetInfo is a native module; the fingerprint runtimeVersion policy gates the
// OTA so a binary running this JS has the matching native module compiled in.
startConnectivityStore();

if (Platform.OS !== 'web') {
  // Mirror onlineManager's setEventListener wiring so focusManager owns the
  // AppState subscription and tears it down on re-wire.
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (status) => {
      handleFocus(status === 'active');
    });
    return () => subscription.remove();
  });
}

// The serialized failing request, trimmed for triage. queryKey/mutationKey are
// the React Query identity (e.g. ['searchClimbs', params]); pulling them into
// PostHog lets us group `$exception`s by what failed without leaking payloads.
function toReportableKey(key: unknown): string {
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
}

// Pure reporters (exported for tests). reportHandledError drops cancellations
// and downgrades offline noise, so these stay signal-rich.
export function reportQueryFailure(error: unknown, queryKey: unknown, queryHash: string): void {
  reportHandledError(error, {
    tags: { source: 'react-query', kind: 'query' },
    extra: { queryKey: toReportableKey(queryKey), queryHash },
  });
}

export function reportMutationFailure(error: unknown, mutationKey: unknown): void {
  reportHandledError(error, {
    tags: { source: 'react-query', kind: 'mutation' },
    extra: { mutationKey: mutationKey === undefined ? null : toReportableKey(mutationKey) },
  });
}

// Every query/mutation failure flows through the cache onError once retries (see
// defaultOptions.retry) are exhausted — a single chokepoint so API / GraphQL /
// REST errors land in PostHog without instrumenting each call site.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => reportQueryFailure(error, query.queryKey, query.queryHash),
    }),
    mutationCache: new MutationCache({
      // Signature is (error, variables, onMutateResult, mutation, context); the
      // mutation is the 4th arg — that's all we need.
      onError: (error, _variables, _onMutateResult, mutation) =>
        reportMutationFailure(error, mutation.options.mutationKey),
    }),
    defaultOptions: {
      queries: {
        // `offlineFirst` runs the fetch once regardless of onlineManager status
        // (only retries pause while offline), so a wrong/late NetInfo offline
        // signal can't leave data screens stuck in `fetchStatus: 'paused'`.
        // refetchOnReconnect still fires when connectivity returns.
        networkMode: 'offlineFirst',
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        // Never retry a RATE_LIMITED rejection — retrying only hammers the
        // already-throttled endpoint harder (#3285). Everything else keeps
        // the previous retry-up-to-2-times behavior.
        //
        // The two #4862 additions are the same argument for a dead server. A
        // BackendUnavailableError never reached the network at all (the client
        // short-circuited on known-bad connectivity), so a retry can only
        // produce the identical local rejection two more times — and delay the
        // degraded UI by exactly that long. A request timeout is the backend
        // not answering within 20s, and the connectivity store's own backoff
        // ladder is already asking whether it is back; three 20s hangs per query
        // on top of that is how an outage turns into a frozen app.
        retry: (failureCount, error) => {
          if (isGraphqlRateLimitedError(error)) return false;
          if (isBackendUnavailableError(error)) return false;
          if (isGraphqlRequestTimeoutError(error)) return false;
          return failureCount < 2;
        },
      },
      mutations: {
        networkMode: 'offlineFirst',
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
