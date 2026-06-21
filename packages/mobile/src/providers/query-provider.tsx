import { useState, type ReactNode } from 'react';
import { QueryCache, QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import { reportHandledError } from '../lib/error-reporting';

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
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        retry: 2,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
