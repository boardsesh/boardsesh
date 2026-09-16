/**
 * Whether this install may show a tappable donation link.
 *
 * App-store rules make an external donation link a rejection risk almost
 * everywhere. The two exceptions we can act on are the iOS US storefront
 * (external purchase links allowed since May 2025) and, from 30 Sept 2026,
 * Android in Australia. Everywhere else the compliant surface is UNLINKED text
 * that merely names the website — the pattern StreetComplete ships and Google
 * sanctions.
 *
 * So this predicate fails closed in every direction: unknown region, unresolved
 * flag, missing native module and Expo Go all read as "not allowed", and the
 * screen renders plain text with no tap target. Being wrong in the other
 * direction costs a store rejection; being wrong this way costs a link.
 *
 * Two independent gates:
 *
 * - The `donation-links` PostHog flag, read as `=== true`. It carries the
 *   Android side of the targeting, because PostHog resolves country server-side
 *   from the request and the Play Store exposes no storefront API to the app.
 * - The iOS App Store storefront country, which only the device knows. The
 *   native module that reads it ships separately (it is a native change, so it
 *   rides the release train); until a binary containing it is installed,
 *   `requireOptionalNativeModule` returns null here and iOS stays on the
 *   unlinked fallback. That is the designed degradation, not a bug.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useFeatureFlag } from '../providers/feature-flags-provider';

type StorefrontNativeModule = {
  /** The App Store storefront country as a StoreKit alpha-3 code, or null. */
  getCountryCode(): Promise<string | null>;
};

// Null on every binary shipped today, on Android, and in Expo Go. Probed once at
// module scope, the same way dev-launcher.ts and the health-workouts module do.
const storefrontNative = requireOptionalNativeModule<StorefrontNativeModule>('Storefront');

/** StoreKit reports storefronts as ISO alpha-3; the US one is `USA`. */
const US_STOREFRONT_COUNTRY = 'USA';

/** The canonical donation surface. Also said, unlinked, in the fallback copy. */
export const SUPPORT_URL = 'https://www.boardsesh.com/support';

let storefrontCountryPromise: Promise<string | null> | null = null;

/**
 * The App Store storefront country, resolved once per app run.
 *
 * Cached as a promise rather than a value so concurrent callers share one native
 * round-trip and no render path ever triggers a second one. A rejection (module
 * present but StoreKit unhappy) resolves to null — unknown, therefore not
 * allowed.
 */
export function readStorefrontCountry(): Promise<string | null> {
  if (!storefrontNative) return Promise.resolve(null);
  storefrontCountryPromise ??= storefrontNative.getCountryCode().catch(() => null);
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
  const flagEnabled = useFeatureFlag('donation-links') === true;
  // Starts null — "not read yet" and "not the US" are both "not allowed", so the
  // first frame needs no special case.
  const [storefrontCountry, setStorefrontCountry] = useState<string | null>(null);

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

  if (!flagEnabled) return false;
  // Android's region targeting lives in PostHog; the flag alone is the answer.
  if (Platform.OS === 'android') return true;
  if (Platform.OS === 'ios') return storefrontCountry === US_STOREFRONT_COUNTRY;
  // Expo web and anything else: no store to be compliant with, but no way to
  // know the reader's region either. Stay on the unlinked copy.
  return false;
}
