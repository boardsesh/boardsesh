import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsentSyncCoordinator, createRegionDefaultConsent } from '@boardsesh/consent';
import { grantAnalyticsForTest, grantedConsent } from '../../../test/consent-fixture';
import { getConsentSnapshot, invalidateConsentAccount, updateConsentState } from '../consent-state';
import { isAttributionAuthorityGranted, isAttributionPublicationGranted } from '../consent-state';
import {
  createAppleAdsAttributionController,
  type StoredAppleAdsAttribution,
} from '../apple-ads-attribution-controller';
import type { AppleAdsAttributionResult } from '@boardsesh/shared-schema/apple-ads-attribution';
import { createConsentBoundAnalyticsRunner } from '../consent-bound-analytics';
import {
  AUTH_CONVERSION_WAIT_MS,
  cancelAuthAnalyticsHandoffs,
  createAuthAnalyticsHandoff,
  getAttributionAuthHandoff,
  retainAuthAnalyticsIdentity,
  subscribeAuthAnalyticsHandoff,
} from '../auth-analytics-handoff';

const OWNER = 'verified-owner';
let credentialGeneration = 1;
function handoff() {
  const generation = credentialGeneration;
  return createAuthAnalyticsHandoff({
    credentialCurrent: () => generation === credentialGeneration,
    identity: { distinctId: 'anonymous', anonymousId: 'anonymous' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelAuthAnalyticsHandoffs();
  credentialGeneration = 1;
  grantAnalyticsForTest();
  updateConsentState({ regionConfirmed: true });
});
afterEach(() => {
  cancelAuthAnalyticsHandoffs();
  vi.useRealTimers();
});

describe('verified authentication analytics handoff', () => {
  it('waits through the real account-null transition without opening capture authority', async () => {
    const context = handoff();
    const signedInAt = context.signedInAt;
    invalidateConsentAccount();
    updateConsentState({ authSettled: true, accountId: OWNER, accountResolved: false });
    expect(context.bindAccount(OWNER)).toBe(true);
    const capture = vi.fn();
    const captureWhenReady = createConsentBoundAnalyticsRunner({ accountId: OWNER, handoff: context });
    captureWhenReady(capture);
    const coordinator = createConsentSyncCoordinator({
      initialRecord: grantedConsent,
      readAccountConsent: async () => null,
      writeAccountConsent: async (_accountId, input) => ({
        analytics: input.analytics,
        source: input.source,
        version: input.version,
        decidedAt: new Date().toISOString(),
      }),
      persistLocalConsent: () => {},
    });
    const unsubscribe = coordinator.subscribe(() =>
      updateConsentState({
        record: coordinator.getSnapshot().record,
        accountResolved: coordinator.getSnapshot().accountResolved && !coordinator.getSnapshot().syncing,
      }),
    );
    coordinator.setAccount(OWNER);
    await coordinator.sync();
    expect(getConsentSnapshot().record).toBeNull();
    expect(context.isCurrent()).toBe(true);
    expect(retainAuthAnalyticsIdentity('anonymous', 'anonymous')).toBe(true);
    expect(retainAuthAnalyticsIdentity('other-anonymous', 'other-anonymous')).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await coordinator.decide('granted', 'ios');
    updateConsentState({ settled: true, sdkReady: true });
    expect(capture).toHaveBeenCalledOnce();
    expect(context.signedInAt).toBe(signedInAt);
    unsubscribe();
  });

  it.each(['denied', 'kill', 'replacement-before-bind', 'replacement-after-bind', 'signout'] as const)(
    'permanently cancels on %s',
    (reason) => {
      const context = handoff();
      if (reason !== 'replacement-before-bind') {
        updateConsentState({ accountId: OWNER });
        context.bindAccount(OWNER);
      }
      if (reason === 'denied') updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
      if (reason === 'kill') updateConsentState({ killed: true });
      if (reason.startsWith('replacement')) credentialGeneration += 1;
      if (reason === 'signout') invalidateConsentAccount();
      expect(context.isCurrent()).toBe(false);
      grantAnalyticsForTest();
      expect(context.bindAccount(OWNER)).toBe(false);
      expect(context.isCurrent()).toBe(false);
    },
  );

  it('notifies SDK/attribution owners when a null hold expires without another state change', async () => {
    const context = handoff();
    updateConsentState({ accountId: OWNER });
    context.bindAccount(OWNER);
    updateConsentState({ record: null });
    const expired = vi.fn();
    const unsubscribe = subscribeAuthAnalyticsHandoff(expired);
    await vi.advanceTimersByTimeAsync(AUTH_CONVERSION_WAIT_MS);
    expect(expired).toHaveBeenCalledOnce();
    expect(context.isCurrent()).toBe(false);
    expect(getAttributionAuthHandoff()).toBeNull();
    expect(retainAuthAnalyticsIdentity('anonymous', 'anonymous')).toBe(false);
    unsubscribe();
  });

  it('keeps same-credential account revalidation and rejects a different account', () => {
    const context = handoff();
    updateConsentState({ accountId: OWNER });
    expect(context.bindAccount(OWNER)).toBe(true);
    updateConsentState({ accountResolved: false });
    updateConsentState({ accountResolved: true, sdkReady: true });
    expect(context.isCurrent()).toBe(true);
    updateConsentState({ accountId: 'other-owner' });
    expect(context.isCurrent()).toBe(false);
  });

  it('does not turn a previously unanswered choice into a conversion', () => {
    updateConsentState({ record: null });
    const context = handoff();
    grantAnalyticsForTest();
    expect(context.bindAccount(OWNER)).toBe(false);
  });

  it('requires original regional authority and never uses a default for Apple attribution', () => {
    updateConsentState({ record: createRegionDefaultConsent('ios'), regionConfirmed: false });
    const unconfirmed = handoff();
    updateConsentState({ regionConfirmed: true });
    expect(unconfirmed.isCurrent()).toBe(false);
    const confirmed = handoff();
    expect(confirmed.isCurrent()).toBe(true);
    expect(getAttributionAuthHandoff()).toBeNull();
  });

  it.each(['allow', 'denied', 'expired', 'replaced'] as const)(
    'handles %s during the real attribution handoff without repeating an install event',
    async (outcome) => {
      const context = handoff();
      let verifiedOwner: string | null = null;
      let distinctId = 'anonymous';
      let stored: StoredAppleAdsAttribution | null = null;
      const attributed: AppleAdsAttributionResult = {
        status: 'ATTRIBUTED',
        attribution: { orgId: '12', campaignId: '34', adGroupId: '56', conversionType: 'Download' },
        retryAfterSeconds: null,
        retryReason: null,
      };
      const publish = vi.fn<(record: StoredAppleAdsAttribution, distinctId: string, emitEvent: boolean) => boolean>(
        () => true,
      );
      const token = vi.fn(async () => ({ status: 'available' as const, token: 'memory-only-token' }));
      const controller = createAppleAdsAttributionController({
        snapshot: getConsentSnapshot,
        verifiedAccountId: () => verifiedOwner,
        authorityGranted: isAttributionAuthorityGranted,
        publicationGranted: isAttributionPublicationGranted,
        authHandoff: getAttributionAuthHandoff,
        identity: () => ({ distinctId, anonymousId: 'anonymous' }),
        read: async () => null,
        write: async (record) => {
          stored = structuredClone(record);
        },
        token,
        exchange: async () => attributed,
        publish,
        delay: async () => {},
        uuid: () => '27dba32e-a6fa-4b36-9d19-fec73ec43338',
        now: Date.now,
      });
      await controller.reconcile();
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]?.[2]).toBe(true);
      invalidateConsentAccount();
      verifiedOwner = OWNER;
      updateConsentState({ authSettled: true, accountId: OWNER, accountResolved: false });
      context.bindAccount(OWNER);
      const coordinator = createConsentSyncCoordinator({
        initialRecord: grantedConsent,
        readAccountConsent: async () => null,
        writeAccountConsent: async (_accountId, input) => ({
          analytics: input.analytics,
          source: input.source,
          version: input.version,
          decidedAt: new Date().toISOString(),
        }),
        persistLocalConsent: () => {},
      });
      const unsubscribe = coordinator.subscribe(() =>
        updateConsentState({
          record: coordinator.getSnapshot().record,
          accountResolved: coordinator.getSnapshot().accountResolved && !coordinator.getSnapshot().syncing,
        }),
      );
      coordinator.setAccount(OWNER);
      await coordinator.sync();
      await controller.reconcile();
      expect(stored).toMatchObject({ ownerId: OWNER, result: attributed, eventPublished: true, closed: false });
      expect(publish).toHaveBeenCalledOnce();
      if (outcome !== 'allow') {
        const reconciled = vi.fn(() => {
          void controller.reconcile();
        });
        const unsubscribeHandoff = subscribeAuthAnalyticsHandoff(reconciled);
        if (outcome === 'denied') updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
        else if (outcome === 'expired') await vi.advanceTimersByTimeAsync(AUTH_CONVERSION_WAIT_MS);
        else {
          credentialGeneration += 1;
          context.isCurrent();
        }
        await controller.reconcile();
        expect(reconciled).toHaveBeenCalledOnce();
        expect(stored).toMatchObject({ ownerId: OWNER, result: null, propertiesPublishedFor: null });
        expect(token).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledOnce();
        unsubscribeHandoff();
        unsubscribe();
        controller.dispose();
        return;
      }
      await coordinator.decide('granted', 'ios');
      distinctId = OWNER;
      updateConsentState({ settled: true, sdkReady: true });
      await controller.reconcile();
      expect(token).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]?.slice(1)).toEqual([OWNER, false]);
      expect(stored).toMatchObject({ ownerId: OWNER, propertiesPublishedFor: OWNER, eventPublished: true });
      unsubscribe();
      controller.dispose();
    },
  );
});
