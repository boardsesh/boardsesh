import { updateConsentState } from '../src/lib/consent-state';
import type { ConsentRecord } from '@boardsesh/consent';
export const grantedConsent: ConsentRecord = {
  analytics: 'granted',
  version: 1,
  decidedAt: '2026-10-08T12:00:00.123Z',
  source: 'ios',
};
export function grantAnalyticsForTest(): void {
  updateConsentState({
    record: grantedConsent,
    loaded: true,
    settled: true,
    authSettled: true,
    accountResolved: true,
    accountId: null,
    sdkReady: true,
    flagsResolved: true,
    killed: false,
  });
}
