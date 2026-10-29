/**
 * Whether this install may show a tappable donation link.
 *
 * App-store rules make an external donation link a rejection risk almost
 * everywhere. The one exception we act on is the iOS US storefront (external
 * purchase links allowed since May 2025). Android never gets a link: Google
 * threatened AnkiDroid with removal over a donation link in Aug–Oct 2026, and
 * Play exposes no storefront for the app to check a country against, so a
 * flag-only gate there would make PostHog targeting the sole compliance
 * boundary. Everywhere else the compliant surface is UNLINKED text that merely
 * names the website — the pattern StreetComplete ships and Google sanctions.
 *
 * So this predicate fails closed in every direction: unknown region, unresolved
 * flag, missing native module and Expo Go all read as "not allowed", and the
 * screen renders plain text with no tap target. Being wrong in the other
 * direction costs a store rejection; being wrong this way costs a link.
 *
 * Two independent gates, both required:
 *
 * - The `donation-links-v2` PostHog flag, read as `=== true`. It is the kill
 *   switch, nothing more: the code below enforces the platform and the region.
 *   The `-v2` is load-bearing. Android bundles from before #7057 read the old
 *   `donation-links` key and show the link whenever it is on, so that key must
 *   never exist in PostHog, and this one is read only by bundles that carry the
 *   Android hard-off below.
 * - The iOS App Store storefront country, which only the device knows. Binaries
 *   without the native module (#5522) get null from `requireOptionalNativeModule`
 *   and stay on the unlinked fallback. That is the designed degradation.
 *
 * Admin accounts are the one exception, for QA: an admin sees the link on iOS
 * in any storefront and on Android, so the link and its tap event can be
 * checked on our own phones from Australia. App Review never signs in as an
 * admin, and the only admin is the maintainer. It still needs the flag on, so
 * the kill switch covers it, and screenshot mode still wins. `useIsAdmin`
 * fails closed: signed out, loading or an error all read as not admin.
 *
 * Screenshot mode always reads "not allowed", so App Store captures and the
 * replayed screenshot fixtures never show a donation ask.
 *
 * The Expo browser app (`Platform.OS === 'web'`, served at /app) always reads
 * "allowed", flag or no flag. It is a web page, not a store binary, so no store
 * policy applies to it — the same reason boardsesh.com links /support from every
 * page. The flag cannot stand in for it either: it is targeted to OS = iOS, so a
 * browser would never see it on. Screenshot mode still wins there.
 *
 * The storefront country is read ONCE per app run, by design. Changing the
 * Apple Account region mid-session therefore keeps the cached answer until the
 * next relaunch — acceptable in both directions, since the stale answer is
 * either the compliant fallback or a link the device was entitled to minutes
 * ago, and the alternative is a native round-trip on every render.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useFeatureFlag } from '../providers/feature-flags-provider';
import { useIsAdmin } from './graphql/hooks/use-is-admin';

type StorefrontNativeModule = {
  /** The App Store storefront country as a StoreKit alpha-3 code, or null. */
  getCountryCode(): Promise<string | null>;
};

// Null on every binary shipped today, on Android, and in Expo Go. Probed once at
// module scope, the same way dev-launcher.ts and the health-workouts module do
// (all of them via expo-modules-core, which is where the helper lives).
const storefrontNative = requireOptionalNativeModule<StorefrontNativeModule>('Storefront');

/** StoreKit reports storefronts as ISO alpha-3; the US one is `USA`. */
const US_STOREFRONT_COUNTRY = 'USA';

/** The canonical donation surface — where the CTA goes when links are allowed. */
export const SUPPORT_URL = 'https://www.boardsesh.com/support';

/** Every in-app place a tappable support link can sit. */
export type SupportLinkSurface = 'acknowledgements' | 'account' | 'home-card';

/**
 * Which way of giving the climber picked, where a surface offers both (the Home
 * card). The support page reads it to start on that option; it never changes
 * what the page lets them do.
 */
export type SupportCadence = 'monthly' | 'once';

