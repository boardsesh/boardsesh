export const IOS_APP_STORE_URL = 'https://apps.apple.com/app/boardsesh/id6761350784';
export const ANDROID_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.boardsesh.app';
export const ANDROID_SIDELOAD_URL = 'https://github.com/boardsesh/boardsesh/releases/latest';

// Native scheme URLs — open the App Store / Play Store app directly and land on
// the rate section, which https:// URLs cannot reliably do when surfaced via
// SFSafariViewController (iOS) or a Browser-plugin in-app view.
export const IOS_APP_STORE_SCHEME_URL = 'itms-apps://itunes.apple.com/app/id6761350784';
export const ANDROID_PLAY_STORE_SCHEME_URL = 'market://details?id=com.boardsesh.app';

export type Platform = 'ios' | 'android' | 'web';

/** URL that opens the store page in a browser (shareable, web-fallback-safe). */
export function storeHttpsUrlForPlatform(platform: Platform): string {
  if (platform === 'android') return ANDROID_PLAY_STORE_URL;
  return IOS_APP_STORE_URL;
}

/** URL that opens the native store app directly on device. Use inside a native app. */
export function storeSchemeUrlForPlatform(platform: Platform): string {
  switch (platform) {
    case 'android':
      return ANDROID_PLAY_STORE_SCHEME_URL;
    case 'ios':
      return IOS_APP_STORE_SCHEME_URL;
    case 'web':
      // Scheme URLs are only meaningful on native platforms; callers should
      // not invoke this with 'web'. Fall back to the https URL so we don't
      // open an itms-apps:// URL in a browser context.
      return IOS_APP_STORE_URL;
  }
}
