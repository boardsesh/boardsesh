import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantAnalyticsForTest, grantedConsent } from '../../../test/consent-fixture';
import { AUTH_CONVERSION_WAIT_MS, createConsentBoundAnalyticsRunner } from '../consent-bound-analytics';
import { invalidateConsentAccount, updateConsentState } from '../consent-state';

beforeEach(() => {
  vi.useFakeTimers();
  grantAnalyticsForTest();
  invalidateConsentAccount();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function resolveAccount(accountId = 'new-account') {
  updateConsentState({ authSettled: true, accountResolved: true, accountId, sdkReady: true });
}

describe('consented authentication conversions', () => {
  it('waits for account consent and SDK identity, then emits exactly once', () => {
    const capture = vi.fn();
    const captureWhenReady = createConsentBoundAnalyticsRunner();
    captureWhenReady(capture);
    updateConsentState({ authSettled: true, accountId: 'new-account', accountResolved: false });
    expect(capture).not.toHaveBeenCalled();
    updateConsentState({ accountResolved: true });
    expect(capture).not.toHaveBeenCalled();
    updateConsentState({ sdkReady: true });
    expect(capture).toHaveBeenCalledOnce();
    resolveAccount();
    expect(capture).toHaveBeenCalledOnce();
  });

  it('discards queued and late profile conversions after an account replacement', () => {
    const captureWhenReady = createConsentBoundAnalyticsRunner();
    const capture = vi.fn();
    captureWhenReady(capture);
    invalidateConsentAccount();
    resolveAccount('other-account');
    captureWhenReady(capture);
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not revive a conversion after withdrawal followed by Allow', () => {
    const captureWhenReady = createConsentBoundAnalyticsRunner();
    const capture = vi.fn();
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
    updateConsentState({ record: grantedConsent });
    resolveAccount();
    captureWhenReady(capture);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each(['denied', 'unanswered'] as const)('never buffers a previously %s conversion', (choice) => {
    updateConsentState({ record: choice === 'denied' ? { ...grantedConsent, analytics: 'denied' } : null });
    const captureWhenReady = createConsentBoundAnalyticsRunner();
    const capture = vi.fn();
    grantAnalyticsForTest();
    captureWhenReady(capture);
    expect(capture).not.toHaveBeenCalled();
  });

  it('bounds waiting when account consent never resolves', () => {
    const captureWhenReady = createConsentBoundAnalyticsRunner();
    const capture = vi.fn();
    captureWhenReady(capture);
    vi.advanceTimersByTime(AUTH_CONVERSION_WAIT_MS);
    resolveAccount();
    expect(capture).not.toHaveBeenCalled();
  });

  it('drops pending conversions when the emergency kill switch activates', () => {
    const captureWhenReady = createConsentBoundAnalyticsRunner();
    const capture = vi.fn();
    captureWhenReady(capture);
    updateConsentState({ killed: true });
    updateConsentState({ killed: false });
    resolveAccount();
    expect(capture).not.toHaveBeenCalled();
  });
});