/**
 * The support page with the tapping surface in `src`, so a visit (and, once the
 * page forwards it, a payment) can be traced back to the screen that sent it.
 */
export function supportUrlFor(surface: SupportLinkSurface, cadence?: SupportCadence): string {
  const url = `${SUPPORT_URL}?src=app-${surface}`;
  return cadence ? `${url}&cadence=${cadence}` : url;
}

/**
 * The same address as the fallback copy says it out loud: bare, so a reader can
 * type it, and identical in every locale. Interpolated into `supportFallback`
 * rather than written into four catalogs, so the address has one home.
 */
export const SUPPORT_URL_DISPLAY = 'boardsesh.com/support';

// Both of these live for the app's lifetime on purpose — one native read per
// run, shared by every caller. They are module state, so a test that needs a
// different storefront must `vi.resetModules()` and re-import rather than
// expecting a fresh cache; see donation-links.test.ts.
let storefrontCountryPromise: Promise<string | null> | null = null;
// The resolved answer, kept beside the promise so a remount can read it
// synchronously. Without it, leaving Acknowledgements and coming back would
// start every visit on the fallback text and flip to the button a frame later.
let resolvedStorefrontCountry: string | null = null;

/**
 * The App Store storefront country, resolved once per app run.
 *
 * Cached as a promise rather than a value so concurrent callers share one native
 * round-trip and no render path ever triggers a second one.
 *
 * The try/await sits INSIDE an async function rather than being a `.catch()` on
 * the call, because the two failures are different shapes. A rejection is a
 * StoreKit that answered unhappily; a synchronous `TypeError` is a native proxy
 * whose `getCountryCode` was renamed or never existed — and that one would
 * escape a trailing `.catch()`, travel up through the effect, and take the
 * screen down. A module we cannot call is exactly the "unknown region" case
 * this file exists to answer with null.
 */
function readStorefrontCountry(): Promise<string | null> {
  if (!storefrontNative) return Promise.resolve(null);
  storefrontCountryPromise ??= (async () => {
    try {
      return await storefrontNative.getCountryCode();
    } catch {
      return null;
    }
  })().then((country) => {
    resolvedStorefrontCountry = country;
    return country;
  });
  return storefrontCountryPromise;
}

/**
 * Whether a tappable donation link may be rendered on this install.
 *
 * Deliberately does NOT wait on `useFeatureFlagsResolved`: the default render is
 * already the safe one, so there is nothing to protect against an unresolved
 * first frame. The link simply appears a beat later where it is allowed.
 */
export function useDonationLinksAllowed(): boolean {
  const flagEnabled = useFeatureFlag('donation-links-v2') === true;
  // Only asked once the flag is on, so a killed flag costs no request.
  const { isAdmin } = useIsAdmin({ enabled: flagEnabled });
  // Seeded from the module-level answer, which is null until the first read
  // lands. So the very first mount of the app starts on the fallback and every
  // later one starts on the truth — and "not read yet" and "not the US" are the
  // same answer anyway, so neither needs a special case.
  const [storefrontCountry, setStorefrontCountry] = useState<string | null>(resolvedStorefrontCountry);

  useEffect(() => {
    if (!flagEnabled || Platform.OS !== 'ios') return;
    let mounted = true;
    void readStorefrontCountry().then((country) => {
      if (mounted) setStorefrontCountry(country);
    });
    return () => {
      mounted = false;
    };
  }, [flagEnabled]);

  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  // The Expo browser app: no store, so no store rule (see the header).
  if (Platform.OS === 'web') return true;
  if (!flagEnabled) return false;
  // QA: the maintainer's admin account, on a phone, whatever the region.
  if (isAdmin && (Platform.OS === 'ios' || Platform.OS === 'android')) return true;
  if (Platform.OS === 'ios') return storefrontCountry === US_STOREFRONT_COUNTRY;
  // Android: never, whatever the flag says (see the header). Anything else: no
  // way to know the reader's region. Stay on the unlinked copy.
  return false;
}
