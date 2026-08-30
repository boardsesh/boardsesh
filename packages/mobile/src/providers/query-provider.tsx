import { useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  MutationCache,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { reportHandledError } from '../lib/error-reporting';
import { isGraphqlRateLimitedError } from '../lib/graphql/extract-error-message';
import { isNetworkAllowed, subscribeNetworkPolicy } from '../lib/network-policy';

// React Query keys `refetchOnReconnect` / `refetchOnWindowFocus` off a browser's
// `navigator.onLine` and window-focus events, neither of which exists on React
// Native — so without these bridges it treats the app as permanently online and
// focused and neither refetch ever fires. Both `onlineManager` and
// `focusManager` are process-wide singletons, wired once here at module load
// (the canonical Expo offline-support pattern). A single root QueryProvider
// lives for the whole app, so there's nothing to tear down.
//
// NetInfo is a native module; the fingerprint runtimeVersion policy gates the
// OTA so a binary running this JS has the matching native module compiled in.
onlineManager.setEventListener((setOnline) => {
  let deviceIsOnline = true;
  const publishEffectiveState = () => setOnline(deviceIsOnline && isNetworkAllowed('backend'));
  // Seed the current state up front: onlineManager defaults to online and would
  // otherwise stay there until the first NetInfo change event arrives. Combined
  // with `networkMode: 'offlineFirst'` below, a wrong/late offline signal can
  // no longer strand the initial fetch.
  void NetInfo.fetch()
    .then((state) => {
      deviceIsOnline = state.isConnected ?? true;
      publishEffectiveState();
    })
    .catch(() => {
      // A failed seed leaves the default (online); the live listener below
      // still delivers real state, so there's nothing actionable to report.
    });
  const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    deviceIsOnline = state.isConnected ?? true;
    publishEffectiveState();
  });
  const unsubscribePolicy = subscribeNetworkPolicy(publishEffectiveState);
  publishEffectiveState();
  return () => {
    unsubscribeNetInfo();
    unsubscribePolicy();
  };
});

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
        retry: (failureCount, error) => {
          if (isGraphqlRateLimitedError(error)) return false;
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
