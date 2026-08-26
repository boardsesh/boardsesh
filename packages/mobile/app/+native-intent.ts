import { getShareExtensionKey } from 'expo-share-intent';
import { isLegacyPreviewLink } from '../src/lib/legacy-preview-link';

// Expo Router's redirect hook for OS-level deep links. The iOS Share Extension
// (expo-share-intent) opens the app via a synthetic `com.boardsesh.app://...
// dataUrl=<key>` URL; without this redirect Expo Router treats that as an
// unmatched route and shows +not-found. Send it to the home route — the
// ShareTargetProvider then reads the shared link from the native module and
// routes on to /share-beta after auth + URL validation. Android delivers shares
// through an ACTION_SEND intent (no deep-link path), so it falls through here
// unchanged and the provider handles it the same way.

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  // The browser-OAuth fallback's Linking listener owns this deep link (see
  // src/lib/auth.ts raceBrowserSignIn); return '' so Expo Router doesn't flash
  // +not-found on the non-existent /auth/callback route under the browser. Safe:
  // vendored expo-router@57.0.3 gates navigation on a truthy path (warm subscribe
  // in build/link/linking.js, cold getInitialURL in build/getLinkingConfig.js).
  // `path` is the full deep-link URL (scheme + host); the bare-path form is a
  // defensive fallback. Checked before the share-intent branch — pure string ops
  // that can't throw — so a getShareExtensionKey() throw can't bypass it.
  if (path.startsWith('com.boardsesh.app://auth/callback') || path.startsWith('/auth/callback')) {
    return '';
  }
  // The retired custom OTA picker emitted /preview/pr-N links in PR comments.
  // New builds no longer have that route; land those durable links on What's
  // New while xprem's official edge marker remains the picker entry point.
  if (isLegacyPreviewLink(path)) {
    return '/changelog';
  }
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) {
      // Cold start (initial): bootstrap to the home route — the ShareTargetProvider
      // then opens /share-beta over it. Warm shares (the app already running): return
      // '' so Expo Router skips re-navigation. Returning '/' here re-fired the root
      // <Redirect href="/(tabs)/home">, re-mounting the whole Home tab tree (and its
      // feed queries) on EVERY share — the source of the sluggishness after a few
      // shares. The provider drives /share-beta off the native module either way, so
      // warm shares don't need a path redirect at all.
      return initial ? '/' : '';
    }
  } catch {
    // getShareExtensionKey() can throw off-native (web, tests, module not
    // loaded). Fall through to the no-op `return path` so ordinary deep links
    // (join/universal links) still reach their destination — never reroute them.
  }
  return path;
}
