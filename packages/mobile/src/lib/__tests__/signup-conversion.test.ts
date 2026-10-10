import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCreationReceipt } from '@boardsesh/analytics';
import { grantAnalyticsForTest, grantedConsent } from '../../../test/consent-fixture';
import { invalidateConsentAccount, updateConsentState } from '../consent-state';
import { commitVerifiedAuthResult } from '../verified-auth-result';
import { notifyAnalyticsIdentityChanged } from '../analytics-identity-events';

const analytics = vi.hoisted(() => ({ capture: vi.fn(() => true), setPersonProperties: vi.fn(), distinctId: '' }));
const preferences = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../analytics', () => ({
  capture: analytics.capture,
  setPersonProperties: analytics.setPersonProperties,
  getAnalyticsIdentity: () => ({ distinctId: analytics.distinctId, anonymousId: 'anonymous' }),
}));
vi.mock('../preference-store', () => ({
  getPreference: preferences.get,
  setPreference: preferences.set,
  removePreference: preferences.remove,
}));
import { createSignupConsentLease, forgetSignupConversion, publishSignupConversion } from '../signup-conversion';

let sequence = 0;
function receipt(provider: AccountCreationReceipt['provider'] = 'email'): AccountCreationReceipt {
  sequence += 1;
  return {
    userId: `602c83bf-e090-4c90-9f7e-${sequence.toString(16).padStart(12, '0')}`,
    accountCreated: true,
    provider,
    createdAt: '2026-10-10T00:00:00.000Z',
  };
}
function resolveOwner(creation: AccountCreationReceipt) {
  commitVerifiedAuthResult({ userId: creation.userId, accountCreation: creation });
  analytics.distinctId = creation.userId;
  updateConsentState({ authSettled: true, accountResolved: true, accountId: creation.userId, sdkReady: true });
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  invalidateConsentAccount();
  grantAnalyticsForTest();
  analytics.capture.mockReset().mockReturnValue(true);
  analytics.setPersonProperties.mockClear();
  analytics.distinctId = 'anonymous';
  preferences.stored.clear();
  preferences.get.mockReset().mockImplementation(async (key: string) => preferences.stored.get(key) ?? null);
  preferences.set.mockReset().mockImplementation(async (key: string, stored: unknown) => {
    preferences.stored.set(key, stored);
  });
  preferences.remove.mockReset().mockImplementation(async (key: string) => {
    preferences.stored.delete(key);
  });
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('verified signup conversion', () => {
  it.each(['email', 'apple', 'google'] as const)(
    'captures one %s creation with stable UUID and original timestamp',
    async (provider) => {
      const creation = receipt(provider);
      resolveOwner(creation);
      publishSignupConversion(creation);
      publishSignupConversion(creation);
      await settle();
      publishSignupConversion(creation);
      expect(analytics.capture).toHaveBeenCalledOnce();
      expect(analytics.capture).toHaveBeenCalledWith('Signup Completed', expect.objectContaining({ provider }), {
        uuid: creation.userId,
        timestamp: new Date(creation.createdAt),
      });
      expect(preferences.stored.get(`signupConversion:${creation.userId}`)).toBe(creation.createdAt);
    },
  );

  it('does not count a returning login or linked account', async () => {
    const existing = { ...receipt('apple'), accountCreated: false };
    resolveOwner(existing);
    publishSignupConversion(existing);
    await settle();
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it('keeps the conversion pending until the SDK identifies its exact owner', async () => {
    const creation = receipt('apple');
    resolveOwner(creation);
    analytics.distinctId = 'anonymous';
    publishSignupConversion(creation);
    await settle();
    expect(analytics.capture).not.toHaveBeenCalled();
    analytics.distinctId = creation.userId;
    notifyAnalyticsIdentityChanged();
    expect(analytics.capture).toHaveBeenCalledOnce();
  });

  it('cancels a delayed persistence read across withdrawal and later Allow', async () => {
    const creation = receipt();
    resolveOwner(creation);
    let finishRead: (result: unknown) => void = () => {};
    preferences.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    publishSignupConversion(creation);
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
    grantAnalyticsForTest();
    resolveOwner(creation);
    finishRead(null);
    await settle();
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it('discards a queued conversion on account replacement', async () => {
    const creation = receipt();
    resolveOwner(creation);
    updateConsentState({ sdkReady: false });
    publishSignupConversion(creation);
    await settle();
    invalidateConsentAccount();
    resolveOwner(receipt('google'));
    notifyAnalyticsIdentityChanged();
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it.each(['denied-at-success', 'withdrawn-during-resolution'] as const)(
    'does not replay %s after Allow',
    async (scenario) => {
      const creation = receipt();
      if (scenario === 'denied-at-success') updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
      const lease = createSignupConsentLease();
      if (scenario === 'withdrawn-during-resolution')
        updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
      grantAnalyticsForTest();
      resolveOwner(creation);
      publishSignupConversion(creation, lease);
      lease.dispose();
      await settle();
      expect(analytics.capture).not.toHaveBeenCalled();
    },
  );

  it('honors persisted deduplication and does not mark a skipped capture delivered', async () => {
    const alreadyPublished = receipt();
    resolveOwner(alreadyPublished);
    preferences.stored.set(`signupConversion:${alreadyPublished.userId}`, alreadyPublished.createdAt);
    publishSignupConversion(alreadyPublished);
    await settle();
    expect(analytics.capture).not.toHaveBeenCalled();
    const unkeyed = receipt();
    resolveOwner(unkeyed);
    analytics.capture.mockReturnValue(false);
    publishSignupConversion(unkeyed);
    await settle();
    expect(preferences.stored.has(`signupConversion:${unkeyed.userId}`)).toBe(false);
  });

  it('retains published markers across ordinary sign-out and withdrawal', async () => {
    const creation = receipt();
    resolveOwner(creation);
    publishSignupConversion(creation);
    await settle();

    invalidateConsentAccount();
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });

    expect(preferences.stored.get(`signupConversion:${creation.userId}`)).toBe(creation.createdAt);
    expect(preferences.remove).not.toHaveBeenCalled();
  });

  it('removes only the deleted account marker and preserves other accounts and install ownership', async () => {
    const deletedAccount = receipt();
    const otherAccount = receipt();
    const installOwner = { ownerId: deletedAccount.userId, closed: true };
    preferences.stored.set(`signupConversion:${deletedAccount.userId}`, deletedAccount.createdAt);
    preferences.stored.set(`signupConversion:${otherAccount.userId}`, otherAccount.createdAt);
    preferences.stored.set('appleAdsAttributionV1', installOwner);

    await forgetSignupConversion(deletedAccount.userId);

    expect(preferences.remove).toHaveBeenCalledExactlyOnceWith(`signupConversion:${deletedAccount.userId}`);
    expect(preferences.stored.has(`signupConversion:${deletedAccount.userId}`)).toBe(false);
    expect(preferences.stored.get(`signupConversion:${otherAccount.userId}`)).toBe(otherAccount.createdAt);
    expect(preferences.stored.get('appleAdsAttributionV1')).toBe(installOwner);
  });

  it('waits for a pending marker write before deletion and prevents later resurrection', async () => {
    const creation = receipt();
    resolveOwner(creation);
    let finishWrite: () => void = () => {};
    preferences.set.mockImplementationOnce(
      (key: string, timestamp: string) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            preferences.stored.set(key, timestamp);
            resolve();
          };
        }),
    );
    publishSignupConversion(creation);
    await settle();
    expect(preferences.set).toHaveBeenCalledOnce();

    const cleanup = forgetSignupConversion(creation.userId);
    await settle();
    expect(preferences.remove).not.toHaveBeenCalled();
    finishWrite();
    await cleanup;
    publishSignupConversion(creation);
    notifyAnalyticsIdentityChanged();
    await settle();

    expect(preferences.stored.has(`signupConversion:${creation.userId}`)).toBe(false);
    expect(preferences.set).toHaveBeenCalledOnce();
    expect(analytics.capture).toHaveBeenCalledOnce();
  });

  it('suppresses a deleted account while its marker read is delayed', async () => {
    const creation = receipt();
    resolveOwner(creation);
    let finishRead: (result: unknown) => void = () => {};
    preferences.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    publishSignupConversion(creation);

    await forgetSignupConversion(creation.userId);
    finishRead(null);
    await settle();
    notifyAnalyticsIdentityChanged();

    expect(analytics.capture).not.toHaveBeenCalled();
    expect(preferences.set).not.toHaveBeenCalled();
    expect(preferences.stored.has(`signupConversion:${creation.userId}`)).toBe(false);
  });

  it('suppresses a deleted account while its verified conversion waits for SDK readiness', async () => {
    const creation = receipt();
    resolveOwner(creation);
    analytics.distinctId = 'anonymous';
    publishSignupConversion(creation);
    await settle();

    await forgetSignupConversion(creation.userId);
    analytics.distinctId = creation.userId;
    notifyAnalyticsIdentityChanged();
    publishSignupConversion(creation);
    await settle();

    expect(analytics.capture).not.toHaveBeenCalled();
    expect(preferences.set).not.toHaveBeenCalled();
    expect(preferences.stored.has(`signupConversion:${creation.userId}`)).toBe(false);
  });
});
