import { beforeEach, describe, expect, it } from 'vitest';
import { grantAnalyticsForTest } from '../../../test/consent-fixture';
import { getConsentSnapshot, invalidateConsentAccount, updateConsentState } from '../consent-state';
import {
  getPosthogFlagAuthority,
  isPosthogFlagBagCurrent,
  isPosthogFlagResponseCurrent,
  ownedPosthogFlagDetails,
  rememberPosthogFlagResponse,
  setPosthogFlagAuthority,
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
