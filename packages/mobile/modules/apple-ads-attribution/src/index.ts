import { requireOptionalNativeModule } from 'expo-modules-core';

export type AppleAdsTokenResult = { status: 'available'; token: string } | { status: 'unavailable' | 'retryable' };

type AppleAdsAttributionModule = {
  getAttributionToken(): Promise<AppleAdsTokenResult>;
};

// Optional resolution keeps binaries built before 2.6.0, Android and Expo Go
// functional. No acquisition happens just by importing this module.
const nativeModule = requireOptionalNativeModule<AppleAdsAttributionModule>('AppleAdsAttribution');

export async function getAppleAdsAttributionToken(): Promise<AppleAdsTokenResult> {
  if (!nativeModule) return { status: 'unavailable' };
  try {
    return await nativeModule.getAttributionToken();
  } catch {
    // Native errors must never reach general-purpose error reporting.
    return { status: 'retryable' };
  }
}
