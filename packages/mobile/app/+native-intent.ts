import { getShareExtensionKey } from 'expo-share-intent';

// Expo Router's redirect hook for OS-level deep links. The iOS Share Extension
// (expo-share-intent) opens the app via a synthetic `com.boardsesh.app://...
// dataUrl=<key>` URL; without this redirect Expo Router treats that as an
// unmatched route and shows +not-found. Send it to the home route — the
// ShareTargetProvider then reads the shared link from the native module and
// routes on to /share-beta after auth + URL validation. Android delivers shares
// through an ACTION_SEND intent (no deep-link path), so it falls through here
// unchanged and the provider handles it the same way.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  // The browser-OAuth fallback (signInWithProviderWeb) redirects to
  // com.boardsesh.app://auth/callback?… On Android that redirect arrives as a real
  // OS deep link *in addition to* being captured by openAuthSessionAsync's own
  // Linking listener, and the fallback handler already owns the result inline (token
  // exchange on success, a translated error on the login/register screen on
  // failure). If Expo Router also routes it, the unmatched path hits +not-found and
  // redirects to home — tearing the auth screen down before the error can show.
  // Return '' so Expo Router skips that navigation: success still lands on home (the
  // auth state flips and the root layout redirects), and failure surfaces on the
  // still-mounted screen — exactly how iOS behaves, where ASWebAuthenticationSession
  // consumes the redirect and it never becomes a deep link. The fallback only runs
  // with the app foregrounded, so this is always a warm intent; a stale cold-start
  // intent (initial) falls through to the app's normal initial route.
  if (path.includes('auth/callback')) {
    return '';
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
