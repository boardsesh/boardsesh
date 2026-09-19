'use client';

import { useEffect, useState } from 'react';
import { isNativeApp, isCapacitorWebView, waitForCapacitor } from '@/app/lib/ble/capacitor-utils';
import type { InstallPlatform, HeroInstallStore } from '@/app/lib/hero-install';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { useMarketingPreview } from '@/app/components/marketing/marketing-preview-provider';

export type InstallPlatformState = {
  platform: InstallPlatform;
  /**
   * Which store a legacy native straggler installed from, so an "update" CTA
   * points at the right place. Only meaningful once `platform === 'native'`,
   * and set in the same effect pass that flips it, so the `'ios'` seed is never
   * actually observed — it just keeps the state typed.
   */
  nativeStore: HeroInstallStore;
};

/**
 * Classifies which install CTA this visitor should see.
 *
 * Extracted from `home-page-content.tsx`, where it was the single biggest
 * reason the whole 536-line page had to be a client component: everything else
 * on it renders fine on the server.
 */
export function useInstallPlatform(): InstallPlatformState {
  const preview = useMarketingPreview();
  const [platform, setPlatform] = useState<InstallPlatform>(preview?.browser.installPlatform ?? 'unknown');
  const [nativeStore, setNativeStore] = useState<HeroInstallStore>(preview?.browser.platform ?? 'ios');

  useEffect(() => {
    let cancelled = false;
    const classifyWeb = (): InstallPlatform =>
      classifyMarketingBrowser(navigator.userAgent, navigator.maxTouchPoints).installPlatform;
    const classifyNativeStore = (): HeroInstallStore => (/Android/i.test(navigator.userAgent) ? 'android' : 'ios');

    // App-store screenshot tests set this flag so the install CTA matches what
    // users see in the actual iOS build (i.e. nothing).
    if (
      typeof window !== 'undefined' &&
      // oxlint-disable-next-line no-restricted-globals -- e2e flag must be read synchronously during render
      sessionStorage.getItem('boardsesh:e2e-suppress-install-card') === '1'
    ) {
      setPlatform('native');
      setNativeStore(classifyNativeStore());
      return;
    }

    if (isNativeApp()) {
      setPlatform('native');
      setNativeStore(classifyNativeStore());
      return;
    }

    // UA heuristic says we're in a Capacitor WebView but the bridge hasn't
    // injected window.Capacitor yet. Wait for it before classifying as web,
    // otherwise native users get stuck with install CTAs.
    if (isCapacitorWebView()) {
      waitForCapacitor()
        .then((appeared) => {
          if (cancelled) return;
          if (appeared && isNativeApp()) {
            setPlatform('native');
            setNativeStore(classifyNativeStore());
          } else {
            setPlatform(classifyWeb());
          }
        })
        .catch(() => {
          if (!cancelled) setPlatform(classifyWeb());
        });
      return () => {
        cancelled = true;
      };
    }

    setPlatform(classifyWeb());
  }, []);

  return { platform, nativeStore };
}
