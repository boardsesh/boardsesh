import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  token: vi.fn(),
  read: vi.fn<() => Promise<unknown>>(),
  write: vi.fn<(key: string, record: unknown) => Promise<void>>(),
  identity: vi.fn<() => { distinctId: string; anonymousId: string } | null>(),
  capture: vi.fn<(...args: unknown[]) => boolean>(),
  properties: vi.fn<(...args: unknown[]) => boolean>(),
  uuid: vi.fn(),
}));
vi.mock('../graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.uuid }));
vi.mock('../../../modules/apple-ads-attribution/src', () => ({ getAppleAdsAttributionToken: mocks.token }));
vi.mock('../analytics', () => ({
  capture: mocks.capture,
  getAnalyticsIdentity: mocks.identity,
  setPersonProperties: mocks.properties,
}));
vi.mock('../preference-store', () => ({ getPreference: mocks.read, setPreference: mocks.write }));
vi.mock('../privacy/privacy-cache', () => ({ invalidatePrivacySnapshots: vi.fn() }));
vi.mock('../keychain-namespace-migration', () => ({
  createOnceRunner: () => async () => {},
  deferredReconcileKeys: () => [],
  isMigrationComplete: () => true,
  migrateSecureKeysToV2: async () => [],
}));
vi.mock('../secure-store-io', () => ({
  SECURE_STORE_TOMBSTONE: 'deleted',
  readSecureValue: async () => null,
  writeSecureValue: async () => {},
  writeSecureValueToEitherNamespace: async () => {},
  deleteSecureValue: async () => {},
}));

import '../consent-auth-invalidation';
import { storeTokens } from '../auth-store';
import { getConsentSnapshot, invalidateConsentAccount, updateConsentState } from '../consent-state';
import { commitVerifiedAuthResult, getVerifiedAuthResult } from '../verified-auth-result';
import { createNativeAppleAdsAttributionController } from '../apple-ads-attribution';
import type { StoredAppleAdsAttribution } from '../apple-ads-attribution-controller';

const OWNER = 'e24bfa22-98e9-4a5f-84d8-9e805671a62a';
const OTHER = 'b912ad98-f0c2-48e4-bb45-c247970d0748';
const EVENT_UUID = '27dba32e-a6fa-4b36-9d19-fec73ec43338';
const response = {
  exchangeAppleAdsAttribution: {
    status: 'ATTRIBUTED',
    attribution: { orgId: '12', campaignId: '34', adGroupId: '56', conversionType: 'Download' },
    retryAfterSeconds: null,
    retryReason: null,
  },
};
let persisted: unknown;

function anonymousRecord(): StoredAppleAdsAttribution {
  return {
    version: 1,
    ownerId: null,
    eventUuid: EVENT_UUID,
    observedAt: '2026-10-10T00:00:00.000Z',
    result: null,
    eventPublished: false,
    propertiesPublishedFor: null,
    closed: false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  persisted = null;
  invalidateConsentAccount();
  updateConsentState({
    loaded: true,
    settled: true,
    killed: false,
    authSettled: true,
    accountResolved: true,
    accountId: OWNER,
    sdkReady: true,
    flagsResolved: true,
    record: { analytics: 'granted', version: 1, source: 'ios', decidedAt: '2026-10-10T00:00:00.000Z' },
  });
  mocks.read.mockImplementation(async () => persisted);
  mocks.write.mockImplementation(async (_key, record) => {
    persisted = structuredClone(record);
  });
  mocks.uuid.mockReturnValue(EVENT_UUID);
  mocks.token.mockResolvedValue({ status: 'available', token: 'test-token' });
  mocks.request.mockResolvedValue(response);
  mocks.identity.mockReturnValue({ distinctId: OWNER, anonymousId: 'anonymous' });
  mocks.capture.mockReturnValue(true);
  mocks.properties.mockReturnValue(true);
});

describe('Apple Ads restored-session owner verification', () => {
  it('attributes a resolved cold-start account without an interactive auth receipt', async () => {
    expect(getVerifiedAuthResult()).toBeNull();
    await createNativeAppleAdsAttributionController().reconcile();
    expect(persisted).toEqual(expect.objectContaining({ ownerId: OWNER, eventPublished: true }));
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it.each(['authSettled', 'accountResolved'] as const)(
    'does not seal a stale anonymous cache while %s is false',
    async (unresolvedField) => {
      persisted = anonymousRecord();
      updateConsentState({ [unresolvedField]: false });
      const controller = createNativeAppleAdsAttributionController();
      await controller.reconcile();
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.token).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();

      updateConsentState({ authSettled: true, accountResolved: true, accountId: OTHER, sdkReady: true });
      mocks.identity.mockReturnValue({ distinctId: OTHER, anonymousId: 'anonymous' });
      await controller.reconcile();
      expect(persisted).toEqual(expect.objectContaining({ ownerId: OTHER, eventPublished: true }));
      expect(mocks.capture).toHaveBeenCalledOnce();
    },
  );

  it('seals an interactively verified owner before account consent resolves', async () => {
    persisted = anonymousRecord();
    updateConsentState({ accountResolved: false });
    commitVerifiedAuthResult({ userId: OTHER });
    await createNativeAppleAdsAttributionController().reconcile();
    expect(persisted).toEqual(expect.objectContaining({ ownerId: OTHER, eventPublished: false }));
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it('cancels a restored-account exchange synchronously on real credential mutation', async () => {
    let resolveExchange!: (result: unknown) => void;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExchange = resolve;
        }),
    );
    const controller = createNativeAppleAdsAttributionController();
    const pending = controller.reconcile();
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    const exchangeRequest = mocks.request.mock.calls[0]?.[0] as { signal: AbortSignal };
    const credentials = storeTokens('new-owner-token', 'new-refresh-token', '2026-10-11T00:00:00.000Z');
    expect(getConsentSnapshot().accountId).toBeNull();
    expect(getConsentSnapshot().authSettled).toBe(false);
    void controller.reconcile();
    expect(exchangeRequest.signal.aborted).toBe(true);
    resolveExchange(response);
    await pending;
    await credentials;
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.properties).not.toHaveBeenCalled();
    expect(persisted).toEqual(expect.objectContaining({ ownerId: OWNER, result: null }));
  });
});
