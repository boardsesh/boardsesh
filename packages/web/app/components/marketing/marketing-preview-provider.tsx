'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { classifyMarketingBrowser, type MarketingBrowser, type MarketingPlatform } from '@/app/lib/marketing-platform';

type MarketingPreviewState = {
  browser: MarketingBrowser;
  platform: MarketingPlatform;
  selectPlatform: (platform: MarketingPlatform) => void;
};

const MarketingPreviewContext = createContext<MarketingPreviewState | null>(null);

export function useMarketingPreview() {
  return useContext(MarketingPreviewContext);
}

/** Lives in the site layout so a deliberate preview choice survives navigation. */
export function MarketingPreviewProvider({
  initialBrowser,
  children,
}: {
  initialBrowser: MarketingBrowser;
  children: React.ReactNode;
}) {
  const [browser, setBrowser] = useState(initialBrowser);
  const [platform, setPlatform] = useState(initialBrowser.platform);
  const hasSelection = useRef(false);
  const selectPlatform = useCallback((selectedPlatform: MarketingPlatform) => {
    hasSelection.current = true;
    setPlatform(selectedPlatform);
  }, []);

  useEffect(() => {
    const detectedBrowser = classifyMarketingBrowser(navigator.userAgent, navigator.maxTouchPoints);
    setBrowser(detectedBrowser);
    if (!hasSelection.current) setPlatform(detectedBrowser.platform);
  }, []);

  const preview = useMemo(() => ({ browser, platform, selectPlatform }), [browser, platform, selectPlatform]);
  return <MarketingPreviewContext.Provider value={preview}>{children}</MarketingPreviewContext.Provider>;
}
