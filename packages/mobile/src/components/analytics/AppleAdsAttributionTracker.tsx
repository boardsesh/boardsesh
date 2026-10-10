import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { createNativeAppleAdsAttributionController } from '../../lib/apple-ads-attribution';
import { subscribeConsent } from '../../lib/consent-state';
import { subscribeAnalyticsIdentity } from '../../lib/analytics-identity-events';
import { subscribeVerifiedAuthResult } from '../../lib/verified-auth-result';

export function AppleAdsAttributionTracker(): null {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const controller = createNativeAppleAdsAttributionController();
    const reconcile = () => {
      void controller.reconcile();
    };
    const unsubscribeConsent = subscribeConsent(reconcile);
    const unsubscribeIdentity = subscribeAnalyticsIdentity(reconcile);
    const unsubscribeAuth = subscribeVerifiedAuthResult(reconcile);
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') reconcile();
    });
    reconcile();
    return () => {
      controller.dispose();
      unsubscribeConsent();
      unsubscribeIdentity();
      unsubscribeAuth();
      foreground.remove();
    };
  }, []);
  return null;
}
