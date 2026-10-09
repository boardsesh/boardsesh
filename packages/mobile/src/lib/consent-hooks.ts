import { createContext, useContext, useSyncExternalStore } from 'react';
import { getConsentSnapshot, subscribeConsent, isProductAnalyticsGranted } from './consent-state';
import { isAnalyticsGranted } from '@boardsesh/consent';

export const ConsentSettledContext = createContext(false);
export function useConsentSettled(): boolean {
  return useContext(ConsentSettledContext);
}
export function useAnalyticsConsent(): boolean {
  useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  return isProductAnalyticsGranted();
}
export function useAnalyticsPreference(): boolean {
  return isAnalyticsGranted(useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot).record);
}
