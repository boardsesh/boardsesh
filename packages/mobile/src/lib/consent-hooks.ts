import { createContext, useContext, useSyncExternalStore } from 'react';
import { getConsentSnapshot, subscribeConsent, isProductAnalyticsGranted } from './consent-state';
import { isAnalyticsGranted } from '@boardsesh/consent';

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
