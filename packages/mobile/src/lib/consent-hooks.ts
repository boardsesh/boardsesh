import { createContext, useContext, useSyncExternalStore } from 'react';
import { getConsentSnapshot, subscribeConsent, isProductAnalyticsGranted } from './consent-state';
import { isAnalyticsGranted, isRegionDefaultConsent } from '@boardsesh/consent';

export const ConsentSettledContext = createContext(false);
export function useConsentSettled(): boolean {
  return useContext(ConsentSettledContext);
}
export function useAnalyticsConsent(): boolean {
  // Return the subscribed snapshot itself. A separate zero-argument getter is
  // memoized by React Compiler and freezes the initial (usually false) answer.
  return useSyncExternalStore(subscribeConsent, isProductAnalyticsGranted, isProductAnalyticsGranted);
}
export function useAnalyticsPreference(): boolean {
  return isAnalyticsGranted(useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot).record);
}
/** True while analytics is on only because this device is outside the prompt regions. */
export function useAnalyticsRegionDefault(): boolean {
  return isRegionDefaultConsent(useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot).record);
}
