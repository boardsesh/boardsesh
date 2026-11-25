'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserSessionContext } from '../providers/session-provider';
import { shouldRetryQuery } from '@/app/lib/auth/session-guard';
import { useMarketingSession } from './marketing-session-store';
import { registerMarketingQueryCleanup } from './marketing-query-cleanup';

// This module is loaded only for authenticated consent or a visible beta rail.
// Both islands dedupe token requests in memory; neither restores the application cache.
let client: QueryClient | undefined;
function marketingQueryClient(): QueryClient {
  if (!client) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetryQuery, refetchOnWindowFocus: false } },
    });
    client = queryClient;
    registerMarketingQueryCleanup(() => {
      const cancelled = queryClient.cancelQueries();
      queryClient.clear();
      return cancelled;
    });
  }
  return client;
}
export default function MarketingQueryProvider({ children }: { children: React.ReactNode }) {
  const { session } = useMarketingSession();
  const [queryClient] = useState(marketingQueryClient);
  return (
    <BrowserSessionContext.Provider value={session}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </BrowserSessionContext.Provider>
  );
}
