import { beforeEach, describe, expect, it } from 'vitest';
import { grantAnalyticsForTest } from '../../../test/consent-fixture';
import { getConsentSnapshot, invalidateConsentAccount, updateConsentState } from '../consent-state';
import {
  getPosthogFlagAuthority,
  isPosthogFlagBagCurrent,
  isPosthogFlagAuthorityCurrent,
  isPosthogFlagResponseCurrent,
  ownedPosthogFlagDetails,
  rememberPosthogFlagResponse,
  setPosthogFlagAuthority,
  subscribePosthogFlagAuthority,
} from '../posthog-flag-authority';

beforeEach(() => {
  grantAnalyticsForTest();
  updateConsentState({ authEpoch: getConsentSnapshot().authEpoch + 1 });
  setPosthogFlagAuthority(null);
});

function cachedClient(contents: Record<string, unknown>) {
  return { getPersistedProperty: <T>() => contents as T };
}

describe('functional flag cache ownership', () => {
  it('revokes anonymous freshness and notifies before the flag identity setter follows the account', () => {
    const anonymousAuthority = getPosthogFlagAuthority();
    rememberPosthogFlagResponse(anonymousAuthority, { requestId: 'anonymous-response' });
    expect(isPosthogFlagResponseCurrent('anonymous-response')).toBe(true);
    const observedFreshness: boolean[] = [];
    const unsubscribe = subscribePosthogFlagAuthority(() => {
      observedFreshness.push(isPosthogFlagResponseCurrent('anonymous-response'));
    });
    try {
      updateConsentState({ accountId: 'account-a' });
      expect(observedFreshness).toEqual([false]);
      expect(isPosthogFlagAuthorityCurrent(anonymousAuthority)).toBe(false);
      const pendingIdentityAuthority = getPosthogFlagAuthority();
      rememberPosthogFlagResponse(pendingIdentityAuthority, { requestId: 'pending-identity-response' });
      expect(isPosthogFlagResponseCurrent('pending-identity-response')).toBe(false);
      expect(ownedPosthogFlagDetails({ requestId: 'pending-identity-response', flags: {} }, undefined)).toBeUndefined();
      setPosthogFlagAuthority('account-a');
      rememberPosthogFlagResponse(getPosthogFlagAuthority(), { requestId: 'account-a-response' });
      expect(isPosthogFlagResponseCurrent('account-a-response')).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('never makes an unsettled cached-profile response fresh', () => {
    const anonymousAuthority = getPosthogFlagAuthority();
    rememberPosthogFlagResponse(anonymousAuthority, { requestId: 'settled-anonymous' });
    const observedFreshness: boolean[] = [];
    const unsubscribe = subscribePosthogFlagAuthority(() => {
      observedFreshness.push(isPosthogFlagResponseCurrent('settled-anonymous'));
    });
    try {
      updateConsentState({ authSettled: false });
      expect(observedFreshness).toEqual([false]);
      expect(isPosthogFlagAuthorityCurrent(anonymousAuthority)).toBe(false);
      updateConsentState({ accountId: 'cached-account-a' });
      setPosthogFlagAuthority('cached-account-a');
      rememberPosthogFlagResponse(getPosthogFlagAuthority(), { requestId: 'unsettled-profile-response' });
      expect(isPosthogFlagResponseCurrent('unsettled-profile-response')).toBe(false);
      expect(isPosthogFlagBagCurrent(cachedClient({ boardseshFlagAccountId: 'cached-account-a' }))).toBe(false);
      updateConsentState({ authSettled: true });
      expect(isPosthogFlagResponseCurrent('unsettled-profile-response')).toBe(false);
      rememberPosthogFlagResponse(getPosthogFlagAuthority(), { requestId: 'resolved-account-response' });
      expect(isPosthogFlagResponseCurrent('resolved-account-response')).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('retains this account cache offline without treating it as a fresh off decision', () => {
    updateConsentState({ authSettled: true, accountId: 'account-a' });
    setPosthogFlagAuthority('account-a');
    const cached = cachedClient({
      boardseshFlagAccountId: 'account-a',
      requestId: 'previous-launch',
      flags: { 'early-updates': false },
    });
    expect(isPosthogFlagBagCurrent(cached)).toBe(true);
    expect(isPosthogFlagResponseCurrent('previous-launch')).toBe(false);
    updateConsentState({ authSettled: false });
    expect(isPosthogFlagBagCurrent(cached)).toBe(false);
    updateConsentState({ authSettled: true });
    updateConsentState({ accountId: 'account-b' });
    setPosthogFlagAuthority('account-b');
    expect(isPosthogFlagBagCurrent(cached)).toBe(false);
  });

  it('never reuses an anonymous cache for an authenticated account', () => {
    const cached = cachedClient({ boardseshFlagAccountId: null, requestId: 'anonymous-response', flags: {} });
    expect(isPosthogFlagBagCurrent(cached)).toBe(true);
    updateConsentState({ authSettled: true, accountId: 'account-a' });
    setPosthogFlagAuthority('account-a');
    expect(isPosthogFlagBagCurrent(cached)).toBe(false);
  });

  it('does not infer an unknown legacy bag owner from the SDK account identity', () => {
    updateConsentState({ authSettled: true, accountId: 'account-a' });
    expect(isPosthogFlagBagCurrent(cachedClient({ requestId: 'unknown-owner', flags: {} }))).toBe(false);
  });

  it('invalidates live freshness on auth changes even if the next login uses the same account', () => {
    updateConsentState({ authSettled: true, accountId: 'account-a' });
    setPosthogFlagAuthority('account-a');
    rememberPosthogFlagResponse(getPosthogFlagAuthority(), { requestId: 'current-account' });
    expect(isPosthogFlagResponseCurrent('current-account')).toBe(true);
    invalidateConsentAccount();
    updateConsentState({ authSettled: true, accountId: 'account-a' });
    expect(isPosthogFlagResponseCurrent('current-account')).toBe(false);
  });

  it('preserves cache ownership when the SDK re-emits it after a network failure', () => {
    const previous = { flags: {}, boardseshFlagAccountId: 'account-a', requestId: 'previous-launch' };
    expect(ownedPosthogFlagDetails({ flags: {}, requestError: { type: 'network_error' } }, previous)).toEqual({
      flags: {},
      requestError: { type: 'network_error' },
      boardseshFlagAccountId: 'account-a',
    });
  });
});
