import type { InstallPlatform } from './hero-install';

export type MarketingPlatform = 'ios' | 'android';
export type MarketingBrowser = {
  platform: MarketingPlatform;
  desktop: boolean;
  installPlatform: InstallPlatform;
};

/** Same classifier on the server and browser; touch points refine iPadOS only. */
export function classifyMarketingBrowser(userAgent: string, maxTouchPoints = 0): MarketingBrowser {
  if (/Android|Silk|Kindle/i.test(userAgent)) {
    return { platform: 'android', desktop: false, installPlatform: 'android-web' };
  }
  const appleMobile =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && (/Mobile/i.test(userAgent) || maxTouchPoints > 1));
  if (appleMobile) return { platform: 'ios', desktop: false, installPlatform: 'other-web' };
  if (/Mobile/i.test(userAgent)) return { platform: 'android', desktop: false, installPlatform: 'android-web' };
  return {
    platform: /Macintosh|Mac OS X/i.test(userAgent) ? 'ios' : 'android',
    desktop: true,
    installPlatform: 'desktop-web',
  };
}
