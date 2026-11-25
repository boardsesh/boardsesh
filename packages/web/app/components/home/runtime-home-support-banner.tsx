'use client';

import React, { useEffect, useState } from 'react';
import { useMarketingCapabilities } from '../marketing/marketing-capabilities-context';
import { isSupportBannerWindow } from './support-banner-window';

/** Runtime payment configuration must not become a build-time eligibility decision. */
export default function RuntimeHomeSupportBanner() {
  const [inWindow, setInWindow] = useState(false);
  const [visit, setVisit] = useState(0);
  const eligible = useMarketingCapabilities()?.hasMonthlySupport === true && inWindow;
  const [Banner, setBanner] = useState<React.ComponentType | null>(null);
  useEffect(() => {
    const refresh = () => {
      setInWindow(isSupportBannerWindow(new Date()));
      setVisit((previousVisit) => previousVisit + 1);
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const visibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener('pageshow', pageShow);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      window.removeEventListener('pageshow', pageShow);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, []);
  useEffect(() => {
    if (!eligible || Banner || !isSupportBannerWindow(new Date())) return;
    let mounted = true;
    void import('./home-support-banner')
      .then(({ default: SupportBanner }) => {
        if (mounted) setBanner(() => SupportBanner);
      })
      .catch(() => {
        // Optional support UI can retry on the next visit after a chunk outage.
      });
    return () => {
      mounted = false;
    };
  }, [eligible, visit, Banner]);
  return eligible && Banner && isSupportBannerWindow(new Date()) ? <Banner key={visit} /> : null;
}
