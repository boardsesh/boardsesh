'use client';

import { createContext, useContext } from 'react';
import type { MarketingRuntimeCapabilities } from '@/app/lib/marketing-runtime-capabilities';

export const MarketingCapabilitiesContext = createContext<MarketingRuntimeCapabilities | null>(null);

export function useMarketingCapabilities() {
  return useContext(MarketingCapabilitiesContext);
}
