'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { classifyMarketingBrowser, type MarketingBrowser, type MarketingPlatform } from '@/app/lib/marketing-platform';

type MarketingPreviewState = {
  browser: MarketingBrowser;
  platform: MarketingPlatform;
  isPlatformResolved: boolean;
  selectPlatform: (platform: MarketingPlatform) => void;
};

const MarketingPreviewContext = createContext<MarketingPreviewState | null>(null);

export function useMarketingPreview() {
  return useContext(MarketingPreviewContext);
}

/** Lives in the site layout so a deliberate preview choice survives navigation. */
export function MarketingPreviewProvider({
  initialBrowser,
  sharedHtml = false,
  children,
}: {
  initialBrowser: MarketingBrowser;
  sharedHtml?: boolean;
  children: React.ReactNode;
}) {
  const [browser, setBrowser] = useState(initialBrowser);
  const [platform, setPlatform] = useState(initialBrowser.platform);
  const [isPlatformResolved, setIsPlatformResolved] = useState(!sharedHtml);
  const hasSelection = useRef(false);
  const selectPlatform = useCallback((selectedPlatform: MarketingPlatform) => {
    hasSelection.current = true;
    setPlatform(selectedPlatform);
  }, []);

  useEffect(() => {
    const detectedBrowser = classifyMarketingBrowser(navigator.userAgent, navigator.maxTouchPoints);
    setBrowser(detectedBrowser);
    if (!hasSelection.current) setPlatform(detectedBrowser.platform);
    setIsPlatformResolved(true);
  }, []);

  const preview = useMemo(
    () => ({ browser, platform, isPlatformResolved, selectPlatform }),
    [browser, platform, isPlatformResolved, selectPlatform],
  );
  return <MarketingPreviewContext.Provider value={preview}>{children}</MarketingPreviewContext.Provider>;
}
