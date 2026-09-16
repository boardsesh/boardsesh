import { requireOptionalNativeModule } from 'expo-modules-core';

export type StorefrontNativeModule = {
  /**
   * ISO 3166-1 alpha-3 country of the signed-in Apple Account's App Store
   * storefront ("USA", "GBR", "NLD") — alpha-3, not alpha-2. Resolves null when
   * StoreKit has no storefront to report (no signed-in Apple Account, or a
   * simulator build with no StoreKit configuration).
   */
  getCountryCode(): Promise<string | null>;
};

// requireOptionalNativeModule returns null (silently) when the module isn't
// linked into the running binary — Android (this module is iOS-only), Expo Go,
// or a binary built before this module existed — so callers never need a
// platform/linked check before calling.
export const storefrontNative = requireOptionalNativeModule<StorefrontNativeModule>('Storefront');

/**
 * The App Store storefront country, or null when it can't be determined.
 *
 * Null means "unknown", never "allowed": it covers Android, Expo Go, every
 * binary shipped before this module landed, and a device with no signed-in
 * Apple Account. Gate storefront-restricted surfaces on an explicit country
 * match so that all of those stay hidden.
 */
export async function getStorefrontCountryCode(): Promise<string | null> {
  if (!storefrontNative) {
    return null;
  }
  return (await storefrontNative.getCountryCode()) ?? null;
}
